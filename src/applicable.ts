// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto"
import { type Scope, bind, inputsOf, placeholders, repoOf } from "./bind"
import { type Cand, ENDED, STARTED, type Inner, type Row, declaredInputs, exists } from "./calls"
import { callProblem, shownValue } from "./inputs"
import { VESSEL_ID } from "./config"
import {
  ACTIVITY_TEMPLATE, ARM, CHANNEL, CLONE_BINDING, DUE, FAILURE, HOP, NEWS_KEY, OUTCOME, PRODUCE, CALL, REQUEST, REQUIRES, RHYTHM, RUN, SELECTION, SHAPE_SCHEMA, STALL, WAIT_FOR,
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
// unbound: a template's placeholders this request cannot fill (the skip says them as unserved reasons too).
// against_refs: the rows a skip's reasons compared (the latest rows of a needed shape that did not meet a requirement), so
// a producer shown the skip can be shown them too (described fits a shown skip's rows ahead of the walk's hops).
export type Skipped = { id: string; unserved: string[]; of?: "request"; unbound?: string[]; against_refs?: string[] }

/** What a root's moves leave out that choices() must know across roots: a first deadline that has already passed. And
 * what records says of the root (awaits: false when no one awaits an answer on it), passed in. */
// shared: the ids of the rows every root is given (records' shared rows: the owner's configuration, earned templates),
// as against the root's own; what is shared is about no one root.
// root: the request the pool is for, which a template run binds its inputs from (bind.ts inputsOf).
// head: the store's latest seq as records last said it (the posterior's at_seq), which a rhythm counts rows against.
// gated (out): each call the owner's requires rows gate, with what it still needs here (see where it is set).
export type Seen = { overdue?: boolean; awaits?: boolean; shared?: ReadonlySet<string>; root?: string; head?: number; gated?: Record<string, string[]> }

export const applicable = async (pool: Row[], skipped: Skipped[] = [], now = Date.now(), note: Seen = {}, answers: Record<string, string> = {}): Promise<Cand[]> => {
  const have = new Set(pool.map((r) => r.shape))
  // The owner's newest schema row for a target supersedes older ones (described reads the newest too), so a schema
  // written again offers its produce once, under the rules it has now. A row may name a variant: another way the owner
  // makes the same shape, from other inputs (a request from a detector's gap rather than from a person's ask). Each
  // variant is superseded only by a newer row of the same variant; a row naming none is the variant "".
  const variant = (r: Row): string => String(r.variant ?? "")
  const newest = new Map(pool.filter((r) => SCHEMAS.has(r.shape)).sort((a, b) => a.seq - b.seq).map((r) => [`${String(r.target)}|${variant(r)}`, r]))
  const schemas = [...newest.values()]
  const channels = pool.filter((r) => CHANNELS.has(r.shape))

  // A produce of T is not offered while the pool holds a T row that saw exactly what this produce would see and that no
  // outcome has graded yet: an ungraded duplicate cannot be useful, because the first one's grade has not come. "What it
  // sees" is every pool row of the schema's inputs and context shapes except the walk's own bookkeeping (its hops,
  // failures and selections), since those are how the walk got here, not what the producer answers.
  // So a new answer or due re-offers an outcome, while a repeat answer or due for the same request waits for a grade.
  // Whether to produce T again once it is graded is left to selection, not decided here.
  const byId = new Map(pool.map((r) => [r.id, r]))
  // THE CLONE'S NEWEST TREE (x-latest). An owner value {"x-latest": {shapes, moves, same, field, continues}} is the field
  // of the newest row, among rows of those shapes the walk recorded from a tool's answer (role walk, with a call_id: only
  // such a row holds fields a callee wrote) on the request's clone (the same `same`, its cwd), that holds the field. A
  // newer row of a `moves` shape without it (the clone moved and did not say where) leaves it unknown; a row without it
  // that moves nothing (a plain diff) is passed over. Unknown meets nothing. The request's clone is the newest such
  // gitWorktree-like row citing the root, read the way templates bind it (inputsOf); a root with none continues the
  // newest earlier root of its shape with the same `continues` field (a gap the held-gap release opened again keeps its
  // gap_id), and inherits that root's clone. Every shape and field is the owner's; with no x-latest value in any owner
  // row, nothing here is read and the walk behaves as before.
  // WHICH ROWS FIND THE CLONE, APART FROM WHICH MOVE IT. An optional `at` names the shapes whose rows locate the request's
  // clone; with none (absent, or not a list), the `moves` shapes do, as before. A list naming no shape finds no clone, so
  // the value is unknown and nothing meets it: fail closed. A shape in `at` but not in `moves` finds the clone without
  // making its value unknown: a row that says where the clone is but not what it holds (a clone handed out before its
  // answers named a tree) is passed over, and the newest row that holds the field still gives it.
  type Latest = { shapes: string[]; moves: string[]; at?: string[]; same: string; field: string; continues?: string }
  const latestSpec = (v: unknown): Latest | undefined => {
    const s = typeof v === "object" && v !== null ? (v as { "x-latest"?: unknown })["x-latest"] : undefined
    if (typeof s !== "object" || s === null) return undefined
    const o = s as Record<string, unknown>
    const list = (x: unknown): string[] => Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : []
    if (typeof o.same !== "string" || typeof o.field !== "string" || list(o.shapes).length === 0) return undefined
    return { shapes: list(o.shapes), moves: list(o.moves), ...(Array.isArray(o.at) ? { at: list(o.at) } : {}), same: o.same, field: o.field,
      ...(typeof o.continues === "string" ? { continues: o.continues } : {}) }
  }
  const byTool = (r: Row): boolean => r.role === WALK && typeof r.call_id === "string"
  const cites = (r: Row, ids: string[]): boolean => [r.input_refs].flat().map(String).some((x) => ids.includes(x))
  // the roots whose rows this request may count as its own: itself, then (when the owner names how one root continues
  // another) the earlier roots it continues, newest first
  const continued = (field: string | undefined): string[] => {
    const root = note.root === undefined ? undefined : byId.get(note.root)
    if (root === undefined) return []
    if (field === undefined || root[field] === undefined) return [root.id]
    const earlier = pool.filter((r) => r.shape === root.shape && r.id !== root.id && r.seq < root.seq && JSON.stringify(r[field]) === JSON.stringify(root[field]))
      .sort((a, b) => b.seq - a.seq).map((r) => r.id)
    return [root.id, ...earlier]
  }
  const cloneOf = (spec: Latest): unknown => {
    for (const id of continued(spec.continues)) {
      const own = pool.filter((r) => (spec.at ?? spec.moves).includes(r.shape) && byTool(r) && r[spec.same] !== undefined && cites(r, [id])).sort((a, b) => a.seq - b.seq).at(-1)
      if (own !== undefined) return own[spec.same]
    }
    return undefined
  }
  const latestMemo = new Map<string, unknown>()
  const latestValue = (spec: Latest): unknown => {
    const key = JSON.stringify(spec)
    if (latestMemo.has(key)) return latestMemo.get(key)
    const at = cloneOf(spec)
    let value: unknown
    if (at !== undefined) {
      const rows = pool.filter((r) => spec.shapes.includes(r.shape) && byTool(r) && JSON.stringify(r[spec.same]) === JSON.stringify(at)).sort((a, b) => b.seq - a.seq)
      for (const r of rows) {
        if (r[spec.field] !== undefined) { value = r[spec.field]; break }
        if (spec.moves.includes(r.shape)) break
      }
    }
    latestMemo.set(key, value)
    return value
  }
  // the continuity field the owner named, for templates binding a root's clone (inputsOf): read from any x-latest value
  const continuesBy = ((): string | undefined => {
    const found = pool.filter((r) => r.role === OWNER).flatMap((r) => [r.where, ...[r.inputs].flat()].flatMap((w) =>
      typeof w === "object" && w !== null ? Object.values(((w as { where?: unknown }).where ?? w) as Record<string, unknown>) : []))
      .map(latestSpec).find((s) => s?.continues !== undefined)
    return found?.continues
  })()
  // a where value bound to something other than a literal: the call's pointer (x-pointer) or the clone's newest (x-latest)
  const boundValue = (v: unknown, pointer: Record<string, unknown> | undefined): unknown => {
    const spec = latestSpec(v)
    if (spec !== undefined) return latestValue(spec)
    const field = typeof v === "object" && v !== null ? (v as { "x-pointer"?: unknown })["x-pointer"] : undefined
    return typeof field === "string" ? pointer?.[field] : v
  }
  // an input entry {shape, where} is here only when a row of its shape meets its where (an older tree's diff is not a
  // diff of the clone's newest tree); an entry naming no where is here when its shape is, as before
  const entryHere = (e: unknown): boolean => {
    const where = typeof e === "object" && e !== null ? (e as { where?: unknown }).where : undefined
    if (typeof where !== "object" || where === null) return have.has(shapeOf(e))
    return pool.some((r) => r.shape === shapeOf(e) && Object.entries(where as Record<string, unknown>).every(([k, v]) => {
      const want = boundValue(v, undefined)
      return want !== undefined && JSON.stringify(r[k]) === JSON.stringify(want)
    }))
  }
  const ready = schemas.filter((s) => [s.inputs].flat().every(entryHere))
  // The owner's preconditions on calls: a shape some requires row names is called (on its own or in a template) only when
  // the root's latest row of the shape one of those rows needs has every field its where names equal. Several rows for
  // one shape are alternatives. Which shapes, and what they need, are the owner's rows: the walk names none.
  // A requires row says what one call needs of one shape (for, needs), and a newer owner row for the same two replaces it:
  // only the latest counts, so a precondition the owner tightens is not still met by the looser row it replaced, and one
  // the owner marks retired counts no more. Every reader below reads this one list.
  const reqs = [...pool.filter((r) => r.shape === REQUIRES && r.role === OWNER).sort((a, b) => a.seq - b.seq)
    .reduce((m, r) => m.set(JSON.stringify([String(r.for), String(r.needs)]), r), new Map<string, Row>()).values()]
    .filter((r) => r.retired !== true)
  // A requirement is met by the root's LATEST row of the shape it needs, so a later judgment revokes an earlier one. When
  // rows of that shape each speak for something different (one gap or another), the requires row names the field that
  // tells them apart (latest_by), and the latest row of each counts: any one meeting where meets it. The field is the
  // owner's to name; the walk knows none.
  // A where value may be bound to the call being asked for: {"x-pointer": "<field>"} is that call's pointer's field, so
  // one row can say "a row about the same thing this call is about" (the same path, say). A call whose pointer has no
  // such field does not meet it. The field is the owner's to name; the walk knows none.
  const ofCall = boundValue
  const latestOf = (q: Row): Row[] => {
    const by = typeof q.latest_by === "string" ? q.latest_by : undefined
    const latest = new Map<string, Row>()
    for (const x of pool.filter((r) => r.shape === String(q.needs)).sort((a, b) => a.seq - b.seq)) latest.set(by ? JSON.stringify(x[by]) : "", x)
    return [...latest.values()]
  }
  const meets = (q: Row, pointer?: Record<string, unknown>): boolean => {
    return latestOf(q).some((x) =>
      Object.entries((q.where ?? {}) as Record<string, unknown>).every(([k, v]) => {
        const want = ofCall(v, pointer)
        return want !== undefined && JSON.stringify(x[k]) === JSON.stringify(want)
      }))
  }
  // Rows may name a group: rows of one group are alternatives (any one met meets the group), and every group must be met.
  // A row naming none is in the one group every row was in before groups. The group is the owner's to name, as the
  // shapes are: the walk knows none.
  // What is said of an unmet group names what it needs and the steps toward it, each shape not yet here once: one the
  // owner's schemas make, from which inputs (the schema missing fewest), and one a call answers with, which call (as the
  // serving vessels declare it: answers). Read from the owner's rows and the vessels' declarations, so a request told
  // its call must wait is told what to ask for instead. Each shape is followed once, so the steps end.
  // The need itself was just found unmet (meets: no row here holds what is required, a row of the shape may well be
  // here, an old tree's verdict), so for it every input is named and its call too; below it, a shape already here is
  // taken as here (qa, agf_va3szit3jjul: d929's refusals named no step while an old tree's diff and verdict were here).
  // all: every input of the schema whose inputs are most here (the one that made the row here), not only the absent ones
  // An input entry whose shape is here but whose where no row meets (a diff, but not of the clone's newest tree) is
  // absent, and the step that makes it is named as for a shape not here at all.
  const unmetEntries = new Set<string>()
  const madeFrom = (shape: string, all = false): string[] | undefined => schemas.filter((s) => String(s.target) === shape)
    .map((s) => [s.inputs as unknown[]].flat().map((e) => ({ shape: shapeOf(e), here: entryHere(e) })))
    .map((ins) => ({ ins: ins.map((x) => x.shape), absent: ins.filter((x) => !x.here) }))
    .sort((a, b) => a.absent.length - b.absent.length)
    .map(({ ins, absent }) => {
      for (const x of absent) if (have.has(x.shape)) unmetEntries.add(x.shape)
      return all ? ins : absent.map((x) => x.shape)
    })[0]
  const toward = (need: string): string => {
    const steps: string[] = []
    const followed = new Set<string>()
    const follow = (shape: string, unmetHere = false): void => {
      if (followed.has(shape)) return
      followed.add(shape)
      // an input not yet here is named as before; for the unmet need with every input here (an old tree's diff and
      // verdict), its inputs are named all the same, since the ones here made a row that does not meet it
      const absent = madeFrom(shape)
      const stale = unmetHere && have.has(shape) && absent !== undefined && absent.length === 0
      const missing = stale ? madeFrom(shape, true) : absent
      if (missing !== undefined && missing.length > 0) {
        steps.push(stale ? `${shape} is made from ${missing.join(", ")} (no ${shape} here meets what is required)`
          : `${shape} is made from ${missing.join(", ")}, not yet here`)
        for (const m of missing) follow(m)
        return
      }
      const callers = Object.keys(answers).filter((c) => answers[c] === shape).sort()
      if (callers.length > 0 && (unmetHere || !have.has(shape) || unmetEntries.has(shape))) steps.push(`${shape} comes from a ${callers.join(" or ")} call`)
    }
    follow(need, true)
    return [need, ...steps].join("; ")
  }
  // Why a row of the needed shape that IS here does not meet a requirement: for each latest one, the first field of the
  // where it differs on, with both values, so a skip says what to change (agf_zwbwadr9y08l: "no change_wanted here meets
  // what is required" named neither the field nor the two values, and two templates bound to repo super kept being
  // skipped on an ask about another repository). A field bound to the call's pointer the call does not name says so.
  // Read from the same latest rows meets() reads; the fields are the owner's.
  const val = (v: unknown): string => shownValue(v, 60)
  // Each reason with the row it compared, so a skip can name every row behind the reasons it shows (against_refs): two
  // latest rows failing the same field the same way give one reason and two rows, and both are named (qa).
  const against = (q: Row, pointer?: Record<string, unknown>): Array<[string, string]> => latestOf(q).flatMap((x): Array<[string, string]> => {
    for (const [k, v] of Object.entries((q.where ?? {}) as Record<string, unknown>)) {
      const toCall = typeof v === "object" && v !== null && "x-pointer" in v
      const newest = latestSpec(v) !== undefined
      const want = ofCall(v, pointer)
      // the clone's newest tree is not known: its own words, never "the call names none" (the next step is a diff)
      if (want === undefined && newest) return [[`${k}: the clone's newest ${k} is not known (no row on its clone says it since it last moved)`, x.id]]
      if (want === undefined) return toCall && pointer !== undefined ? [[`${k}: the call names none`, x.id]] : []
      if (JSON.stringify(x[k]) !== JSON.stringify(want)) {
        const theirs = x[k] === undefined ? `${String(q.needs)} names none` : `≠ ${String(q.needs)}'s ${val(x[k])}`
        const whose = toCall ? "the call's" : newest ? "the clone's newest" : "required"
        return [[`${k}: ${whose} ${val(want)}${x[k] === undefined ? ", and " : " "}${theirs}`, x.id]]
      }
    }
    return []
  })
  // the rows behind each text unmet() returned, by the whole text (never a search inside it), for the skip that carries it
  const behindOf = new Map<string, Set<string>>()
  const refsOfReasons = (texts: string[]): string[] => [...new Set(texts.flatMap((t) => [...(behindOf.get(t) ?? [])]))]
  const unmet = (shape: string, pointer?: Record<string, unknown>, only: (rs: Row[]) => boolean = () => true): string[] => {
    const groups = new Map<string, Row[]>()
    for (const q of reqs.filter((q) => String(q.for) === shape)) groups.set(String(q.group ?? ""), [...(groups.get(String(q.group ?? "")) ?? []), q])
    return [...groups.values()].filter(only).filter((rs) => !rs.some((q) => meets(q, pointer)))
      .map((rs) => {
        const pairs = rs.flatMap((q) => against(q, pointer))
        const why = [...new Set(pairs.map(([reason]) => reason))].slice(0, 3)
        const text = `${shape} (requires ${[...new Set(rs.map((q) => toward(String(q.needs))))].join(" or ")}${why.length > 0 ? `; ${why.join("; ")}` : ""})`
        const ids = pairs.filter(([reason]) => why.includes(reason)).map(([, id]) => id)
        if (ids.length > 0) behindOf.set(text, new Set([...(behindOf.get(text) ?? []), ...ids]))
        return text
      })
  }
  // What a producer is shown before it promises a call (request_acts' gated, acts.ts): each call the owner's requires rows
  // gate, with the groups this same reading finds unmet here, worded as a skip words them. A group bound to the call's
  // own pointer (x-pointer: an edit needs a read of the file it edits) can only be judged for one target, so it is named
  // as needed for the target, not as met or unmet. Shown, not refused: a promise of a gated call stays allowed.
  const pointerBound = (rs: Row[]): boolean => rs.some((q) => Object.values((q.where ?? {}) as Record<string, unknown>)
    .some((v) => typeof v === "object" && v !== null && "x-pointer" in v))
  note.gated = Object.fromEntries([...new Set(reqs.map((q) => String(q.for)))].sort()
    .map((t) => [t, [...unmet(t, undefined, (rs) => !pointerBound(rs)), ...unmet(t, undefined, pointerBound).map((x) => `${x}, for the target the call names`)]])
    .filter(([, needs]) => needs.length > 0))
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
  const spoke = (r: Row): boolean => r.shape === FAILURE && r.role === WALK && r.blames === "request" &&
    [CALL, RUN].some((k) => String(byId.get(String(r.selection_ref))?.a ?? "").startsWith(`${k}/`))
  // Only a reason the root has not been told since it last learned something is new: a held row giving a reason already
  // given (another request, still waiting on the same thing, however other holds interleave) says nothing new, so the
  // request is not produced again over it. Otherwise each request produced over a reason is held for it again, its row
  // is new, and the root produces requests without end while the precondition stays unmet. A row from outside the walk
  // (a person's, the owner's, a detector's) starts the telling again: the walk's own produces, bookkeeping and call
  // results do not (a result that is news re-offers the request by itself, through what the producer is shown)...
  // What a call brought back is new only when no call of the same kind brought it back on this root before: an ended hop
  // whose output an earlier ended hop of its pointer type had, or a tool's answer row (a gitDiff, a fileContent) whose
  // content an earlier row of its shape had, tells the root nothing, whatever came between (two files read in turn are
  // each news once). Otherwise a call that
  // keeps answering the same thing (a diff of an unchanged tree) makes every produce over it new, and the root loops at
  // that call's rate. By content alone: ids, seqs, times and the refs that tie a row to its call are left out.
  // Within the root that made it: a pool can hold another root's calls (a gap opened again holds the rows of the root it
  // continues), and that root's answer is not this root's. An edit this root made, answered as another root's edit of the
  // same file once was, is news here (82ac: its edit read as a repeat of 52d7's, and the root stalled with no move). The
  // root is the one its selection names; a row whose selection is not in the pool is counted with the others like it.
  const repeats = new Set<string>()
  {
    const typeOf = new Map(pool.filter((r) => r.shape === HOP && r.phase === STARTED).map((r) => [String(r.call_id), String(r.pointer_type)]))
    const madeFor = (r: Row): string => String(byId.get(String(r.selection_ref ?? [r.input_refs].flat()[0]))?.root ?? "")
    // What identifies a result, by its shape, as the owner names it (news_key {of, fields}, the newest row per shape; a
    // retired one names none): only those fields are compared, a hop by its output's. A shape with no such row, or a
    // result holding none of its fields (a diff that names no tree yet), is compared whole, as before: two such results
    // keyed on nothing alone would read as the same.
    const keyOf = new Map([...pool.filter((r) => r.shape === NEWS_KEY && r.role === OWNER && typeof r.of === "string")
      .sort((a, b) => a.seq - b.seq).reduce((m, r) => m.set(String(r.of), r), new Map<string, Row>()).values()]
      .filter((r) => r.retired !== true && Array.isArray(r.fields)).map((r) => [String(r.of), (r.fields as unknown[]).map(String)]))
    const at = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined), o)
    const had = new Map<string, Set<string>>()
    const LEFT_OUT = new Set(["id", "seq", "t", "call_id", "selection_ref", "input_refs", "writer"])
    for (const r of [...pool].sort((a, b) => a.seq - b.seq)) {
      if (r.role !== WALK || (BOOKKEEPING.has(r.shape) && !informs(r))) continue
      const kind = `${madeFor(r)}|${r.shape === HOP ? `hop:${typeOf.get(String(r.call_id)) ?? ""}` : r.shape}`
      const subject = (r.shape === HOP ? r.output : r) as Row | undefined
      const keyed = keyOf.get(String(subject?.shape))?.map((f): [string, unknown] => [f, at(subject, f)])
      const content = keyed !== undefined && keyed.some(([, v]) => v !== undefined) ? JSON.stringify(keyed)
        : JSON.stringify(Object.keys(r).filter((k) => !LEFT_OUT.has(k)).sort().map((k) => [k, r[k]]))
      const seen = had.get(kind) ?? new Set<string>()
      if (seen.has(content)) repeats.add(r.id)
      seen.add(content)
      had.set(kind, seen)
    }
  }
  const brought = (r: Row): boolean => informs(r) && !repeats.has(r.id)
  const heldNew = new Set<string>()
  const told = new Set<string>()
  const isHeld = (r: Row): boolean => r.shape === FAILURE && r.role === WALK && r.request_ref !== undefined
  // ...and only a row a producer could read: one of a shape some owner schema takes as input or context. The owner's
  // configuration (a credits row, a schema, a requires row) is from outside the walk too, but no producer is shown it,
  // so it tells a waiting request nothing and every held reason stays told.
  const readable = new Set(schemas.flatMap((x) => [x.inputs, x.context ?? []].flat().map(shapeOf)))
  // ...and only the root's own: a row every root is given is about no one root, so it re-tells no root's reasons.
  const learned = (r: Row): boolean => r.role !== WALK && r.role !== DESCRIBED && readable.has(String(r.shape)) && note.shared?.has(r.id) !== true
  for (const r of [...pool].sort((a, b) => a.seq - b.seq)) {
    if (isHeld(r)) {
      const reason = JSON.stringify([r.unserved].flat().map(String).sort())
      if (!told.has(reason)) heldNew.add(r.id)
      told.add(reason)
    } else if (learned(r)) told.clear()
  }
  const held = (r: Row): boolean => heldNew.has(r.id)
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
  // What a set of rows is, as one short value: two sets are the same exactly when their keys are. Hashed, so a key can be
  // kept on a row (a selection's seen_key) without the row carrying every id it names.
  const key = (ids: string[]): string => createHash("sha256").update([...new Set(ids)].sort().join(",")).digest("hex")
  const seen = (s: Row) => {
    const entries = [s.inputs, s.context ?? []].flat()
    const shapes = new Set(entries.map(shapeOf))
    // An entry with latest_by shows the producer only the newest row per value of that field (described-shape reads it
    // so), so an older row of it is not something the producer saw: counted here, a produce that cited only the newest
    // would never read as having seen what it would see now, and would be asked again forever. A repeat (a row saying
    // again what an earlier one said) is not news and does not stand in for it: the newest row that is not a repeat
    // stays the one shown, or a repeat would hide both itself and what it repeats, and the produce would wait on a
    // news nothing can bring.
    const older = new Set<string>()
    for (const e of entries) {
      const by = typeof e === "object" && e !== null ? (e as { latest_by?: unknown }).latest_by : undefined
      if (typeof by !== "string") continue
      const newest = new Map<string, Row>()
      for (const r of pool.filter((x) => x.shape === shapeOf(e) && !repeats.has(x.id)).sort((a, b) => a.seq - b.seq)) {
        const k = JSON.stringify(r[by])
        const was = newest.get(k)
        if (was !== undefined) older.add(was.id)
        newest.set(k, r)
      }
    }
    // A root the walk said sat with no move (its stall row, citing the root) is news, once, to a schema that reads such
    // a row (an entry of its shape whose where it meets): the producer is offered again and shown that it sat, at the
    // next choice (law 8). Once that produce has seen it, it is old; the next is said only after N more store rows.
    const takes = (r: Row): boolean => entries.some((e) => shapeOf(e) === r.shape &&
      Object.entries(((typeof e === "object" && e !== null ? (e as { where?: unknown }).where : undefined) ?? {}) as Record<string, unknown>)
        .every(([k, v]) => JSON.stringify(r[k]) === JSON.stringify(v)))
    const stalled = (r: Row): boolean => r.shape === FAILURE && r.role === WALK && r.kind === STALL && r.selection_ref === undefined && takes(r)
    return (r: Row | undefined): boolean =>
      r !== undefined && shapes.has(r.shape) && !older.has(r.id) && !repeats.has(r.id) &&
      !(r.role === WALK && BOOKKEEPING.has(r.shape) && !brought(r) && !spoke(r) && !held(r) && !stalled(r))
  }
  // A produce the producer refused as not fitting the schema is not held: it is offered again like any produce, with the
  // refusal in its context to read, and each refusal debits the cell that chose it (records blames a refusal on the
  // request). How often it has been refused over the same rows is a fact on request_acts (repeats, on: refused), so the
  // producer, the grader and the person see it; the USER ruled "Fact + debit, no hold".
  const pending = (s: Row): boolean => {
    // A judge that changed judges again: when a gate's judgment (a shape some owner requires row needs) has a schema row
    // newer than the root's latest row of it, that judgment was made under the old words, so it is offered once more,
    // whatever it saw. The row it makes is newer than the schema: once per change of the schema. Nothing a gate does not
    // read is re-made this way: an answer is not sent twice, and a deadline is not moved.
    const judged = reqs.some((q) => String(q.needs) === String(s.target))
    const last = pool.filter((r) => r.shape === String(s.target)).sort((a, b) => a.seq - b.seq).at(-1)
    if (judged && last !== undefined && s.role === OWNER && s.seq > last.seq) return false
    const sees = seen(s)
    const now = key(pool.filter(sees).map((r) => r.id))
    // What a row was made over is what the walk handed its producer: the key its selection kept (seen_key). Not what
    // the producer cites: a producer shows its context newest first within a budget and cites only what it showed, so
    // on a root whose context outgrew the budget its citations are always a part of what the walk handed it, never the
    // same set, and the produce would be offered again on every tick. A row made before selections kept the key is
    // compared by what it cites, as before.
    const madeOver = (r: Row): string => {
      const by = byId.get(String(r.selection_ref))
      return typeof by?.seen_key === "string" ? by.seen_key : key([r.input_refs].flat().map(String).filter((id) => sees(byId.get(id))))
    }
    const ungraded = pool.filter((r) => r.shape === String(s.target)).filter((r) => !graded.has(r.id)).sort((a, b) => a.seq - b.seq)
    // Made by a produce whose choice kept what it was handed (seen_key): it is due again only when a row it would see
    // arrived after that choice. A row seen now that is older was in the root's window then too (the window keeps the
    // newest rows), and a row that has left the window since is not news: compared as sets, the window sliding over the
    // same evidence made 52d7196f's template produce due 164 times. The walk's rows of that same tick (written for that
    // selection) are not news either. The same rule calls and runs follow: nothing new, not again.
    // Which produce made it is read from the root's own record: the walk's selections of this produce whose call ended
    // and did not fail. The row it made need not come back in the root's episode (records returns an activity_template
    // as configuration, not as the root's: on 52d7196f no template it made was ever in its pool, so each tick read as
    // "never made"); a made row that is here and graded frees it, as before.
    const gradedMade = new Set(pool.filter((r) => r.shape === String(s.target) && graded.has(r.id)).map((r) => String(r.selection_ref)))
    const endedSel = new Set(pool.filter((h) => h.shape === HOP && h.phase === ENDED && h.kind === PRODUCE).map((h) => String(h.selection_ref)))
    const failedSel = new Set(pool.filter((f) => f.shape === FAILURE).map((f) => String(f.selection_ref)))
    const made = pool.filter((x) => x.shape === SELECTION && String(x.a).startsWith(`${PRODUCE}/${String(s.target)}/`)
      && endedSel.has(x.id) && !failedSel.has(x.id) && !gradedMade.has(x.id))
    const byRow = ungraded.map((r) => byId.get(String(r.selection_ref))).filter((x): x is Row => x !== undefined)
    const chose = [...made, ...byRow].sort((a, b) => a.seq - b.seq).at(-1)
    if (chose !== undefined && typeof chose.seen_key === "string") {
      return !pool.some((x) => x.seq > chose.seq && x.shape !== String(s.target) && String(x.selection_ref) !== chose.id && sees(x))
    }
    return ungraded.some((r) => madeOver(r) === now)
  }

  // A grade judges something: an answer (a described row of a shape the grade reads as context, other than a grade or a
  // deadline) or a deadline that has passed. A deadline still ahead is nothing to judge yet. Before either exists, a grade
  // is of the ask alone (records counts none such, and the person sees an ask graded before it was answered), so it is
  // not offered.
  const judgeable = (s: Row): boolean => String(s.target) !== OUTCOME ||
    pool.some((r) => r.role === DESCRIBED && r.shape !== OUTCOME && !DUES.has(r.shape) && [s.context ?? []].flat().map(shapeOf).includes(r.shape)) ||
    pool.some((r) => DUES.has(r.shape) && r.role === DESCRIBED && typeof r.at === "number" && r.at <= now)

  // A PRODUCE THE OWNER'S RHYTHM NAMES ({target, every_rows}) runs on its schedule only, as a scheduled template does
  // (below): on the walk's idle root, when at least every_rows rows were written to the store since the later of its
  // last produce of that target and its rhythm row (the USER, 11-16: "Yes, allow it": a retrospective "on this one
  // horizon"). It is offered then whatever its pool, and at no other time, nor on a request's own work. The target and
  // the count are the owner's rows; no shape is named here.
  const idleHere = note.awaits === false || (note.awaits === undefined && pool.some((x) => x.shape === ARM))
  const headNow = typeof note.head === "number" && Number.isFinite(note.head) ? note.head : undefined
  const paced = new Map<string, Row>()
  for (const r of pool.filter((x) => x.shape === RHYTHM && x.role === OWNER && typeof x.target === "string").sort((a, b) => a.seq - b.seq)) paced.set(String(r.target), r)
  const pacedOnly = new Set(paced.keys())
  const producedDue = (target: string): boolean => {
    const r = paced.get(target)
    if (r === undefined || r.retired === true || !(typeof r.every_rows === "number" && r.every_rows >= 1) || !idleHere || headNow === undefined) return false
    // its last produce: the selection that made it, or the row it made, whichever the pool still holds (a pool that left
    // one out must not make it due on every idle tick)
    const last = pool.filter((x) => (x.shape === SELECTION && String(x.a).startsWith(`${PRODUCE}/${target}/`)) || x.shape === target)
      .reduce((m, x) => Math.max(m, x.seq), 0)
    return headNow - Math.max(last, r.seq) >= Number(r.every_rows)
  }
  const offerable = (s: Row): boolean => pacedOnly.has(String(s.target)) ? producedDue(String(s.target)) : !pending(s) && judgeable(s)

  const produce = await Promise.all(ready.filter(offerable).map(async (s) => {
    const target = String(s.target)
    const served = await exists(target)
    const v = variant(s)
    return channels.filter(() => served).map((ch): Cand => ({
      ...base,
      id: [PRODUCE, target, ...(v ? [v] : []), ch.id].join("/"),
      kind: PRODUCE,
      pointer: { type: target, shape: target, via_ref: ch.id, ...(v ? { variant: v } : {}) },
      reads: [s.inputs, s.context ?? []].flat().map(shapeOf),
      seen_key: key(pool.filter(seen(s)).map((r) => r.id)),
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
  // A CALL THAT WAITS ON A PERSON (agf_i033lib9c2hs: d929's git_land, sent again every few seconds). A tool may answer
  // that only a person's verdict lets it go on (waits_for "person" on the call's failure row, lifted by the walk from the
  // tool's own answer); asked the same again before the person speaks, it answers the same. So a call type whose latest
  // failure on this root waits for a person is not offered until the root holds a row a person wrote after that failure
  // (records puts a person's row about any of the root's rows in the root's pool); until then the walk's move is to wait
  // for one. An owner row does not lift it: a seed run says nothing about this root. Read from the failure's own field
  // and the writer kind.
  const typeOf = new Map(pool.filter((r) => r.shape === HOP && r.phase === STARTED).map((h) => [String(h.call_id), String(h.pointer_type)]))
  // the root's own rows: its pool, less what every root is given (the owner's configuration)
  const ownRows = new Set(pool.filter((r) => note.shared?.has(r.id) !== true && r.role !== OWNER).map((r) => r.id))
  const lastFailure = new Map<string, Row>()
  for (const f of pool.filter((r) => r.shape === FAILURE && r.role === WALK && typeof r.call_id === "string").sort((a, b) => a.seq - b.seq)) {
    const t = typeOf.get(String(f.call_id))
    if (t !== undefined) lastFailure.set(t, f)
  }
  // a person's row about this root (the root itself, or citing any row of the root's own: a verdict cites the diff it
  // judges, never the ask; qa), newer than the row that said it waits
  const spokeAfter = (seq: number): boolean => pool.some((r) => r.seq > seq && r.role === PERSON &&
    (r.id === note.root || [r.input_refs].flat().map(String).some((id) => ownRows.has(id))))
  const waitsOnPerson = (type: string): boolean => {
    const f = lastFailure.get(type)
    return f !== undefined && f.waits_for === "person" && !spokeAfter(f.seq)
  }
  // Any other row of the root's own that says it waits for a person (a detector's gap whose claim a person must judge
  // first) holds the whole root the same way, lifted by the same person's row: the field means one thing whoever wrote
  // it. As with a call, the newest row says whether it still waits: the newest of the root's own rows of each shape by
  // each writer, so a writer ends its wait by writing the row again without the field (a gap whose check is runnable
  // again), not only by a person, and another writer's row of the same shape (the walk's own skip or stall) ends
  // nothing. A call's failure is read above instead, per call.
  const callFailure = (r: Row): boolean => r.shape === FAILURE && r.role === WALK && typeof r.call_id === "string"
  const newestOwn = new Map<string, Row>()
  for (const r of pool.filter((x) => ownRows.has(x.id) && !callFailure(x)).sort((a, b) => a.seq - b.seq)) {
    newestOwn.set(JSON.stringify([r.shape, r.role, r.writer]), r)
  }
  const rowWaits = [...newestOwn.values()].some((r) => r.waits_for === "person" && !spokeAfter(r.seq))
  // A call refused for the request's state (its failure blames the request, as records stamps it) settles that call on
  // this root, one rule for a request's call and a template's run: over the same inputs the same call gets the same
  // answer, so neither is made again until something new comes. The call is its shape and its arguments as sent (a run's,
  // as its hop recorded them; a request's pointer less the walk's forwarding keys), keys in order, so five templates or
  // nine requests making one refused call are one refusal (agf_7fcivb4rk967: a git_diff 21 times in an hour; eb1768f6's
  // git_commit nine times, each a new request with the same pointer). A pointer that differs in any field, free text
  // included (a commit message), is another call: the walk knows no field as "only words" (that would be a list of
  // fields), so rewording buys one call, and the refusal it repeats is in the producer's view. New: a walk result that is
  // news (brought: a commit made in the clone is), a row from outside the walk a producer reads (learned), or, for a run,
  // a row of a shape it takes in from outside the walk.
  const refusedHere = (f: Row): boolean => f.shape === FAILURE && f.role === WALK && f.blames === "request"
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : typeof v === "object" && v !== null
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v
  const callKey = (shape: string, args: unknown): string => JSON.stringify([shape, canon(args)])
  const argsOf = (p: Record<string, unknown>): Record<string, unknown> => {
    const { writer: _w, role: _r, type: _t, ...args } = p
    return args
  }
  const startedOf = new Map(pool.filter((h) => h.shape === HOP && h.phase === STARTED).map((h) => [String(h.call_id), h]))
  const refused = pool.filter(refusedHere).flatMap((f) => {
    const sel = byId.get(String(f.selection_ref))
    const a = String(sel?.a ?? "")
    if (a.startsWith(`${RUN}/`)) {
      const h = startedOf.get(String(f.call_id))
      return h === undefined ? [] : [{ seq: f.seq, key: callKey(String(h.pointer_type), h.args) }]
    }
    if (a.startsWith(`${CALL}/`)) {
      const p = (byId.get(String(sel?.from))?.pointer ?? {}) as Record<string, unknown>
      return [{ seq: f.seq, key: callKey(String(p.type ?? a.slice(CALL.length + 1)), argsOf(p)) }]
    }
    return []
  })
  const newsSince = (seq: number, also: (x: Row) => boolean = () => false): boolean =>
    pool.some((x) => x.seq > seq && (brought(x) || learned(x) || also(x)))
  const settled = (key: string, also?: (x: Row) => boolean) => refused.filter((x) => x.key === key && !newsSince(x.seq, also)).at(-1)
  const call = await Promise.all([...latest.entries()].map(async ([type, r]) => {
    if (waitsOnPerson(type)) return []
    const served = await exists(type)
    // a call is offered only when its callee declared what it takes and this request's pointer meets it (inputs.ts):
    // checked here and again when it is forwarded; said in the skip, so the request is produced again with the reason
    const vocab = declaredInputs()
    const { writer: _w, role: _r, ...asked } = (r.pointer ?? {}) as Record<string, unknown>
    const takes = vocab === undefined ? undefined : callProblem(vocab, type, asked)
    const prior = settled(callKey(type, argsOf(asked)))
    const gate = [...unmet(type, r.pointer as Record<string, unknown> | undefined), ...(takes !== undefined ? [takes] : []),
      ...(prior !== undefined ? [`${type}: this same call was refused here (row ${prior.seq}) and nothing new has come since; a different pointer is a different call`] : [])]
    const behind = refsOfReasons(gate)
    if (served && !answered.has(r.id) && gate.length > 0) skipped.push({ id: r.id, unserved: gate, of: "request", ...(behind.length > 0 ? { against_refs: behind } : {}) })
    return [r].filter(() => served && !answered.has(r.id) && gate.length === 0).map((): Cand => ({
      ...base,
      id: [CALL, type].join("/"),
      kind: CALL,
      pointer: r.pointer as Record<string, unknown>,
      from: r.id,
      // The request it answers decides it; the owner's requires rows only gate whether it exists, so they are not read.
      reads: [r.shape],
    }))
  }))

  // A template is run only when every shape it calls is served, as a call is: one naming a shape nothing serves (a
  // "hop", which is a record of a call, not a shape) would fail at its first step every time.
  // A template the owner's standing rhythm names is run on its schedule only (the USER: "Build the schedule reader
  // first"): on the walk's idle root, when at least every_rows rows were written to the store since the later of its last
  // run and its rhythm row. Rows written counts against the store's head (records' latest seq, note.head), never this
  // pool's own: the idle root's pool holds only its own and the shared rows, so its newest seq is neither "now" nor
  // anything that moves with the node's work. With no head known yet, nothing is due. Never offered to a request's own
  // work. The rhythm rows are the owner's; no template is named here. A run finishes within its tick (the loop awaits
  // it), so at most one of a rhythm's runs is ever in flight.
  const rhythms = new Map<string, Row>()
  for (const r of pool.filter((x) => x.shape === RHYTHM && x.role === OWNER && x.template !== undefined).sort((a, b) => a.seq - b.seq)) rhythms.set(String(r.template), r)
  // Any template a rhythm row ever named is scheduled only: a retired rhythm's template is not offered at all.
  const scheduled = new Set(rhythms.keys())
  for (const [t, r] of [...rhythms]) if (r.retired === true || !(typeof r.every_rows === "number" && r.every_rows >= 1)) rhythms.delete(t)
  const idleNow = note.awaits === false || (note.awaits === undefined && pool.some((x) => x.shape === ARM))
  const head = typeof note.head === "number" && Number.isFinite(note.head) ? note.head : undefined
  const due = (t: Row): boolean => {
    const r = rhythms.get(t.id)
    if (r === undefined || !idleNow || head === undefined) return false
    const ran = pool.filter((x) => x.shape === SELECTION && String(x.a) === `${RUN}/${t.id}`).reduce((m, x) => Math.max(m, x.seq), 0)
    return head - Math.max(ran, r.seq) >= Number(r.every_rows)
  }
  const templates = pool.filter((r) => TEMPLATES.has(r.shape)).filter((r) => !scheduled.has(r.id) || due(r))
    .filter((r) => (r.sig as { in: string[] }).in.every((x) => have.has(x)))
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
    // each call of the template is held to its own pointer; a tool call (not a produce through a channel) only to a tool
    // that declared its inputs (its pointer, once bound, is checked when forwarded)
    const vocab = declaredInputs()
    const undeclared = vocab === undefined ? [] : [...new Set(calls.filter((c) => !produced.has(c.shape))
      .filter((c) => vocab === null || !(c.shape in vocab)).map((c) => vocab === null ? `${c.shape}: the declared inputs could not be read, so no call is made` : `${c.shape}: no declared inputs`))]
    return [...shapes.filter((_, i) => !served[i]), ...channelless, ...new Set(calls.flatMap((c) => unmet(c.shape, c.pointer))), ...undeclared]
  }))
  // A template whose calls name a field of one of its inputs is run only where this request has that field: its
  // placeholders are filled from the request's own rows (bind.ts). One that cannot be filled here is not run, and the
  // skip says which placeholder and which field is missing, so its writer can see it. A placeholder naming an earlier
  // call's answer (calls.j) can only be filled during the run.
  // WHICH CLONE A ROOT HOLDING SEVERAL BINDS. The owner's clone_binding {of, by: [{shape, field}]}, the newest row for
  // each `of` (a retired one names none for its `of`; one for another shape leaves it in force, as the seeder keys it):
  // a template naming no repo takes the clone of `of` whose repo is the root's own statement of
  // where the change belongs: its newest row of the first listed shape it has one of (an ask's change_wanted), by that
  // row's field. The root's own: the root row itself or a row citing it or a root it continues; a statement on another
  // root never steers this one. That newest row is the root's word whatever became of it since (graded, lapsed); when it
  // names no repo (no change wanted), nothing binds, and an older statement is not taken in its place. A literal repo in
  // the template wins. With no owner row, nothing binds where the template names none.
  const bindings = new Map<string, Row>()
  for (const r of pool.filter((x) => x.shape === CLONE_BINDING && x.role === OWNER && typeof x.of === "string").sort((a, b) => a.seq - b.seq)) bindings.set(String(r.of), r)
  const targetOf = (binding: Row): { of: string; repo?: string; by: string } | undefined => {
    if (binding.retired === true || note.root === undefined) return undefined
    const own = continued(continuesBy)
    for (const e of [binding.by ?? []].flat() as Array<{ shape?: unknown; field?: unknown } | null>) {
      if (typeof e?.shape !== "string" || typeof e.field !== "string") continue
      const field = e.field
      const said = pool.filter((r) => r.shape === e.shape && (own.includes(r.id) || cites(r, own)))
        .sort((a, b) => a.seq - b.seq).at(-1)
      if (said !== undefined) return { of: String(binding.of), by: `${e.shape}.${field}`, ...(typeof said[field] === "string" ? { repo: String(said[field]) } : {}) }
    }
    return undefined
  }
  const targets = new Map([...bindings].map(([of, b]) => [of, targetOf(b)] as const).filter((e): e is readonly [string, { of: string; repo?: string; by: string }] => e[1] !== undefined))
  const fallback = Object.fromEntries([...targets].filter(([, t]) => t.repo !== undefined).map(([of, t]) => [of, String(t.repo)]))
  const inputs = templates.map((r) => note.root === undefined ? [] : inputsOf(pool, continued(continuesBy), (r.sig as { in: string[] }).in, VESSEL_ID, repoOf(r.calls as Inner[]),
    fallback))
  const unbound = templates.map((r, i) => {
    const scope: Scope = { sig: { in: inputs[i] }, calls: [] }
    return [...new Set((r.calls as Inner[]).flatMap((c) => placeholders(c.pointer)))]
      .filter((p) => !/^calls[.[]/.test(p) && bind(`{{${p}}}`, scope).unbound.length > 0)
  })
  templates.forEach((r, i) => {
    // A request holding clones of more than one repo binds only a template that names which (bind.ts inputsOf).
    const which = (p: string): string => {
      const shape = (r.sig as { in: string[] }).in[Number(/^sig\.in\[(\d+)\]/.exec(p)?.[1] ?? -1)]
      const repos = new Set(pool.filter((x) => x.shape === shape && x.writer === VESSEL_ID && typeof x.call_id === "string"
        && [x.input_refs].flat().map(String).includes(String(note.root))).map((x) => x.repo).filter((x) => typeof x === "string"))
      const target = targets.get(shape)
      if (repos.size > 1 && target !== undefined) {
        return target.repo === undefined
          ? `more than one ${shape} (${[...repos].sort().join(", ")}); the template names no repo, and this request's newest ${target.by} names none`
          : `more than one ${shape} (${[...repos].sort().join(", ")}); the template names no repo, and this request's ${target.by} names ${target.repo}, of which it holds no ${shape}`
      }
      return repos.size > 1 ? `more than one ${shape} (${[...repos].sort().join(", ")}), and the template names no repo` : "this request has no such field"
    }
    const why = [...unserved[i], ...unbound[i].map((p) => `unbound {{ ${p} }}: ${which(p)}`)]
    const behind = refsOfReasons(why)
    if (why.length > 0) skipped.push({ id: r.id, unserved: why, ...(unbound[i].length > 0 ? { unbound: unbound[i] } : {}), ...(behind.length > 0 ? { against_refs: behind } : {}) })
  })
  // A template already run in this root, whose run did not fail, is not run again until a row of a shape it takes in
  // (its sig.in) comes after that run from someone other than the walk: over the same inputs it would make the same
  // thing again (a clone handed out again), and offering it beside a request the walk has just asked for lets it win the
  // draw over calling that request, round after round. The walk's own rows since (its next selection, a hop) are how it
  // got here, not new input, even for a template that takes in selections; a template that takes in only those is run
  // again in a root only when its run failed.
  const takesIn = (r: Row) => { const takes = new Set((r.sig as { in: string[] }).in); return (x: Row): boolean => takes.has(x.shape) && x.role !== WALK }
  const ran = (r: Row): boolean => {
    const last = pool.filter((x) => x.shape === SELECTION && x.a === [RUN, r.id].join("/")).sort((a, b) => a.seq - b.seq).at(-1)
    if (last === undefined) return false
    const failed = pool.filter((x) => x.shape === FAILURE && x.role === WALK && String(x.selection_ref) === last.id && x.kind === undefined)
    if (failed.length > 0 && !failed.some(refusedHere)) return false
    if (failed.some(refusedHere)) return !newsSince(Math.max(...failed.map((f) => f.seq)), takesIn(r))
    const takes = new Set((r.sig as { in: string[] }).in)
    return !pool.some((x) => x.seq > last.seq && takes.has(x.shape) && x.role !== WALK)
  }
  const sameRefused = (r: Row, i: number): boolean => {
    const first = (r.calls as Inner[])[0]
    if (first === undefined) return false
    const b = bind(first.pointer, { sig: { in: inputs[i] }, calls: [] })
    if (b.unbound.length > 0) return false
    const key = callKey(first.shape, b.value)
    return settled(key, takesIn(r)) !== undefined
  }
  const run = templates
    .map((r, i) => ({ r, i }))
    .filter(({ i }) => unserved[i].length === 0 && unbound[i].length === 0)
    // a scheduled template's re-run is its rhythm's (due, above), not this rule's
    .filter(({ r, i }) => scheduled.has(r.id) || (!ran(r) && !sameRefused(r, i)))
    .map(({ r, i }): Cand => ({ ...base, id: [RUN, r.id].join("/"), kind: RUN, calls: r.calls as Inner[], reads: [...(r.sig as { in: string[] }).in], inputs: inputs[i] }))

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
  // A root whose call waits on a person is not overdue: its lapse is not graded (below), so it holds no other root's wait
  // back. Only a call's wait is read here: a row's wait holds the root's moves (waitFor) and changes no grading.
  const callWait = [...latest.keys()].some(waitsOnPerson)
  const personWait = rowWaits || callWait
  if (!callWait && first !== undefined && ahead.length === 0 && produce.flat().some((c) => c.pointer.type === OUTCOME)) note.overdue = true
  const bound = ahead.length > 0 ? { until: ahead[0] } : {}
  // One wait: for the next row a person or the owner writes. The walk runs one move at a time, so while it waits none of
  // its own produces or calls is in flight, and nothing else writes the shapes they make: a wait for one of those (an
  // answer, a due, a template) could only time out. records answers any wait with the next person or owner row.
  // A call that waits on a person (waitsOnPerson, above) makes waiting the walk's move too: what the root needs next is a
  // person's row, which is what records answers a wait with (qa: withheld, the walk must wait, not produce another try).
  const waitFor = idle || ahead.length > 0 || personWait
    ? [[] as string[]].map((shapes): Cand => ({
      ...base,
      id: [WAIT_FOR, ...shapes].join("/"),
      kind: WAIT_FOR,
      pointer: { shapes, ...(idle ? {} : bound) },
      reads: [],
    }))
    : []

  // While a call waits on a person, nothing the root could produce or run moves it: the person's row is what it needs
  // (deployment: on d929, answers, requests, deadlines, grades and templates went on being produced, a new git_land
  // request among them, each a model call, while git_land itself was held). So the root offers its wait and nothing
  // else. Its lapse is not graded either, once its first deadline has passed (the USER, 11-16: "No lapse while
  // waiting"): the deadline measured the makers' work, and the time is the person's. The person's row is what ends the
  // wait; until then the root shows as waiting on them.
  if (personWait) return waitFor
  return [...produce.flat(), ...call.flat(), ...run, ...waitFor]
}
