// SPDX-License-Identifier: MIT
import { type Cand, ENDED, type Inner, type Row, exists } from "./calls"
import {
  ACTIVITY_TEMPLATE, ARM, CHANNEL, DUE, FAILURE, HOP, OUTCOME, PRODUCE, CALL, REQUEST, RUN, SELECTION, SHAPE_SCHEMA, WAIT_FOR,
  DESCRIBED, OWNER, PERSON, WALK,
} from "./shapes"

const SCHEMAS = new Set([SHAPE_SCHEMA])
const CHANNELS = new Set([CHANNEL])
const REQUESTS = new Set([REQUEST])
const TEMPLATES = new Set([ACTIVITY_TEMPLATE])
const DUES = new Set([DUE])
// How the walk got here, not what a producer answers: its own records of choices and calls. A tool's answer the walk
// recorded as a row of its own shape (calls.ts) is not bookkeeping: a producer may take it as an input.
const BOOKKEEPING = new Set([SELECTION, HOP, FAILURE])
// Except one kind of hop: a call (or a template's call) that ENDED carries what came back, the result the next step is
// reasoned from. For a schema that reads hops (a request's context), a new one is new information, so the produce is
// offered again over it: ask, call, see the result, ask the next step. A started hop, a wait, a produce and a failure
// carry no result to reason from, and stay bookkeeping.
const informs = (r: Row): boolean => r.shape === HOP && r.phase === ENDED && (r.kind === CALL || r.kind === RUN)

const base = { pointer: {}, calls: [] as Inner[], t: "" }

/** A template not run because it calls shapes nothing serves: the loop records it (calls.ts recordSkipped). */
export type Skipped = { id: string; unserved: string[] }

/** What a root's moves leave out that choices() must know across roots: a first deadline that has already passed. And
 * what records says of the root (awaits: false when no one awaits an answer on it), passed in. */
export type Seen = { overdue?: boolean; awaits?: boolean }

