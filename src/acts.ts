// SPDX-License-Identifier: MIT
// What this request has already done: its acts, as a fact its producers are shown (a request_acts row). A producer
// that cannot see its own finished edit asks for the edit again instead of the next step (eec55cfc typechecked its
// edit, then asked for the same edit, blind), and one shown a plan's steps reads them as done (an answer said "landed"
// on a request with no landing). The fact states only what happened here; what to do next is the producer's to infer.
// It is a memo of the request's own rows: the same rows always give the same fact, and nothing else goes in it.
import { ENDED, type Row, STARTED } from "./calls"
import { FAILURE, HOP, OWNER, PERSON, REQUIRES, SELECTION, WALK } from "./shapes"

export const REQUEST_ACTS = "request_acts"

export type Act = { tool: string; at_seq: number; ok: boolean; status?: number; path?: string; repo?: string; sha?: string }
// Facts only: what the row means (and that a template is a plan, never an act) is said once, in the walk's registered
// description of request_acts (written.ts), not on every row.
// A step this request keeps repeating with the same result over the same inputs: a call failing the same way, or a
// produce judging the same thing the same way. n is how many times in a row, with nothing new in between or since.
export type Repeat = { call?: string; produce?: string; on: string; outcome: string; n: number; since_seq: number }
export type Acts = { root: string; acts: Act[]; not_called: string[]; repeats: Repeat[] }

const pick = (r: Row | undefined): Partial<Act> => {
  if (r === undefined) return {}
  const s = (k: string): string | undefined => typeof r[k] === "string" && r[k] !== "" ? String(r[k]) : undefined
  return { ...(s("path") ? { path: s("path") } : {}), ...(s("repo") ? { repo: s("repo") } : {}), ...(s("sha") ?? s("commit") ? { sha: s("sha") ?? s("commit") } : {}) }
}

// The acts on `root`, from its pool. Which tools are acts is the owner's word: the tools its requires rows gate on a
// wanted change (the same reading as records' promise checks), never a list here.
export const actsOf = (pool: Row[], root: string): Acts => {
  // The owner's requires rows read as the walk reads them (applicable.ts): the latest row per (for, needs), then dropped if
  // that latest says retired, so the two readers agree when the owner retires a gate.
  const latest = [...pool.filter((r) => r.shape === REQUIRES && r.role === OWNER).sort((a, b) => a.seq - b.seq)
    .reduce((m, r) => m.set(JSON.stringify([String(r.for), String(r.needs)]), r), new Map<string, Row>()).values()]
  const tools = [...new Set(latest.filter((r) => r.retired !== true && r.needs === "change_wanted").map((r) => String(r.for)))].sort()
  const mine = new Set(pool.filter((r) => r.shape === SELECTION && r.role === WALK && String(r.root) === root).map((r) => r.id))
  const started = pool.filter((r) => r.shape === HOP && r.role === WALK && r.phase === STARTED && mine.has(String(r.selection_ref))
    && tools.includes(String(r.pointer_type))).sort((a, b) => a.seq - b.seq)
  const acts = started.map((h): Act => {
    const id = String(h.call_id)
    const ended = pool.find((r) => r.shape === HOP && r.role === WALK && r.phase === ENDED && String(r.call_id) === id)
    const failed = pool.find((r) => r.shape === FAILURE && r.role === WALK && String(r.call_id) === id)
    const answer = pool.find((r) => r.role === WALK && String(r.call_id) === id && r.shape !== HOP && r.shape !== FAILURE)
    const ok = ended !== undefined && failed === undefined && (answer === undefined || answer.ok !== false)
    return { tool: String(h.pointer_type), at_seq: h.seq, ok, ...(failed && typeof failed.status === "number" ? { status: failed.status } : {}), ...pick(answer) }
  })
  const called = new Set(acts.map((a) => a.tool))
  return { root, acts, not_called: tools.filter((t) => !called.has(t)), repeats: repeatsOf(pool, mine) }
}

