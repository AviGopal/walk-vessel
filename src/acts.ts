// SPDX-License-Identifier: MIT
// What this request has already done: its acts, as a fact its producers are shown (a request_acts row). A producer
// that cannot see its own finished edit asks for the edit again instead of the next step (eec55cfc typechecked its
// edit, then asked for the same edit, blind), and one shown a plan's steps reads them as done (an answer said "landed"
// on a request with no landing). The fact states only what happened here; what to do next is the producer's to infer.
// It is a memo of the request's own rows: the same rows always give the same fact, and nothing else goes in it.
import { ENDED, type Row, STARTED } from "./calls"
import { FAILURE, HOP, OWNER, REQUIRES, SELECTION, WALK } from "./shapes"

export const REQUEST_ACTS = "request_acts"

export type Act = { tool: string; at_seq: number; ok: boolean; status?: number; path?: string; repo?: string; sha?: string }
// Facts only: what the row means (and that a template is a plan, never an act) is said once, in the walk's registered
// description of request_acts (written.ts), not on every row.
export type Acts = { root: string; acts: Act[]; not_called: string[] }

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
  return { root, acts, not_called: tools.filter((t) => !called.has(t)) }
}

// The fact row to hand a produce on `root`: the latest one the walk wrote for it, when it still says the same; else a
// new one. The write is only on change, so a request shows one row per state of its acts.
export const actsFactRow = async (pool: Row[], root: string, write: (row: object) => Promise<Row>): Promise<string | undefined> => {
  const now = actsOf(pool, root)
  const last = pool.filter((r) => r.shape === REQUEST_ACTS && r.role === WALK && String(r.root) === root).sort((a, b) => a.seq - b.seq).at(-1)
  const same = last !== undefined && JSON.stringify({ acts: last.acts, not_called: last.not_called }) ===
    JSON.stringify({ acts: now.acts, not_called: now.not_called })
  if (same) return last.id
  // A write that fails leaves the produce without the fact; said in the journal, so a missing fact is seen, and tried
  // again at the next produce.
  const r = await write({ shape: REQUEST_ACTS, ...now, input_refs: [root] }).catch((e: unknown) => {
    console.error(`[walk] request_acts for ${root} not written (${String(e)}); the produce runs without it`)
    return undefined
  })
  return typeof r?.id === "string" ? r.id : undefined
}
