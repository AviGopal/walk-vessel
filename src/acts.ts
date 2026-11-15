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
export type Acts = { root: string; acts: Act[]; not_called: string[]; note: string }

// Plans are not acts: a template's calls are what a run would do, never what was done.
const NOTE = "Only the calls listed in acts happened on this request. A template (activity_template) is a plan for the " +
  "request that wrote it: its calls are not acts on this one. A tool in not_called was never called here."

const pick = (r: Row | undefined): Partial<Act> => {
  if (r === undefined) return {}
  const s = (k: string): string | undefined => typeof r[k] === "string" && r[k] !== "" ? String(r[k]) : undefined
  return { ...(s("path") ? { path: s("path") } : {}), ...(s("repo") ? { repo: s("repo") } : {}), ...(s("sha") ?? s("commit") ? { sha: s("sha") ?? s("commit") } : {}) }
}

// The acts on `root`, from its pool. Which tools are acts is the owner's word: the tools its requires rows gate on a
// wanted change (the same reading as records' promise checks), never a list here.
export const actsOf = (pool: Row[], root: string): Acts => {
  const tools = [...new Set(pool.filter((r) => r.shape === REQUIRES && r.role === OWNER && r.needs === "change_wanted" && r.retired !== true)
    .map((r) => String(r.for)))].sort()
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
  return { root, acts, not_called: tools.filter((t) => !called.has(t)), note: NOTE }
}

// The fact row to hand a produce on `root`: the latest one the walk wrote for it, when it still says the same; else a
// new one. The write is only on change, so a request shows one row per state of its acts.
export const actsFactRow = async (pool: Row[], root: string, write: (row: object) => Promise<Row>): Promise<string | undefined> => {
  const now = actsOf(pool, root)
  const last = pool.filter((r) => r.shape === REQUEST_ACTS && r.role === WALK && String(r.root) === root).sort((a, b) => a.seq - b.seq).at(-1)
  const same = last !== undefined && JSON.stringify({ acts: last.acts, not_called: last.not_called, note: last.note }) ===
    JSON.stringify({ acts: now.acts, not_called: now.not_called, note: now.note })
  if (same) return last.id
  const r = await write({ shape: REQUEST_ACTS, ...now, input_refs: [root] }).catch(() => undefined)
  return typeof r?.id === "string" ? r.id : undefined
}