// The fact row to hand a produce on `root`: the latest one the walk wrote for it, when it still says the same; else a
// new one. The write is only on change, so a request shows one row per state of its acts.
// The row names the selection it was written for (selection_ref): records returns a walk row into a request's pool only
// through one of that request's selections, so without it the row never came back and a new one was written at every
// produce.
export const actsFactRow = async (pool: Row[], root: string, write: (row: object) => Promise<Row>, sel?: string): Promise<string | undefined> => {
  const now = actsOf(pool, root)
  const last = pool.filter((r) => r.shape === REQUEST_ACTS && r.role === WALK && String(r.root) === root).sort((a, b) => a.seq - b.seq).at(-1)
  const same = last !== undefined && JSON.stringify({ acts: last.acts, not_called: last.not_called, repeats: last.repeats ?? [] }) ===
    JSON.stringify({ acts: now.acts, not_called: now.not_called, repeats: now.repeats })
  if (same) return last.id
  // A write that fails leaves the produce without the fact; said in the journal, so a missing fact is seen, and tried
  // again at the next produce.
  const r = await write({ shape: REQUEST_ACTS, ...now, input_refs: [root], ...(sel !== undefined ? { selection_ref: sel } : {}) }).catch((e: unknown) => {
    console.error(`[walk] request_acts for ${root} not written (${String(e)}); the produce runs without it`)
    return undefined
  })
  return typeof r?.id === "string" ? r.id : undefined
}

