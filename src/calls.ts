// SPDX-License-Identifier: MIT
import type { Skipped } from "./applicable"
import { DISCOVERY_URL, KEY, VESSEL_ID } from "./config"
import { AUTH_SCHEME, RESOLVE } from "./routes"
import {
  CALL, FAILURE, HOP, PRODUCE, RECORD_WAIT, RECORD_WRITE, RUN, VESSEL_CAPABILITY, WAIT_FOR, WALK,
} from "./shapes"

export type Row = { shape: string; id: string; seq: number; [k: string]: unknown }
export type Inner = { shape: string; pointer: Record<string, unknown> }
export type Cand = {
  id: string
  kind: string
  pointer: Record<string, unknown>
  calls: Inner[]
  t: string
  /** For a call: the request row it answers, recorded on the selection so a request is called until a call ends OK. */
  from?: string
}
type Runner = (c: Cand, sel: Row) => Promise<void>

const STARTED = "started"
export const ENDED = "ended"

type Answer = { ok: boolean; status: number; body: unknown; text: string }

const resolve = async (pointer: object): Promise<Answer> => {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${AUTH_SCHEME} ${KEY}` },
    body: JSON.stringify({ pointer }),
    timeout: false,
  }
  const r = await fetch(new URL(RESOLVE, DISCOVERY_URL).href, init)
  if (!r.ok) {
    return { ok: false, status: r.status, body: null, text: await r.text() }
  }
  return { ok: true, status: r.status, body: (await r.json()) as unknown, text: "" }
}

export const loopCall = async (shape: string, pointer: object): Promise<unknown> => {
  const r = await resolve({ ...pointer, type: shape })
  if (!r.ok) {
    console.error(`${shape} answered ${r.status}: ${r.text}`)
    process.exit(1)
  }
  return r.body
}

export const writeRow = async (row: object): Promise<Row> =>
  (await loopCall(RECORD_WRITE, { row, writer: VESSEL_ID, role: WALK })) as Row

export const exists = async (shape: string): Promise<boolean> => {
  const cap = (await loopCall(VESSEL_CAPABILITY, { shape })) as { content: { vessels: unknown[] } }
  return cap.content.vessels.length > 0
}

// A tool's answer that names its own shape (git_diff answers shape gitDiff) is recorded as a row of that shape, so a
// producer can take it as an input: the walk stays the one recorder of what happened. Only when the shape is served by a
// vessel that also serves the shape called, so a tool can name its own output but cannot mint a request, an answer or an
// outcome, which other vessels serve. (Named debt: discovery does not say which of those vessels answered this call.)
// Never copied: a stored row's own stamps, and r and refused, so a recorded answer can never read as a grade or a refusal.
const OWN_FIELDS = new Set(["id", "seq", "t", "writer", "role", "shape", "r", "refused"])
const servers = async (shape: string): Promise<Set<string> | null> => {
  const r = await resolve({ type: VESSEL_CAPABILITY, shape })
  const vessels = (r.body as { content?: { vessels?: Array<{ vesselId?: unknown }> } } | null)?.content?.vessels
  return r.ok && Array.isArray(vessels) ? new Set(vessels.map((v) => String(v.vesselId))) : null
}
const recordAnswer = async (sel: Row, called: string, body: Record<string, unknown>, callId: string): Promise<void> => {
  const shape = body.shape
  if (typeof shape !== "string" || shape === called) return
  // An answer that is itself a stored row (a records read or wait answering one) is a row already, not a tool's answer.
  if ("seq" in body || "writer" in body) return
  const [mine, its] = await Promise.all([servers(called), servers(shape)])
  if (!mine || !its || ![...its].some((v) => mine.has(v))) return
  const fields = Object.fromEntries(Object.entries(body).filter(([k]) => !OWN_FIELDS.has(k)))
  // An answer too big to read whole is not made a row: every prompt that took it as an input would carry it. The skip is
  // a failure row, so a landing that waits for that row is not left waiting on silence.
  const bytes = JSON.stringify(fields).length
  if (bytes > RECORDED_MAX) {
    await writeRow({ shape: FAILURE, kind: "too_big", call_id: callId, selection_ref: sel.id, unrecorded: shape, bytes, input_refs: [sel.id] })
    return
  }
  // It cites the request it was made for (the selection's root): what a reader needs to tie it to that request, without
  // the selection's whole pool, which grows with the request and would make the row too big to read whole.
  const cites = typeof sel.root === "string" ? [sel.root] : [sel.pool_refs].flat().map(String)
  await writeRow({ ...fields, shape, selection_ref: sel.id, call_id: callId, input_refs: cites })
}

// What the walk keeps of a call's answer. A hop is shown to producers as context, so a tool's whole stdout (a 237 KB
// untracked listing, recorded on every call) would ride along in every prompt after it. Past the bound the hop keeps a
// marked start of the answer, and says how big it was. A recorded answer row may be bigger (a gitDiff is capped at
// 64 KiB where it is made), but not unbounded.
const HOP_OUTPUT_MAX = 16 * 1024
// The same bound described-shape shows an input row whole by: a gitDiff capped at 64 KiB of text, JSON-escaped.
const RECORDED_MAX = 96 * 1024
const bounded = (value: unknown, max: number): unknown => {
  const whole = JSON.stringify(value ?? null)
  return whole.length <= max ? value : { cut: true, bytes: whole.length, start: whole.slice(0, max) }
}

const once = async (sel: Row, kind: string, pointer: Record<string, unknown>, callId: string): Promise<{ ok: boolean; row?: Row }> => {
  const refs = [sel.id]
  await writeRow({
    shape: HOP, call_id: callId, phase: STARTED, kind, selection_ref: sel.id, pointer_type: String(pointer.type), input_refs: refs,
    // A wait's bound, when it has one, so how long the walk agreed to wait is in the row, not only in the request.
    ...(pointer.until !== undefined ? { until: pointer.until } : {}),
  })
  try {
    const r = await resolve(pointer)
    // A 200 can carry a failure: an error at the top level, or under content, the envelope a forwarded call comes back
    // in (a federation refusal arrives as {content: {error: "unauthorized", ...}, metadata}). That is a failure, not a
    // call that ended, so the request stays callable and the row says why.
    const body = (typeof r.body === "object" && r.body !== null ? r.body : {}) as { error?: unknown; content?: { error?: unknown } }
    const said = r.ok && Boolean(body.error || (typeof body.content === "object" && body.content !== null && body.content.error))
    if (!r.ok || said) {
      // A producer may say what kind of refusal this was (described-shape marks one by the schema); kept as a field so a
      // reader does not have to guess from the status.
      const refused = ((): unknown => { try { return (JSON.parse(r.text) as { failure?: { refused?: unknown } }).failure?.refused } catch { return undefined } })()
      await writeRow({
        shape: FAILURE, call_id: callId, selection_ref: sel.id, status: r.status,
        body: r.ok ? JSON.stringify(r.body).slice(0, 1000) : r.text, input_refs: refs,
        ...(typeof refused === "string" ? { refused } : {}),
      })
      return { ok: false }
    }
    await writeRow({ shape: HOP, call_id: callId, phase: ENDED, kind, selection_ref: sel.id, output: bounded(r.body, HOP_OUTPUT_MAX), input_refs: refs })
    if (kind === CALL || kind === RUN) await recordAnswer(sel, String(pointer.type), body as Record<string, unknown>, callId)
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      row: await writeRow({ shape: FAILURE, call_id: callId, selection_ref: sel.id, status: 0, body: String(e), input_refs: refs }),
    }
  }
}

const callRunner: Runner = async (c, sel) => {
  await once(sel, CALL, c.pointer, crypto.randomUUID())
}

const produceRunner: Runner = async (c, sel) => {
  const callId = crypto.randomUUID()
  const pointer = { ...c.pointer, input_refs: sel.pool_refs, selection_ref: sel.id, call_id: callId }
  await once(sel, PRODUCE, pointer, callId)
}

const waitForRunner: Runner = async (c, sel) => {
  const pointer = { ...c.pointer, type: RECORD_WAIT, after_seq: sel.posts_seq }
  await once(sel, WAIT_FOR, pointer, crypto.randomUUID())
}

const runRunner: Runner = async (c, sel) => {
  for (const inner of c.calls) {
    const callId = crypto.randomUUID()
    const pointer = { ...inner.pointer, type: inner.shape, input_refs: sel.pool_refs, selection_ref: sel.id, call_id: callId }
    const res = await once(sel, RUN, pointer, callId)
    if (!res.ok) {
      return
    }
  }
}

const RUNNERS = new Map<string, Runner>([
  [CALL, callRunner],
  [PRODUCE, produceRunner],
  [WAIT_FOR, waitForRunner],
  [RUN, runRunner],
])

// A template not run because a shape it calls is unserved leaves a failure row naming those shapes, once per template
// in the episode (a row already naming it in the pool is enough), so the class is visible rather than a silent skip.
// kind "skip" says no call was made: the row has no call_id and no status, which belong to calls discovery answered.
// The selection only carries it, so it stays in the episode's pool; it is not what that selection chose.
export const recordSkipped = async (pool: Row[], skipped: Skipped[], sel: Row): Promise<void> => {
  const seen = new Set(pool.filter((r) => r.shape === FAILURE).map((r) => String(r.template_ref)))
  for (const t of skipped.filter((x) => !seen.has(x.id))) {
    await writeRow({
      shape: FAILURE, kind: "skip", selection_ref: sel.id, template_ref: t.id, unserved: t.unserved,
      body: `template ${t.id} calls shapes nothing serves: ${t.unserved.join(", ")}`, input_refs: [sel.id, t.id],
    })
  }
}

export const execute = async (c: Cand, sel: Row): Promise<void> => {
  // A candidate of a kind the walk has no runner for never reaches another vessel, so its failure is the walk's own,
  // marked as such (kind unrunnable), not a callee's answer.
  if (!RUNNERS.has(c.kind)) {
    await writeRow({
      shape: FAILURE, kind: "unrunnable", call_id: crypto.randomUUID(), selection_ref: sel.id, status: 400, body: c.kind, input_refs: [sel.id],
    })
    return
  }
  const runner = RUNNERS.get(c.kind) as Runner
  await runner(c, sel)
}
