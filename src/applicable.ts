// SPDX-License-Identifier: MIT
import { type Cand, ENDED, type Inner, type Row, exists } from "./calls"
import {
  ACTIVITY_TEMPLATE, ARM, CHANNEL, DUE, FAILURE, HOP, OUTCOME, PRODUCE, CALL, REQUEST, REQUIRES, RUN, SELECTION, SHAPE_SCHEMA, WAIT_FOR,
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
// A schema's inputs and context entry is a shape, or {shape, where, ...} naming which rows of it the producer is shown
// (described-shape reads where). The walk reads only the shape: which hops are information is informs, below.
const shapeOf = (e: unknown): string => typeof e === "object" && e !== null ? String((e as { shape?: unknown }).shape) : String(e)
const informs = (r: Row): boolean => r.shape === HOP && r.phase === ENDED && (r.kind === CALL || r.kind === RUN)

const base = { pointer: {}, calls: [] as Inner[], t: "" }

/** A template not run because it calls shapes nothing serves or not yet allowed, or a request whose call is not yet
 * allowed (of: "request"): the loop records it (calls.ts recordSkipped). */
export type Skipped = { id: string; unserved: string[]; of?: "request" }

/** What a root's moves leave out that choices() must know across roots: a first deadline that has already passed. And
 * what records says of the root (awaits: false when no one awaits an answer on it), passed in. */
export type Seen = { overdue?: boolean; awaits?: boolean }

export const applicable = async (pool: Row[], skipped: Skipped[] = [], now = Date.now(), note: Seen = {}): Promise<Cand[]> => {
  const have = new Set(pool.map((r) => r.shape))
  // The owner's newest schema row for a target supersedes older ones (described reads the newest too), so a schema
  // written again offers its produce once, under the rules it has now. A row may name a variant: another way the owner
  // makes the same shape, from other inputs (a request from a detector's gap rather than from a person's ask). Each
  // variant is superseded only by a newer row of the same variant; a row naming none is the variant "".
  const variant = (r: Row): string => String(r.variant ?? "")
  const newest = new Map(pool.filter((r) => SCHEMAS.has(r.shape)).sort((a, b) => a.seq - b.seq).map((r) => [`${String(r.target)}|${variant(r)}`, r]))
  const schemas = [...newest.values()]
  const channels = pool.filter((r) => CHANNELS.has(r.shape))
  const ready = schemas.filter((s) => [s.inputs].flat().every((x) => have.has(shapeOf(x))))

  // A produce of T is not offered while its last try is fresher than everything the schema takes in (freshness, not
  // presence): an ungraded T row, or a refusal of that produce as not fitting the schema, made after the newest row of
  // the schema's input and context shapes. Asked again with nothing new, it can only say the same. What the producer was
  // shown of those rows (which it kept, left out or cut) is the producer's to say, in its own row; the walk asks only
  // whether something came since. "Takes in" leaves out the walk's own bookkeeping (its hops, failures and selections:
  // how the walk got here, not what the producer answers) and rows of T itself (answers, not inputs). A root is one ask,
  // so any T row in it is a try at it, whichever schema variant made it.
  // So a new answer or due re-offers an outcome, while a repeat answer or due for the same request waits for a grade.
  // Whether to produce T again once it is graded is left to selection, not decided here.
  const byId = new Map(pool.map((r) => [r.id, r]))
  // The owner's preconditions on calls: a shape some requires row names is called (on its own or in a template) only when
  // the root's latest row of the shape one of those rows needs has every field its where names equal. Several rows for
  // one shape are alternatives. Which shapes, and what they need, are the owner's rows: the walk names none.
  const reqs = pool.filter((r) => r.shape === REQUIRES && r.role === OWNER)
  // A requirement is met by the root's LATEST row of the shape it needs, so a later judgment revokes an earlier one. When
  // rows of that shape each speak for something different (one gap or another), the requires row names the field that
  // tells them apart (latest_by), and the latest row of each counts: any one meeting where meets it. The field is the
  // owner's to name; the walk knows none.
  // A where value may be bound to the call being asked for: {"x-pointer": "<field>"} is that call's pointer's field, so
  // one row can say "a row about the same thing this call is about" (the same path, say). A call whose pointer has no
  // such field does not meet it. The field is the owner's to name; the walk knows none.
  const ofCall = (v: unknown, pointer: Record<string, unknown> | undefined): unknown => {
    const field = typeof v === "object" && v !== null ? (v as { "x-pointer"?: unknown })["x-pointer"] : undefined
    return typeof field === "string" ? pointer?.[field] : v
  }
  const meets = (q: Row, pointer?: Record<string, unknown>): boolean => {
    const by = typeof q.latest_by === "string" ? q.latest_by : undefined
    const latest = new Map<string, Row>()
    for (const x of pool.filter((r) => r.shape === String(q.needs)).sort((a, b) => a.seq - b.seq)) latest.set(by ? JSON.stringify(x[by]) : "", x)
    return [...latest.values()].some((x) =>
      Object.entries((q.where ?? {}) as Record<string, unknown>).every(([k, v]) => {
        const want = ofCall(v, pointer)
        return want !== undefined && JSON.stringify(x[k]) === JSON.stringify(want)
      }))
  }
  // Rows may name a group: rows of one group are alternatives (any one met meets the group), and every group must be met.
  // A row naming none is in the one group every row was in before groups. The group is the owner's to name, as the
  // shapes are: the walk knows none.
  // What is said of an unmet group names what it needs and, when the owner's schemas make that shape from inputs not yet
  // in the root, those inputs (from the schema missing fewest): the next step toward meeting it, read from the owner's
  // rows, so a request told its call must wait is told what to ask for instead.
  const toward = (need: string): string => {
    const missing = schemas.filter((s) => String(s.target) === need)
      .map((s) => [s.inputs as string[]].flat().map(shapeOf).filter((x) => !have.has(x)))
      .sort((a, b) => a.length - b.length)[0]
    return missing !== undefined && missing.length > 0 ? `${need}; ${need} is made from ${missing.join(", ")}, not yet here` : need
  }
  const unmet = (shape: string, pointer?: Record<string, unknown>): string[] => {
    const groups = new Map<string, Row[]>()
    for (const q of reqs.filter((q) => String(q.for) === shape)) groups.set(String(q.group ?? ""), [...(groups.get(String(q.group ?? "")) ?? []), q])
    return [...groups.values()].filter((rs) => !rs.some((q) => meets(q, pointer)))
      .map((rs) => `${shape} (requires ${[...new Set(rs.map((q) => toward(String(q.needs))))].join(" or ")})`)
  }
  // A call whose failure records stamped as blaming the request (the vessel refused what was asked) also carries what
  // came back: the reason, often the fact the next try needs ("the closest real text is ..."). Like a call that ended, it
  // is new information for a schema that reads failures, and it settles the request that made the call: the same pointer
  // would get the same answer. Whom a failure blames is records' to say (one rule, which its fold debits by too); any
  // other failure leaves the request callable.
  // A request whose call the owner's preconditions do not yet allow is not called, and the walk says so: a failure row
  // naming the request and what its call requires (recordSkipped). That is new information for a schema that reads
  // failures, as a refusal is, so the request is produced again with the reason in view; otherwise nothing new would
  // come, and the walk, with no move, would wait for a row no one writes. The request itself stays callable: once the
  // precondition is met, its call is offered.
  const held = (r: Row): boolean => r.shape === FAILURE && r.role === WALK && r.request_ref !== undefined
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
  const seen = (s: Row) => {
    const shapes = new Set([s.inputs, s.context ?? []].flat().map(shapeOf))
    return (r: Row | undefined): boolean => r !== undefined && shapes.has(r.shape) && r.shape !== String(s.target) &&
      !(r.role === WALK && BOOKKEEPING.has(r.shape) && !informs(r) && !spoke(r) && !held(r))
  }
  const pending = (s: Row): boolean => {
    // A judge that changed judges again: when a gate's judgment (a shape some owner requires row needs) has a schema row
    // newer than the root's latest row of it, that judgment was made under the old words, so it is offered once more,
    // whatever it saw. The row it makes is newer than the schema: once per change of the schema. Nothing a gate does not
    // read is re-made this way: an answer is not sent twice, and a deadline is not moved.
    const judged = reqs.some((q) => String(q.needs) === String(s.target))
    const last = pool.filter((r) => r.shape === String(s.target)).sort((a, b) => a.seq - b.seq).at(-1)
    if (judged && last !== undefined && s.role === OWNER && s.seq > last.seq) return false
    const sees = seen(s)
    const taken = pool.filter(sees)
    const fresh = Math.max(-1, ...taken.map((r) => r.seq))
    // A deadline passing is information arriving too, with no new row: a seen row's `at`, now past, that fell after a try
    // was made makes that try stale (grading the lapse is the move then).
    const lapsedSince = (t: unknown): boolean => taken.some((r) => typeof r.at === "number" && r.at <= now && r.at > Date.parse(String(t)))
    // A produce the producer refused as not fitting the schema (its failure says refused: schema; nothing was written) is
    // a try too: asking again over nothing new mostly buys the same refusal. Any other failure stays retryable.
    // A try's clock is what the producer could have been shown: the newest row of the pool its selection was chosen over
    // (pool_refs, read before the selection row was written; a row landing in between is not in it). An answer comes
    // later still, so a row arriving after that pool was read was never seen. Without pool_refs the selection itself
    // times it; a target row whose selection is not in the pool (a person's, or one made elsewhere) is timed by itself.
    // A deadline is measured from the selection's t: the pool read carries no time of its own, so a deadline passing in
    // the moment between the read and the selection row is taken as known, which delays its lapse grade by one move.
    const clock = (sel: Row | undefined, row: Row): { seq: number; t: unknown } => {
      if (sel === undefined) return { seq: row.seq, t: row.t }
      const shown = [sel.pool_refs].flat().map((id) => byId.get(String(id))?.seq).filter((n): n is number => typeof n === "number")
      return { seq: shown.length > 0 ? Math.max(...shown) : sel.seq, t: sel.t }
    }
    const tries = [
      ...pool.filter((r) => r.shape === String(s.target) && !graded.has(r.id)).map((r) => clock(byId.get(String(r.selection_ref)), r)),
      ...pool.filter((r) => r.shape === FAILURE && r.refused === "schema").map((f) => byId.get(String(f.selection_ref)))
        .filter((sel): sel is Row => sel !== undefined && String(sel.a).startsWith(`${PRODUCE}/${String(s.target)}/`)).map((sel) => clock(sel, sel)),
    ]
    return tries.some((t) => t.seq >= fresh && !lapsedSince(t.t))
  }

  // A grade judges something: an answer (a described row of a shape the grade reads as context, other than a grade or a
  // deadline) or a deadline that has passed. A deadline still ahead is nothing to judge yet. Before either exists, a grade
  // is of the ask alone (records counts none such, and the person sees an ask graded before it was answered), so it is
  // not offered.
  const judgeable = (s: Row): boolean => String(s.target) !== OUTCOME ||
    pool.some((r) => r.role === DESCRIBED && r.shape !== OUTCOME && !DUES.has(r.shape) && [s.context ?? []].flat().map(shapeOf).includes(r.shape)) ||
    pool.some((r) => DUES.has(r.shape) && r.role === DESCRIBED && typeof r.at === "number" && r.at <= now)

  const produce = await Promise.all(ready.filter((s) => !pending(s) && judgeable(s)).map(async (s) => {
    const target = String(s.target)
    const served = await exists(target)
    const v = variant(s)
    return channels.filter(() => served).map((ch): Cand => ({
      ...base,
      id: [PRODUCE, target, ...(v ? [v] : []), ch.id].join("/"),
      kind: PRODUCE,
      pointer: { type: target, shape: target, via_ref: ch.id, ...(v ? { variant: v } : {}) },
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
    const gate = unmet(type, r.pointer as Record<string, unknown> | undefined)
    if (served && !answered.has(r.id) && gate.length > 0) skipped.push({ id: r.id, unserved: gate, of: "request" })
    return [r].filter(() => served && !answered.has(r.id) && gate.length === 0).map((): Cand => ({
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
    // each call of the template is held to its own pointer
    return [...shapes.filter((_, i) => !served[i]), ...channelless, ...new Set(calls.flatMap((c) => unmet(c.shape, c.pointer)))]
  }))
  templates.forEach((r, i) => { if (unserved[i].length > 0) skipped.push({ id: r.id, unserved: unserved[i] }) })
  // A template already run in this root, whose run did not fail, is not run again until a row of a shape it takes in
  // (its sig.in) comes after that run from someone other than the walk: over the same inputs it would make the same
  // thing again (a clone handed out again), and offering it beside a request the walk has just asked for lets it win the
  // draw over calling that request, round after round. The walk's own rows since (its next selection, a hop) are how it
  // got here, not new input, even for a template that takes in selections; a template that takes in only those is run
  // again in a root only when its run failed.
  const ran = (r: Row): boolean => {
    const last = pool.filter((x) => x.shape === SELECTION && x.a === [RUN, r.id].join("/")).sort((a, b) => a.seq - b.seq).at(-1)
    if (last === undefined) return false
    if (pool.some((x) => x.shape === FAILURE && x.role === WALK && String(x.selection_ref) === last.id && x.kind === undefined)) return false
    const takes = new Set((r.sig as { in: string[] }).in)
    return !pool.some((x) => x.seq > last.seq && takes.has(x.shape) && x.role !== WALK)
  }
  const run = templates
    .filter((_, i) => unserved[i].length === 0)
    .filter((r) => !ran(r))
    .map((r): Cand => ({ ...base, id: [RUN, r.id].join("/"), kind: RUN, calls: r.calls as Inner[] }))

  // When to wait follows the request's own deadlines (law 5). The walk's arm row is in the pool only when the walk is
  // idle (no open request): then it waits for the next row, unbounded, which is what idling is. While a request is open,
  // a wait must end by its deadline, if that is still ahead (records made each `at` from the due's own within_ms), and
  // records answers "nothing yet" then. A deadline already passed is not waited through: grading the lapse is the move. With no
  // deadline ahead there is nothing anyone will write to wait for, so waiting is not offered and the walk produces (a
  // due, among others) instead.
  // A root no one awaits an answer on (records says so: the walk's arm) is worked like idling: the walk may wait for the
  // next row, unbounded, rather than produce until something comes. A root someone awaits (a request, or a gap a
  // detector opened, which awaits the change its check passes on) is waited on only by its deadline, since an unbounded
  // wait there would hold every root until an unrelated row came. A records that does not say is read as before: idle
  // only on the walk's arm.
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
