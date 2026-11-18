// SPDX-License-Identifier: MIT
// Binding a template's call to the run it is part of. A template is written once and run in many requests, so a value
// that belongs to one request (the clone's directory) is written as a placeholder: "{{ sig.in[0].cwd }}" names a field
// of the run's i-th input, "{{ calls.0.output.cwd }}" a field of an earlier call's answer in the same run. The binder is
// a path lookup and nothing more: no expression, filter or default. A placeholder that does not resolve is never sent
// as text; the caller is told which, and the call is not made. What the paths name, and which inputs a run has, is
// described to the template's writer in the template schema the owner serves, not here.
import type { Row } from "./calls"

// What a run can bind from: its inputs (each the request's row of a shape the template takes in, by sig.in order) and
// the answers of the calls it has made so far.
export type Scope = { sig: { in: Array<Row | undefined> }; calls: Array<{ output: unknown; call_id: string }> }
// Where each bound value came from: a row's id, or the call whose answer it is.
export type Source = { placeholder: string; from: string }
export type Bound = { value: unknown; sources: Source[]; unbound: string[] }

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g
const WHOLE = /^\{\{([^{}]*)\}\}$/
// Only a path into the run (sig.… or calls.…) is a placeholder. Any other "{{ … }}" is text and is sent as written: an
// edit may carry a Go or handlebars template ("{{ .Field }}"), and binding it would make a correct plan unrunnable.
const isPath = (inner: string): boolean => /^(sig|calls)[.[]/.test(inner.trim())

// "sig.in[0].cwd" and "calls.0.output.cwd" both read as a list of keys: sig, in, 0, cwd. Brackets and dots are the same
// step; spaces inside the braces are not part of the path.
const steps = (path: string): string[] => path.trim().replace(/\[(\d+)\]/g, ".$1").split(".").filter((s) => s.length > 0)

const lookup = (scope: Scope, path: string): { found: boolean; value?: unknown; from?: string } => {
  const keys = steps(path)
  if (keys.length < 3 || !((keys[0] === "sig" && keys[1] === "in") || keys[0] === "calls")) return { found: false }
  const head = keys[0] === "sig" ? scope.sig.in[Number(keys[2])] : scope.calls[Number(keys[1])]
  const rest = keys[0] === "sig" ? keys.slice(3) : keys.slice(2)
  if (head === undefined || !/^\d+$/.test(keys[0] === "sig" ? keys[2] : keys[1])) return { found: false }
  let cur: unknown = head
  for (const k of rest) {
    if (typeof cur !== "object" || cur === null || !Object.hasOwn(cur, k)) return { found: false }
    cur = (cur as Record<string, unknown>)[k]
  }
  if (cur === undefined || cur === null || rest.length === 0) return { found: false }
  const from = keys[0] === "sig" ? String((head as Row).id) : (head as { call_id: string }).call_id
  return { found: true, value: cur, from }
}

// Every placeholder in a value, as written (trimmed), in order.
export const placeholders = (value: unknown): string[] => {
  if (typeof value === "string") return [...value.matchAll(PLACEHOLDER)].map((m) => m[1].trim()).filter(isPath)
  if (Array.isArray(value)) return value.flatMap(placeholders)
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(placeholders)
  return []
}

export const bind = (value: unknown, scope: Scope): Bound => {
  const sources: Source[] = []
  const unbound: string[] = []
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (!v.includes("{{")) return v
      // A value that is one placeholder and nothing else takes the bound value as it is: an object stays an object.
      const whole = WHOLE.exec(v)
      if (whole && isPath(whole[1])) {
        const r = lookup(scope, whole[1])
        if (!r.found) { unbound.push(whole[1].trim()); return v }
        sources.push({ placeholder: whole[1].trim(), from: String(r.from) })
        return r.value
      }
      return v.replace(PLACEHOLDER, (m, path: string) => {
        if (!isPath(path)) return m
        const r = lookup(scope, path)
        if (!r.found) { unbound.push(path.trim()); return m }
        sources.push({ placeholder: path.trim(), from: String(r.from) })
        return typeof r.value === "string" ? r.value : JSON.stringify(r.value)
      })
    }
    if (Array.isArray(v)) return v.map(walk)
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  const out = walk(value)
  return { value: out, sources, unbound }
}

// A run's inputs: for each shape it takes in, the latest row of that shape the walk recorded as a tool's answer for this
// request (written by the walk, from a call, citing the request), the same rows a request's progress is read from. A row
// someone else wrote (a forwarded record_write, another request's clone) is never an input.
// When those rows are of more than one repo (a request that cloned two), the latest is not taken by default: an edit
// bound to the wrong clone is worse than no call. The input is the latest of the repo the template names (a repo field
// in one of its calls); a template that names none, or names two, has no input there, and its skip says so.
// roots: the request's own root first, then the earlier roots it continues (applicable.ts continued), newest first: a
// root with no row of a shape of its own takes the newest one it continues has (a gap opened again keeps its clone).
// fallback: by shape, the repo the root itself says the change belongs in, for each shape an owner clone_binding names
// (applicable.ts); used only where the template names no repo, so a template that names one binds as before.
export const inputsOf = (pool: Row[], roots: string | string[], sigIn: string[], walk: string, repo?: string, fallback?: Record<string, string>): Array<Row | undefined> => sigIn.map((shape) => {
  const of = (root: string): Row[] => pool
    .filter((r) => r.shape === shape && r.writer === walk && typeof r.call_id === "string" && [r.input_refs].flat().map(String).includes(root))
    .sort((a, b) => a.seq - b.seq)
  const rows = [roots].flat().map(of).find((rs) => rs.length > 0) ?? []
  const repos = new Set(rows.map((r) => r.repo).filter((x) => typeof x === "string"))
  if (repos.size <= 1) return rows.at(-1)
  const want = repo ?? fallback?.[shape]
  return want === undefined ? undefined : rows.filter((r) => r.repo === want).at(-1)
})

// The repo a template's calls name, when they name exactly one.
export const repoOf = (calls: Array<{ pointer: Record<string, unknown> }>): string | undefined => {
  const named = new Set(calls.map((c) => c.pointer?.repo).filter((x): x is string => typeof x === "string" && !x.includes("{{")))
  return named.size === 1 ? [...named][0] : undefined
}