// ── repeats ──
// What counts as new between two of them: a person's row on this request; an owner's row that bears on the step (a
// requires row for the tool called, or a schema for the tool, one of the shapes it takes in, or the shape produced:
// owner rows are shared by every request, so a seed run writing unrelated ones must not reset every repeat); or a tool's
// answer that says something new (its result differs from the last answer to the same call) of a shape the repeating
// run takes in (its template's sig.in). The walk's own reads, its bookkeeping and a producer's rows are not new: they
// change nothing the call is given. A started hop recorded before the binder carries no args: such calls of one tool
// share a key, and only their bodies tell them apart.
const OUTCOME_MAX = 300
const BOOK = new Set([SELECTION, HOP, FAILURE])
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => x !== null && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x)
const repeatsOf = (pool: Row[], mine: Set<string>): Repeat[] => {
  const byId = new Map(pool.map((r) => [r.id, r]))
  const started = new Map(pool.filter((r) => r.shape === HOP && r.role === WALK && r.phase === STARTED).map((h) => [String(h.call_id), h]))
  const callOf = (callId: string): string | undefined => {
    const h = started.get(callId)
    return h === undefined ? undefined : `${String(h.pointer_type)} ${stable(h.args ?? {})}`
  }
  // tool answers that said something new, by the call that made them
  const novel = new Map<string, Row>()
  {
    const last = new Map<string, string>()
    const OWN = new Set(["id", "seq", "t", "call_id", "selection_ref", "input_refs", "writer", "role", "shape"])
    for (const x of pool.filter((r) => r.role === WALK && !BOOK.has(r.shape) && typeof r.call_id === "string").sort((a, b) => a.seq - b.seq)) {
      const k = `${String(x.shape)}|${callOf(String(x.call_id)) ?? String(x.call_id)}`
      const said = stable(Object.fromEntries(Object.entries(x).filter(([f]) => !OWN.has(f))))
      if (last.get(k) !== said) novel.set(x.id, x)
      last.set(k, said)
    }
  }
  const takesOf = (sel: Row | undefined): Set<string> => {
    const a = String(sel?.a ?? "")
    const t = a.startsWith("run/") ? byId.get(a.slice(4)) : undefined
    return new Set([(t?.sig as { in?: unknown } | undefined)?.in].flat().map(String))
  }
  const bears = (x: Row, about: Set<string>): boolean => x.shape === REQUIRES ? about.has(String(x.for)) : about.has(String(x.target))
  const isNew = (x: Row, takes: Set<string>): boolean => x.role === PERSON || (x.role === OWNER && bears(x, takes))
    || (novel.has(x.id) && takes.has(String(x.shape)))
  const streak = <T extends Row>(rows: T[], same: (a: T, b: T) => boolean, takes: (r: T) => Set<string>): T[] => {
    const out: T[] = []
    for (let i = rows.length - 1; i >= 0; i--) {
      if (out.length > 0 && !same(rows[i], out[0])) break
      if (out.length > 0 && pool.some((x) => x.seq > rows[i].seq && x.seq < out[0].seq && isNew(x, takes(rows[i])))) break
      out.unshift(rows[i])
    }
    // and nothing new since the last of them
    const lastRow = out.at(-1)
    return lastRow !== undefined && pool.some((x) => x.seq > lastRow.seq && isNew(x, takes(lastRow))) ? [] : out
  }
  const out: Repeat[] = []
  // a call failing the same way: walk failures (no kind) of this request's selections, by the call that failed
  // A call cut by a stop (status 0: the walk was stopped before it ended) says nothing about the call: not a repeat.
  const fails = pool.filter((r) => r.shape === FAILURE && r.role === WALK && r.kind === undefined && r.status !== 0 && r.refused !== "schema" && mine.has(String(r.selection_ref)) && typeof r.call_id === "string")
    .sort((a, b) => a.seq - b.seq)
  const byCall = new Map<string, Row[]>()
  for (const f of fails) { const k = callOf(String(f.call_id)); if (k !== undefined) byCall.set(k, [...(byCall.get(k) ?? []), f]) }
  for (const [k, fs] of byCall) {
    const tool = k.split(" ")[0]
    const run = streak(fs, (a, b) => String(a.body ?? "") === String(b.body ?? ""), (f) => new Set([...takesOf(byId.get(String(f.selection_ref))), tool]))
    if (run.length >= 2) {
      const [tool, ...rest] = k.split(" ")
      out.push({ call: tool, on: rest.join(" ").slice(0, OUTCOME_MAX), outcome: String(run[0].body ?? "").slice(0, OUTCOME_MAX), n: run.length, since_seq: run[0].seq })
    }
  }
  // a produce refused by its schema over the same rows: the walk offers it again (no hold), and this says how often. Its
  // refusals are grouped by what it was handed (its selection's seen_key), so they are over the same rows by
  // construction; an owner row bearing on the produced shape (its schema) or a person's row between them ends the run.
  const refusals = pool.filter((r) => r.shape === FAILURE && r.role === WALK && r.refused === "schema" && mine.has(String(r.selection_ref)))
    .sort((a, b) => a.seq - b.seq)
  const byRows = new Map<string, Row[]>()
  for (const f of refusals) {
    const sel = byId.get(String(f.selection_ref))
    const target = String(sel?.a ?? "").split("/")[1] ?? ""
    const k = `${target}|${String(sel?.seen_key ?? "")}`
    byRows.set(k, [...(byRows.get(k) ?? []), f])
  }
  for (const [k, fs] of byRows) {
    const target = k.split("|")[0]
    const run = streak(fs, () => true, () => new Set([target]))
    if (run.length >= 2) out.push({ produce: target, on: "refused", outcome: String(run.at(-1)!.body ?? "").slice(0, OUTCOME_MAX), n: run.length, since_seq: run[0].seq })
  }
  // a produce judging the same thing the same way: land verdicts of this request, by the tree they judge
  const verdicts = pool.filter((r) => r.shape === "land_verdict" && mine.has(String(r.selection_ref)) && typeof r.tree === "string").sort((a, b) => a.seq - b.seq)
  const byTree = new Map<string, Row[]>()
  for (const v of verdicts) byTree.set(String(v.tree), [...(byTree.get(String(v.tree)) ?? []), v])
  for (const [tree, vs] of byTree) {
    const run = streak(vs, (a, b) => Number(a.r) === Number(b.r), () => new Set(["land_verdict"]))
    if (run.length >= 2) out.push({ produce: "land_verdict", on: `tree ${tree}`, outcome: `r ${Number(run[0].r)}`, n: run.length, since_seq: run[0].seq })
  }
  return out
}
