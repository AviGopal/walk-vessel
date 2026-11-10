// SPDX-License-Identifier: MIT
import { type Cand, type Inner, type Row, exists } from "./calls"
import {
  ACTIVITY_TEMPLATE, CHANNEL, DUE, PRODUCE, CALL, REQUEST, RUN, SHAPE_SCHEMA, WAIT_FOR, WAIT_UNTIL,
} from "./shapes"

const SCHEMAS = new Set([SHAPE_SCHEMA])
const CHANNELS = new Set([CHANNEL])
const REQUESTS = new Set([REQUEST])
const TEMPLATES = new Set([ACTIVITY_TEMPLATE])
const DUES = new Set([DUE])

const base = { pointer: {}, calls: [] as Inner[], t: "" }

export const applicable = async (pool: Row[]): Promise<Cand[]> => {
  const have = new Set(pool.map((r) => r.shape))
  const schemas = pool.filter((r) => SCHEMAS.has(r.shape))
  const channels = pool.filter((r) => CHANNELS.has(r.shape))
  const ready = schemas.filter((s) => (s.inputs as string[]).every((x) => have.has(x)))

  const produce = await Promise.all(ready.map(async (s) => {
    const target = String(s.target)
    const served = await exists(target)
    return channels.filter(() => served).map((ch): Cand => ({
      ...base,
      id: [PRODUCE, target, ch.id].join("/"),
      kind: PRODUCE,
      pointer: { type: target, shape: target, via_ref: ch.id },
    }))
  }))

  const latest = new Map<string, Row>()
  for (const r of pool.filter((x) => REQUESTS.has(x.shape))) {
    latest.set(String((r.pointer as { type: string }).type), r)
  }
  const call = await Promise.all([...latest.entries()].map(async ([type, r]) => {
    const served = await exists(type)
    return [r].filter(() => served).map((): Cand => ({
      ...base,
      id: [CALL, type].join("/"),
      kind: CALL,
      pointer: r.pointer as Record<string, unknown>,
    }))
  }))

  const run = pool
    .filter((r) => TEMPLATES.has(r.shape))
    .filter((r) => (r.sig as { in: string[] }).in.every((x) => have.has(x)))
    .map((r): Cand => ({ ...base, id: [RUN, r.id].join("/"), kind: RUN, calls: r.calls as Inner[] }))

  const targets = [...new Set(schemas.map((s) => String(s.target)))]
  const waitFor = [...targets.map((x) => [x]), []].map((shapes): Cand => ({
    ...base,
    id: [WAIT_FOR, ...shapes].join("/"),
    kind: WAIT_FOR,
    pointer: { shapes },
  }))

  const due = new Map<string, Row>()
  for (const r of pool.filter((x) => DUES.has(x.shape))) {
    due.set(WAIT_UNTIL, r)
  }
  const waitUntil = [...due.values()].map((r): Cand => ({ ...base, id: WAIT_UNTIL, kind: WAIT_UNTIL, t: String(r.at) }))

  return [...produce.flat(), ...call.flat(), ...run, ...waitFor, ...waitUntil]
}
