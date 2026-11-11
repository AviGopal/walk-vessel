// SPDX-License-Identifier: MIT
import { DISCOVERY_URL, KEY, VESSEL_ID } from "./config"
import { AUTH_SCHEME, RESOLVE } from "./routes"
import {
  CALL, FAILURE, HOP, PRODUCE, RECORD_WAIT, RECORD_WRITE, RUN, VESSEL_CAPABILITY, WAIT_FOR, WAIT_UNTIL, WALK,
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

const once = async (sel: Row, kind: string, pointer: Record<string, unknown>, callId: string): Promise<{ ok: boolean; row?: Row }> => {
  const refs = [sel.id]
  await writeRow({
    shape: HOP, call_id: callId, phase: STARTED, kind, selection_ref: sel.id, pointer_type: String(pointer.type), input_refs: refs,
  })
  try {
    const r = await resolve(pointer)
    // A 200 can carry a failure: an error at the top level, or under content, the envelope a forwarded call comes back
    // in (a federation refusal arrives as {content: {error: "unauthorized", ...}, metadata}). That is a failure, not a
    // call that ended, so the request stays callable and the row says why.
    const body = (typeof r.body === "object" && r.body !== null ? r.body : {}) as { error?: unknown; content?: { error?: unknown } }
    const said = r.ok && Boolean(body.error || (typeof body.content === "object" && body.content !== null && body.content.error))
    if (!r.ok || said) {
      await writeRow({
        shape: FAILURE, call_id: callId, selection_ref: sel.id, status: r.status,
        body: r.ok ? JSON.stringify(r.body).slice(0, 1000) : r.text, input_refs: refs,
      })
      return { ok: false }
    }
    await writeRow({ shape: HOP, call_id: callId, phase: ENDED, kind, selection_ref: sel.id, output: r.body, input_refs: refs })
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

const waitUntilRunner: Runner = async (c, sel) => {
  const callId = crypto.randomUUID()
  await writeRow({ shape: HOP, call_id: callId, phase: STARTED, kind: WAIT_UNTIL, selection_ref: sel.id, input_refs: [sel.id] })
  await Bun.sleep(new Date(c.t))
  await writeRow({ shape: HOP, call_id: callId, phase: ENDED, kind: WAIT_UNTIL, selection_ref: sel.id, input_refs: [sel.id] })
}

const RUNNERS = new Map<string, Runner>([
  [CALL, callRunner],
  [PRODUCE, produceRunner],
  [WAIT_FOR, waitForRunner],
  [RUN, runRunner],
  [WAIT_UNTIL, waitUntilRunner],
])

export const execute = async (c: Cand, sel: Row): Promise<void> => {
  if (!RUNNERS.has(c.kind)) {
    await writeRow({
      shape: FAILURE, call_id: crypto.randomUUID(), selection_ref: sel.id, status: 400, body: c.kind, input_refs: [sel.id],
    })
    return
  }
  const runner = RUNNERS.get(c.kind) as Runner
  await runner(c, sel)
}
