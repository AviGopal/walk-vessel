// SPDX-License-Identifier: MIT
import { type Cand, ENDED, type Inner, type Row, exists } from "./calls"
import {
  ACTIVITY_TEMPLATE, ARM, CHANNEL, DUE, FAILURE, HOP, OUTCOME, PRODUCE, CALL, REQUEST, RUN, SELECTION, SHAPE_SCHEMA, WAIT_FOR,
  WALK,
} from "./shapes"

const SCHEMAS = new Set([SHAPE_SCHEMA])
const CHANNELS = new Set([CHANNEL])
const REQUESTS = new Set([REQUEST])
const TEMPLATES = new Set([ACTIVITY_TEMPLATE])
const DUES = new Set([DUE])

const base = { pointer: {}, calls: [] as Inner[], t: "" }

/** A template not run because it calls shapes nothing serves: the loop records it (calls.ts recordSkipped). */
export type Skipped = { id: string; unserved: string[] }

export const applicable = async (pool: Row[], skipped: Skipped[] = []): Promise<Cand[]> => {
  const have = new Set(pool.map((r) => r.shape))
  // The owner's newest schema row for a target supersedes older ones (described reads the newest too), so a schema
  // written again offers its produce once, under the rules it has now.
  const newest = new Map(pool.filter((r) => SCHEMAS.has(r.shape)).sort((a, b) => a.seq - b.seq).map((r) => [String(r.target), r]))
  const schemas = [...newest.values()]
  const channels = pool.filter((r) => CHANNELS.has(r.shape))
  const ready = schemas.filter((s) => (s.inputs as string[]).every((x) => have.has(x)))

  // A produce of T is not offered while the pool holds a T row that saw exactly what this produce would see and that no
  // outcome has graded yet: an ungraded duplicate cannot be useful, because the first one's grade has not come. "What it
  // sees" is every pool row of the schema's inputs and context shapes except the walk's own bookkeeping (rows written
  // with role walk: hops, failures, selections), since those are how the walk got here, not what the producer answers.
  // So a new answer or due re-offers an outcome, while a repeat answer or due for the same request waits for a grade.
  // Whether to produce T again once it is graded is left to selection, not decided here.
  const byId = new Map(pool.map((r) => [r.id, r]))
  const graded = new Set(pool.filter((r) => r.shape === OUTCOME).flatMap((r) => [r.input_refs, r.evidence_refs].flat().map(String)))
  const key = (ids: string[]): string => [...new Set(ids)].sort().join(",")
  const seen = (s: Row) => {
    const shapes = new Set([s.inputs, s.context ?? []].flat().map(String))
    return (r: Row | undefined): boolean => r !== undefined && shapes.has(r.shape) && r.role !== WALK
  }
  // A produce the producer refused as not fitting the schema (422: nothing was written) is pending the same way, for the
  // same rows: asking again over the same inputs mostly buys the same refusal. A failure of any other status (a channel
  // or read that was down) stays retryable.
  const refusedOver = (target: string, sees: (r: Row | undefined) => boolean): string[] => pool
    .filter((r) => r.shape === FAILURE && Number(r.status) === 422)
    .map((f) => byId.get(String(f.selection_ref)))
    .filter((sel): sel is Row => sel !== undefined && String(sel.a).startsWith(`${PRODUCE}/${target}/`))
    .map((sel) => key([sel.pool_refs].flat().map(String).filter((id) => sees(byId.get(id)))))
  const pending = (s: Row): boolean => {
    const sees = seen(s)
    const now = key(pool.filter(sees).map((r) => r.id))
    return pool
      .filter((r) => r.shape === String(s.target))
      .filter((r) => !graded.has(r.id))
      .some((r) => key([r.input_refs].flat().map(String).filter((id) => sees(byId.get(id)))) === now) ||
      refusedOver(String(s.target), sees).includes(now)
  }

  const produce = await Promise.all(ready.filter((s) => !pending(s)).map(async (s) => {
    const target = String(s.target)
    const served = await exists(target)
    return channels.filter(() => served).map((ch): Cand => ({
      ...base,
      id: [PRODUCE, target, ch.id].join("/"),
      kind: PRODUCE,
      pointer: { type: target, shape: target, via_ref: ch.id },
    }))
  }))

  // A request is answered once a call made for it ENDED (a hop the call's selection wrote): it is not offered again.
  // A call that failed leaves it callable, and the call's cell learns from the failure.
  const ended = new Set(pool.filter((r) => r.shape === HOP && r.phase === ENDED && r.kind === CALL).map((r) => String(r.selection_ref)))
  const answered = new Set(pool.filter((r) => r.shape === SELECTION && r.from !== undefined && ended.has(r.id)).map((r) => String(r.from)))
  const latest = new Map<string, Row>()
  for (const r of pool.filter((x) => REQUESTS.has(x.shape))) {
    latest.set(String((r.pointer as { type: string }).type), r)
  }
  const call = await Promise.all([...latest.entries()].map(async ([type, r]) => {
    const served = await exists(type)
    return [r].filter(() => served && !answered.has(r.id)).map((): Cand => ({
      ...base,
      id: [CALL, type].join("/"),
      kind: CALL,
      pointer: r.pointer as Record<string, unknown>,
      from: r.id,
    }))
  }))

  // A template is run only when every shape it calls is served, as a call is: one naming a shape nothing serves (a
  // "hop", which is a record of a call, not a shape) would fail at its first step every time.
  const templates = pool.filter((r) => TEMPLATES.has(r.shape)).filter((r) => (r.sig as { in: string[] }).in.every((x) => have.has(x)))
  const unserved = await Promise.all(templates.map(async (r) => {
    const shapes = [...new Set((r.calls as Inner[]).map((c) => c.shape))]
    const served = await Promise.all(shapes.map(exists))
    return shapes.filter((_, i) => !served[i])
  }))
  templates.forEach((r, i) => { if (unserved[i].length > 0) skipped.push({ id: r.id, unserved: unserved[i] }) })
  const run = templates
    .filter((_, i) => unserved[i].length === 0)
    .map((r): Cand => ({ ...base, id: [RUN, r.id].join("/"), kind: RUN, calls: r.calls as Inner[] }))

  // When to wait follows the request's own deadlines (law 5). The walk's arm row is in the pool only when the walk is
  // idle (no open request): then it waits for the next row, unbounded, which is what idling is. While a request is open,
  // a wait must end by one of its deadlines still ahead (records made each `at` from the due's own within_ms), and records
  // answers "nothing yet" then. A deadline already passed is not waited through: grading the lapse is the move. With no
  // deadline ahead there is nothing anyone will write to wait for, so waiting is not offered and the walk produces (a
  // due, among others) instead.
  const idle = pool.some((x) => x.shape === ARM)
  const now = Date.now()
  const ahead = pool.filter((x) => DUES.has(x.shape)).map((x) => Number(x.at)).filter((at) => Number.isFinite(at) && at > now)
  const bound = ahead.length > 0 ? { until: Math.min(...ahead) } : {}
  const targets = [...new Set(schemas.map((s) => String(s.target)))]
  const waitFor = idle || ahead.length > 0
    ? [...targets.map((x) => [x]), []].map((shapes): Cand => ({
      ...base,
      id: [WAIT_FOR, ...shapes].join("/"),
      kind: WAIT_FOR,
      pointer: { shapes, ...(idle ? {} : bound) },
    }))
    : []

  return [...produce.flat(), ...call.flat(), ...run, ...waitFor]
}
