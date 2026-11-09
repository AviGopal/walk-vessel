// SPDX-License-Identifier: MIT
import { DISCOVERY_URL, KEY } from "./config"
import { AUTH_SCHEME, RESOLVE } from "./routes"
import {
  CALL, FAILURE, HOP, PRODUCE, RECORD_WAIT, RECORD_WRITE, RUN, VESSEL_CAPABILITY, WAIT_FOR, WAIT_UNTIL,
} from "./shapes"

export type Row = { shape: string; id: string; seq: number; [k: string]: unknown }
export type Entry = { vesselId: string; endpoint: string; resolve_endpoint: string }
export type Capability = { id: string; vessels: Entry[] }
export type Inner = { shape: string; vessel_id: string; pointer: Record<string, unknown> }
export type Cand = {
  id: string
  kind: string
  capability_ref: string
  url: string
  pointer: Record<string, unknown>
  calls: Inner[]
  t: string
}
type Runner = (c: Cand, sel: Row) => Promise<void>

const STARTED = "started"
const ENDED = "ended"

export const urlOf = (e: Entry): string => new URL(e.resolve_endpoint, e.endpoint).href

type Answer = { ok: boolean; status: number; body: unknown; text: string }

const post = async (url: string, payload: object): Promise<Answer> => {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${AUTH_SCHEME} ${KEY}` },
    body: JSON.stringify(payload),
    timeout: false,
  }
  const r = await fetch(url, init)
  if (!r.ok) {
    return { ok: false, status: r.status, body: null, text: await r.text() }
  }
  return { ok: true, status: r.status, body: (await r.json()) as unknown, text: "" }
}

const ask = async (shape: string): Promise<Entry[]> => {
  const r = await post(new URL(RESOLVE, DISCOVERY_URL).href, { pointer: { type: VESSEL_CAPABILITY, shape } })
  if (!r.ok) {
    process.exit(1)
  }
  return (r.body as { content: { vessels: Entry[] } }).content.vessels
}

export const loopCall = async (shape: string, pointer: object): Promise<unknown> => {
  const [e] = await ask(shape)
  const r = await post(urlOf(e), { impulse: { pointer: { ...pointer, type: shape } } })
  if (!r.ok) {
    process.exit(1)
  }
  return r.body
}

export const writeRow = async (row: object): Promise<Row> =>
  (await loopCall(RECORD_WRITE, { row })) as Row

export const lookup = async (shape: string): Promise<Capability> => {
  const vessels = await ask(shape)
  const row = await writeRow({ shape: VESSEL_CAPABILITY, target: shape, answer: { shape, vessels }, input_refs: [] })
  return { id: row.id, vessels }
}

const once = async (
  sel: Row, kind: string, url: string, capRef: string, pointer: object, callId: string,
): Promise<{ ok: boolean; row?: Row }> => {
  const refs = [sel.id]
  await writeRow({
    shape: HOP, call_id: callId, phase: STARTED, kind, selection_ref: sel.id,
    endpoint: url, capability_ref: capRef, input_refs: refs,
  })
  try {
    const r = await post(url, { impulse: { pointer } })
    if (!r.ok) {
      await writeRow({
        shape: FAILURE, call_id: callId, selection_ref: sel.id, status: r.status, body: r.text, input_refs: refs,
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
  await once(sel, CALL, c.url, c.capability_ref, c.pointer, crypto.randomUUID())
}

const produceRunner: Runner = async (c, sel) => {
  const callId = crypto.randomUUID()
  const pointer = { ...c.pointer, input_refs: sel.pool_refs, selection_ref: sel.id, call_id: callId }
  await once(sel, PRODUCE, c.url, c.capability_ref, pointer, callId)
}

const waitForRunner: Runner = async (c, sel) => {
  const pointer = { ...c.pointer, type: RECORD_WAIT, after_seq: sel.posts_seq }
  await once(sel, WAIT_FOR, c.url, c.capability_ref, pointer, crypto.randomUUID())
}

const runRunner: Runner = async (c, sel) => {
  for (const inner of c.calls) {
    const cap = await lookup(inner.shape)
    const e = cap.vessels.find((v) => v.vesselId === inner.vessel_id)
    if (e === undefined) {
      await writeRow({
        shape: FAILURE, call_id: crypto.randomUUID(), selection_ref: sel.id, status: 404, body: inner.vessel_id,
        input_refs: [sel.id],
      })
      return
    }
    const res = await once(sel, RUN, urlOf(e), cap.id, { ...inner.pointer, type: inner.shape }, crypto.randomUUID())
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