export const applicable = async (pool: Row[], skipped: Skipped[] = [], now = Date.now(), note: Seen = {}): Promise<Cand[]> => {
  const have = new Set(pool.map((r) => r.shape))
  // The owner's newest schema row for a target supersedes older ones (described reads the newest too), so a schema
  // written again offers its produce once, under the rules it has now.
  const newest = new Map(pool.filter((r) => SCHEMAS.has(r.shape)).sort((a, b) => a.seq - b.seq).map((r) => [String(r.target), r]))
  const schemas = [...newest.values()]
  const channels = pool.filter((r) => CHANNELS.has(r.shape))
  const ready = schemas.filter((s) => (s.inputs as string[]).every((x) => have.has(x)))

  // A produce of T is not offered while the pool holds a T row that saw exactly what this produce would see and that no
  // outcome has graded yet: an ungraded duplicate cannot be useful, because the first one's grade has not come. "What it
  // sees" is every pool row of the schema's inputs and context shapes except the walk's own bookkeeping (its hops,
  // failures and selections), since those are how the walk got here, not what the producer answers.
  // So a new answer or due re-offers an outcome, while a repeat answer or due for the same request waits for a grade.
  // Whether to produce T again once it is graded is left to selection, not decided here.
  const byId = new Map(pool.map((r) => [r.id, r]))
  // A call whose failure records stamped as blaming the request (the vessel refused what was asked) also carries what
  // came back: the reason, often the fact the next try needs ("the closest real text is ..."). Like a call that ended, it
  // is new information for a schema that reads failures, and it settles the request that made the call: the same pointer
  // would get the same answer. Whom a failure blames is records' to say (one rule, which its fold debits by too); any
  // other failure leaves the request callable.
  const spoke = (r: Row): boolean => r.shape === FAILURE && r.role === WALK && r.blames === "request" &&
    [CALL, RUN].some((k) => String(byId.get(String(r.selection_ref))?.a ?? "").startsWith(`${k}/`))
  // A row counts as graded when an outcome judged it with something the row itself did not carry: a person's verdict, a
  // grade at r 0 (which asks for another try), or a grade whose inputs reach past the row and what the row saw. An r 1
  // made from only the row and its own inputs is the producer agreeing with itself (grade independence is information,
  // not who wrote it), so the row stays pending: the walk does not produce it again until a grade with something new comes.
  const refs = (r: Row | undefined, k: string): string[] => [r?.[k]].flat().filter((x) => x !== undefined).map(String)
  const counts = (o: Row, judged: string): boolean => {
    if (o.role === PERSON || Number(o.r) === 0) return true
    const own = new Set([judged, ...refs(byId.get(judged), "input_refs")])
    return refs(o, "input_refs").some((id) => !own.has(id))
  }
  const graded = new Set(pool.filter((r) => r.shape === OUTCOME)
    .flatMap((o) => [...refs(o, "input_refs"), ...refs(o, "evidence_refs")].filter((id) => counts(o, id))))
  const key = (ids: string[]): string => [...new Set(ids)].sort().join(",")
  const seen = (s: Row) => {
    const shapes = new Set([s.inputs, s.context ?? []].flat().map(String))
    return (r: Row | undefined): boolean =>
      r !== undefined && shapes.has(r.shape) && !(r.role === WALK && BOOKKEEPING.has(r.shape) && !informs(r) && !spoke(r))
  }
  // A produce the producer refused as not fitting the schema (its failure says refused: schema; nothing was written) is
  // pending the same way, for the same rows: asking again over the same inputs mostly buys the same refusal. Any other
  // failure (a channel or read that was down, a 422 passed through from a read or write) stays retryable.
  const refusedOver = (target: string, sees: (r: Row | undefined) => boolean): string[] => pool
    .filter((r) => r.shape === FAILURE && r.refused === "schema")
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

  // A grade judges something: an answer (a described row of a shape the grade reads as context, other than a grade or a
  // deadline) or a deadline that has passed. A deadline still ahead is nothing to judge yet. Before either exists, a grade
  // is of the ask alone (records counts none such, and the person sees an ask graded before it was answered), so it is
  // not offered.
  const judgeable = (s: Row): boolean => String(s.target) !== OUTCOME ||
    pool.some((r) => r.role === DESCRIBED && r.shape !== OUTCOME && !DUES.has(r.shape) && [s.context ?? []].flat().map(String).includes(r.shape)) ||
    pool.some((r) => DUES.has(r.shape) && r.role === DESCRIBED && typeof r.at === "number" && r.at <= now)

  const produce = await Promise.all(ready.filter((s) => !pending(s) && judgeable(s)).map(async (s) => {
    const target = String(s.target)
    const served = await exists(target)
    return channels.filter(() => served).map((ch): Cand => ({
      ...base,
      id: [PRODUCE, target, ch.id].join("/"),
      kind: PRODUCE,
      pointer: { type: target, shape: target, via_ref: ch.id },
    }))
  }))

  // A request is answered once a call made for it ENDED (a hop the call's selection wrote), or the vessel called refused
  // it (spoke, above): it is not offered again. A call that failed otherwise leaves it callable. A refusal by a 4xx also
  // counts as r 0 for the call's cell (records fold.ts moveFailures), so selection learns; an outage leaves the cell as
  // it was.
  const ended = new Set(pool.filter((r) => r.shape === HOP && r.phase === ENDED && r.kind === CALL).map((r) => String(r.selection_ref)))
  for (const f of pool.filter(spoke)) ended.add(String(f.selection_ref))
  const answered = new Set(pool.filter((r) => r.shape === SELECTION && r.from !== undefined && ended.has(r.id)).map((r) => String(r.from)))
  // A request row without a pointer to call is the producer saying no further call is needed (a decline). When the
  // newest request of the root is one, no call is offered for it, older ones included; one written later asks again.
  const requests = pool.filter((x) => REQUESTS.has(x.shape)).sort((a, b) => a.seq - b.seq)
  const callable = (r: Row): boolean => typeof (r.pointer as { type?: unknown } | undefined)?.type === "string"
  const declined = requests.length > 0 && !callable(requests[requests.length - 1])
  const latest = new Map<string, Row>()
  for (const r of declined ? [] : requests.filter(callable)) {
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
  // A call to a shape the owner's schemas produce (an answer, a due) goes through a channel: one that names none (a
  // template that replayed a stored answer row as its pointer) is refused every time, so it is not run either, and is
  // named the same way, as "<shape> (no channel)".
  const produced = new Set(schemas.map((s) => String(s.target)))
  const unserved = await Promise.all(templates.map(async (r) => {
    const calls = r.calls as Inner[]
    const shapes = [...new Set(calls.map((c) => c.shape))]
    const served = await Promise.all(shapes.map(exists))
    const channelless = [...new Set(calls.filter((c) => produced.has(c.shape) && !(c.pointer as { via_ref?: unknown } | undefined)?.via_ref)
      .map((c) => `${c.shape} (no channel)`))]
    return [...shapes.filter((_, i) => !served[i]), ...channelless]
  }))
  templates.forEach((r, i) => { if (unserved[i].length > 0) skipped.push({ id: r.id, unserved: unserved[i] }) })
  const run = templates
    .filter((_, i) => unserved[i].length === 0)
    .map((r): Cand => ({ ...base, id: [RUN, r.id].join("/"), kind: RUN, calls: r.calls as Inner[] }))

  // When to wait follows the request's own deadlines (law 5). The walk's arm row is in the pool only when the walk is
  // idle (no open request): then it waits for the next row, unbounded, which is what idling is. While a request is open,
  // a wait must end by its deadline, if that is still ahead (records made each `at` from the due's own within_ms), and
  // records answers "nothing yet" then. A deadline already passed is not waited through: grading the lapse is the move. With no
  // deadline ahead there is nothing anyone will write to wait for, so waiting is not offered and the walk produces (a
  // due, among others) instead.
  // A root no one awaits an answer on (records says so: the walk's arm, a gap a detector opened) is worked like idling:
  // the walk may wait for the next row, unbounded, rather than produce until something comes. A records that does not
  // say is read as before: idle only on the walk's arm.
  const idle = note.awaits === false || (note.awaits === undefined && pool.some((x) => x.shape === ARM))
  // The request's deadline is its FIRST deadline row, read as records reads it (lapsed()): written by the producer
  // (role described) with a within_ms records turned into at, citing the request. A later one does not move it, and a
  // due-shaped row anyone else wrote is not a deadline. Once it has passed, waiting is not offered; grading the lapse is
  // the move.
  const asks = new Set(pool.filter((x) => x.role === PERSON || x.role === OWNER).map((x) => x.id))
  const first = pool
    .filter((x) => DUES.has(x.shape) && x.role === DESCRIBED && typeof x.within_ms === "number" && typeof x.at === "number")
    .filter((x) => [x.input_refs].flat().some((id) => asks.has(String(id))))
    .sort((a, b) => a.seq - b.seq)[0]
  const ahead = first !== undefined && Number(first.at) > now ? [Number(first.at)] : []
  // A passed first deadline holds every wait back only while grading its lapse is on offer this turn. Once that grade is
  // pending (the walk graded what it saw and nothing new came), waiting is the walk's move again: otherwise a request
  // graded but never closed would keep the walk from ever waiting.
  if (first !== undefined && ahead.length === 0 && produce.flat().some((c) => c.pointer.type === OUTCOME)) note.overdue = true
  const bound = ahead.length > 0 ? { until: ahead[0] } : {}
  // One wait: for the next row a person or the owner writes. The walk runs one move at a time, so while it waits none of
  // its own produces or calls is in flight, and nothing else writes the shapes they make: a wait for one of those (an
  // answer, a due, a template) could only time out. records answers any wait with the next person or owner row.
  const waitFor = idle || ahead.length > 0
    ? [[] as string[]].map((shapes): Cand => ({
      ...base,
      id: [WAIT_FOR, ...shapes].join("/"),
      kind: WAIT_FOR,
      pointer: { shapes, ...(idle ? {} : bound) },
    }))
    : []

  return [...produce.flat(), ...call.flat(), ...run, ...waitFor]
}
