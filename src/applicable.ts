// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto"
import { type Scope, bind, inputsOf, placeholders, repoOf } from "./bind"
import { type Cand, ENDED, STARTED, type Inner, type Row, declaredInputs, exists, servers } from "./calls"
import { callProblem, shownValue } from "./inputs"
import { repeatKeysOf, stable } from "./acts"
import { VESSEL_ID } from "./config"
import {
  ACTIVITY_TEMPLATE, ARM, CHANNEL, CLONE_BINDING, DUE, FAILURE, HOP, INFRA_WINDOW, NEWS_KEY, OUTCOME, PRODUCE, CALL, REQUEST, REQUIRES, RHYTHM, RUN, SELECTION, SHAPE_SCHEMA, STALL, WAIT_FOR,
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

/** What a root's moves leave out that choices() must know across roots: a deadline that has already passed. And
 * what records says of the root (awaits: false when no one awaits an answer on it; dues: the at of each of its
 * deadlines), passed in. */
// shared: the ids of the rows every root is given (records' shared rows: the owner's configuration, earned templates),
// as against the root's own; what is shared is about no one root.
// root: the request the pool is for, which a template run binds its inputs from (bind.ts inputsOf).
// head: the store's latest seq as records last said it (the posterior's at_seq), which a rhythm counts rows against.
// gated (out): each call the owner's requires rows gate, with what it still needs here (see where it is set).
// frontier (out): the root's newest made row and the calls that take it (see where it is set).
export type Frontier = { id?: string; shape?: string; calls: string[]; widened: boolean }
export type Seen = { overdue?: boolean; awaits?: boolean; dues?: number[]; shared?: ReadonlySet<string>; root?: string; head?: number; gated?: Record<string, string[]>; frontier?: Frontier }

// What an owner's install row installed: each entry's repo and vessel.
const installedBy = (x: Row): Array<{ repo?: unknown; vessel?: unknown }> =>
  x.shape === INFRA_WINDOW && x.role === OWNER ? [x.installed].flat().map((i) => (i ?? {}) as { repo?: unknown; vessel?: unknown }) : []
// Whether any of these rows installed the root's own repo or the walk itself: the part of an install's bearing on a root
// that needs no read (a vessel serving the root's call is read where a call is held).
export const installsRepoOrWalk = (xs: Row[], repo: unknown): boolean =>
  xs.flatMap(installedBy).some((e) => (typeof e.repo === "string" && e.repo === repo) || e.vessel === VESSEL_ID)

// Whether a person has spoken on a root since seq: a person's row that is the root, or cites one of the root's own rows
// (own: rows of the root's that are not owner configuration). A verdict cites the diff it judges, never the ask. A
// person's row about nothing of the root's (a page they viewed elsewhere) is not their word on it. One rule for whoever
// asks whether a wait on a person still holds: the call offered again, and the stall step's sparing of a waiting root.
export const personSpokeAfter = (pool: Row[], root: unknown, own: (id: string) => boolean, seq: number): boolean =>
  pool.some((r) => r.seq > seq && r.role === PERSON && (r.id === root || [r.input_refs].flat().map(String).some(own)))

export const applicable = async (pool: Row[], skipped: Skipped[] = [], now = Date.now(), note: Seen = {}, answers: Record<string, string> = {}): Promise<Cand[]> => {
  const have = new Set(pool.map((r) => r.shape))
  // The owner's newest schema row for a target supersedes older ones (described reads the newest too), so a produce
  // offered is under the rules it has now; a schema written again re-makes a row already made only where that row is a
  // gate's judgment or one the walk held back (pending, below). A row may name a variant: another way the owner
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
  // diff of the clone's newest tree); an entry naming no where is here when its shape is, as before. With latest_by, only
  // the latest row per value of that field is read, and where is met by it or not at all: what a thing stands at now, as
  // records' reads and the owner's requires take it, so a gap whose latest row no longer says localized false is no
  // longer one, though an older row of it did.
  const latestPer = (rows: Row[], by: unknown): Row[] => {
    if (typeof by !== "string") return rows
    const latest = new Map<string, Row>()
    for (const r of rows.filter((x) => x[by] !== undefined).sort((a, b) => a.seq - b.seq)) latest.set(JSON.stringify(r[by]), r)
    return [...latest.values()]
  }
  const entryHere = (e: unknown): boolean => {
    const where = typeof e === "object" && e !== null ? (e as { where?: unknown }).where : undefined
    if (typeof where !== "object" || where === null) return have.has(shapeOf(e))
    const by = (e as { latest_by?: unknown }).latest_by
    return latestPer(pool.filter((r) => r.shape === shapeOf(e)), by).some((r) => Object.entries(where as Record<string, unknown>).every(([k, v]) => {
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
  // THE NEXT STEP TAKES WHAT THE ROOT LAST MADE (the activity lattice). The frontier is the root's newest made row: a
  // tool's answer (a shape some vessel declares a call answers with) or a produce (a shape the owner's schemas make,
  // whoever wrote the row: a person's verdict is one); rows every root shares are no root's. The calls that take it are
  // those with an owner requires row (the latest per for and needs, retired dropped: reqs) needing its shape whose where
  // the row meets: a field bound to the call's own pointer cannot be judged before a call names one, so it counts as
  // met; every other field is read as meets reads it. This is an offer, not a gate: the owner's requires rows are
  // preconditions, so a call outside the scope stays callable and its candidate says it is outside (out_of_scope), for
  // the producer and the grades to read. A frontier no requires row takes, or none at all, says it was widened. A
  // request is an ask, not something made for a next step to take, so it is never the frontier. A request is judged by
  // the frontier it was made over (the newest made row before it), so a row made after it does not change its scope.
  const made = new Set([...Object.values(answers), ...schemas.map((s) => String(s.target))].filter((x) => !REQUESTS.has(x)))
  const frontierBefore = (at: number): Row | undefined => pool
    .filter((r) => made.has(String(r.shape)) && note.shared?.has(r.id) !== true && r.seq < at).sort((a, b) => a.seq - b.seq).at(-1)
  const takenBy = (q: Row, f: Row): boolean => Object.entries((q.where ?? {}) as Record<string, unknown>).every(([k, v]) => {
    if (typeof v === "object" && v !== null && "x-pointer" in v) return true
    const want = boundValue(v, undefined)
    return want !== undefined && JSON.stringify(f[k]) === JSON.stringify(want)
  })
  const takers = (f: Row | undefined): string[] =>
    f === undefined ? [] : [...new Set(reqs.filter((q) => String(q.needs) === String(f.shape) && takenBy(q, f)).map((q) => String(q.for)))].sort()
  const frontierOf = (f: Row | undefined): Frontier => {
    const calls = takers(f)
    return { ...(f !== undefined ? { id: f.id, shape: String(f.shape) } : {}), calls, widened: calls.length === 0 }
  }
  note.frontier = frontierOf(frontierBefore(Number.POSITIVE_INFINITY))
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
  // the steps toward a need, and the calls among them: each call a step names as where a shape comes from
  const chainOf = (need: string): { steps: string[]; calls: string[] } => {
    const steps: string[] = []
    const calls: string[] = []
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
      if (callers.length > 0 && (unmetHere || !have.has(shape) || unmetEntries.has(shape))) {
        steps.push(`${shape} comes from a ${callers.join(" or ")} call`)
        calls.push(...callers)
      }
    }
    follow(need, true)
    return { steps, calls }
  }
  const toward = (need: string): string => [need, ...chainOf(need).steps].join("; ")
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
  const unmetGroups = (shape: string, pointer?: Record<string, unknown>, only: (rs: Row[]) => boolean = () => true): Row[][] => {
    const groups = new Map<string, Row[]>()
    for (const q of reqs.filter((q) => String(q.for) === shape)) groups.set(String(q.group ?? ""), [...(groups.get(String(q.group ?? "")) ?? []), q])
    return [...groups.values()].filter(only).filter((rs) => !rs.some((q) => meets(q, pointer)))
  }
  const unmet = (shape: string, pointer?: Record<string, unknown>, only: (rs: Row[]) => boolean = () => true): string[] =>
    unmetGroups(shape, pointer, only)
      .map((rs) => {
        const pairs = rs.flatMap((q) => against(q, pointer))
        const why = [...new Set(pairs.map(([reason]) => reason))].slice(0, 3)
        const text = `${shape} (requires ${[...new Set(rs.map((q) => toward(String(q.needs))))].join(" or ")}${why.length > 0 ? `; ${why.join("; ")}` : ""})`
        const ids = pairs.filter(([reason]) => why.includes(reason)).map(([, id]) => id)
        if (ids.length > 0) behindOf.set(text, new Set([...(behindOf.get(text) ?? []), ...ids]))
        return text
      })
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
  // each repeat, with the earlier row whose content it repeats (the first of its kind and content)
  const repeatOf = new Map<string, Row>()
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
    const first = new Map<string, Row>()
    const LEFT_OUT = new Set(["id", "seq", "t", "call_id", "selection_ref", "input_refs", "writer"])
    // A row another writer made (a detector writing a gap again) is weighed so too when the owner names its shape's
    // news_key: a gap restated with nothing the key names changed (its claim's wording, a stamp) tells no producer
    // anything, and was judged again on every restatement (a tree already refused re-judged on three later roots). Such
    // rows are compared by writer role and shape across roots, since each restatement is its own root; the key's fields
    // (the gap's id among them) tell one thing from another.
    for (const r of [...pool].sort((a, b) => a.seq - b.seq)) {
      const other = r.role !== WALK && keyOf.has(String(r.shape))
      if ((r.role !== WALK && !other) || (BOOKKEEPING.has(r.shape) && !informs(r))) continue
      const kind = other ? `${String(r.role)}|${r.shape}` : `${madeFor(r)}|${r.shape === HOP ? `hop:${typeOf.get(String(r.call_id)) ?? ""}` : r.shape}`
      const subject = (r.shape === HOP ? r.output : r) as Row | undefined
      const keyed = keyOf.get(String(subject?.shape))?.map((f): [string, unknown] => [f, at(subject, f)])
      const content = keyed !== undefined && keyed.some(([, v]) => v !== undefined) ? JSON.stringify(keyed)
        : JSON.stringify(Object.keys(r).filter((k) => !LEFT_OUT.has(k)).sort().map((k) => [k, r[k]]))
      const seen = had.get(kind) ?? new Set<string>()
      const sig = JSON.stringify([kind, content])
      if (seen.has(content)) {
        repeats.add(r.id)
        const was = first.get(sig)
        if (was !== undefined) repeatOf.set(r.id, was)
      } else first.set(sig, r)
      seen.add(content)
      had.set(kind, seen)
    }
    // A produced row that judges the same thing the same way as the one before it is a repeat too, by the owner's word on
    // its schema row (repeat_key, repeat_value: a land verdict's tree and r, as request_acts reads them): a second r 0
    // on a tree already refused says nothing new, yet it made every producer that reads verdicts due again, so a tree
    // refused 40 times was explained, and drafted on, 40 times. Within one root, role and writer: a person's verdict is
    // never absorbed by a grader's, another grader's is its own evidence with its own why, and a different r is news.
    for (const [target, { key: k, value: v }] of repeatKeysOf(pool)) {
      const last = new Map<string, string>()
      for (const r of pool.filter((x) => x.shape === target && (typeof x[k] === "string" || typeof x[k] === "number")).sort((a, b) => a.seq - b.seq)) {
        const at = JSON.stringify([String(r.root ?? madeFor(r)), String(r.role), String(r.writer), String(r[k])])
        // the first row under a key repeats nothing, whatever its value, even one it lacks
        if (last.has(at) && last.get(at) === stable(r[v])) repeats.add(r.id)
        last.set(at, stable(r[v]))
      }
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
  // AN INSTALL THAT COULD BEAR ON A HELD REQUEST IS ONE MORE TRY FOR IT. A root the walk held, told why, waits for news;
  // a fix installed as code (an owner infra_window row naming what it installed) names no root, so without this it never
  // reached a root already told, and each fix changed only later roots. An install bears on a request when it installed
  // the root's own repo (the root's repo field), the walk itself (which judged the request held), or a vessel discovery
  // says serves the request's call (read now; pull-sync names the vessel from its own inventory, so no name is guessed
  // from a repo). It is news once: the request made again over it, or the call it lets through, is newer than it. Every
  // other restart row, and an install bearing on none of these, tells the root nothing.
  const rootRow = note.root === undefined ? undefined : byId.get(note.root)
  const callOfReq = (q: Row | undefined): string | undefined => {
    const t = (q?.pointer as { type?: unknown } | undefined)?.type
    return typeof t === "string" ? t : undefined
  }
  // An install bears on a held or refused call when it installed the root's own repo, the walk itself, or a vessel
  // discovery says serves that call. Who serves it is read only for that one call, and only when an install with a vessel
  // sits where it can still be news to it: every install stays in the pool, so a read on every tick would never stop.
  // An unanswered read serves no one.
  const bearsOn = async (xs: Row[], call: string | undefined): Promise<boolean> => {
    if (installsRepoOrWalk(xs, rootRow?.repo)) return true
    const entries = xs.flatMap(installedBy)
    const vessels = entries.map(({ vessel }) => vessel).filter((v): v is string => typeof v === "string")
    if (call === undefined || vessels.length === 0) return false
    const serving = (await servers(call)) ?? new Set<string>()
    return vessels.some((v) => serving.has(v))
  }
  // The root's latest row of each shape a held reason names, when an install since its latest hold bears on its call.
  const heldAgain = new Set<string>()
  for (const shape of new Set(pool.filter(isHeld).map((f) => byId.get(String(f.request_ref))?.shape))) {
    const last = pool.filter((r) => r.shape === shape).sort((a, b) => a.seq - b.seq).at(-1)
    const holds = last === undefined ? [] : pool.filter((f) => isHeld(f) && String(f.request_ref) === last.id)
    if (last === undefined || holds.length === 0) continue
    const toldAt = Math.max(...holds.map((f) => f.seq))
    if (await bearsOn(pool.filter((x) => x.seq > toldAt), callOfReq(last))) heldAgain.add(last.id)
  }
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
    // An {answers_a_call: true} entry names no shape: it reads a tool's answer, of whatever shape (described-shape admits
    // a row so). Read by its shape it named none, and no call's answer was ever news to a producer asking for them.
    const admits = (e: unknown, r: Row): boolean => typeof e === "object" && e !== null && (e as { answers_a_call?: unknown }).answers_a_call === true
      ? r.role === WALK && r.shape !== HOP && typeof r.call_id === "string"
      : r.shape === shapeOf(e)
    const reads = (r: Row): boolean => entries.some((e) => admits(e, r))
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
      for (const r of pool.filter((x) => admits(e, x) && !repeats.has(x.id)).sort((a, b) => a.seq - b.seq)) {
        const k = JSON.stringify(r[by])
        const was = newest.get(k)
        if (was !== undefined) older.add(was.id)
        newest.set(k, r)
      }
    }
    // A root the walk said sat with no move (its stall row, citing the root) is news, once, to a schema that reads such
    // a row (an entry of its shape whose where it meets): the producer is offered again and shown that it sat, at the
    // next choice (law 8). Once that produce has seen it, it is old; the next is said only after N more store rows.
    const takes = (r: Row): boolean => entries.some((e) => admits(e, r) &&
      Object.entries(((typeof e === "object" && e !== null ? (e as { where?: unknown }).where : undefined) ?? {}) as Record<string, unknown>)
        .every(([k, v]) => JSON.stringify(r[k]) === JSON.stringify(v)))
    const stalled = (r: Row): boolean => r.shape === FAILURE && r.role === WALK && r.kind === STALL && r.selection_ref === undefined && takes(r)
    // A restart row is news only as an install bearing on a held request (pending, below): read as any row of its shape,
    // every restart would make every root that reads it due again.
    return (r: Row | undefined): boolean =>
      r !== undefined && r.shape !== INFRA_WINDOW && reads(r) && !older.has(r.id) && !repeats.has(r.id) &&
      !(r.role === WALK && BOOKKEEPING.has(r.shape) && !brought(r) && !spoke(r) && !held(r) && !stalled(r))
  }
  // A produce the producer refused as not fitting the schema is not held: it is offered again like any produce, with the
  // refusal in its context to read, and each refusal debits the cell that chose it (records blames a refusal on the
  // request). How often it has been refused over the same rows is a fact on request_acts (repeats, on: refused), so the
  // producer, the grader and the person see it; the USER ruled "Fact + debit, no hold".
  const pending = (s: Row): boolean => {
    // A judge that changed judges again: when a gate's judgment (a shape some owner requires row needs) has a schema row
    // newer than the root's latest row of it, that judgment was made under the old words, so it is offered once more,
    // whatever it saw. The row it makes is newer than the schema: once per change of the schema. Nothing else a gate does
    // not read is re-made this way: an answer is not sent twice, and a deadline is not moved (a re-made one could hide a
    // lapse). A row the walk held back (a held reason names it as request_ref) is re-made the same way: either its call
    // was never made (a skip), or it was made once and its answer not kept (too_big), so nothing it asked for was sent
    // on or relied on. Making it again sends nothing twice and moves no deadline, and a root whose request the walk held,
    // told why, would otherwise never be asked under the words the owner wrote to fix it.
    const judged = reqs.some((q) => String(q.needs) === String(s.target))
    const last = pool.filter((r) => r.shape === String(s.target)).sort((a, b) => a.seq - b.seq).at(-1)
    const holds = last === undefined ? [] : pool.filter((f) => isHeld(f) && String(f.request_ref) === last.id)
    const heldBack = holds.length > 0
    if ((judged || heldBack) && last !== undefined && s.role === OWNER && s.seq > last.seq) return false
    // and an install bearing on it since it was last held (above)
    if (heldBack && heldAgain.has(String(last?.id))) return false
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
    // A failure ending an attempt (ends) charges a produce that was made; it is not its call failing, so it frees nothing.
    const failedSel = new Set(pool.filter((f) => f.shape === FAILURE && f.ends === undefined).map((f) => String(f.selection_ref)))
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
      ...(pacedOnly.has(target) ? { rhythm: true as const } : {}),
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
  const typeOf = new Map(pool.filter((r) => r.shape === HOP && r.phase === STARTED).map((h) => [String(h.call_id), String(h.pointer_type)]))
  // A CALL THAT CHANGED NOTHING THE WALK CAN TELL APART IS SAID. A call that ended with an answer an earlier call of its
  // type on this root already gave (repeats, above) is no news, so the request that asked for it is not produced again
  // over it; with nothing else new, the root sat with no move and its producer was never told why (0c5f: an edit
  // answered as an earlier edit of the same range had, then no move for hours). So the walk holds that request for it,
  // as it holds a request whose call is gated: a reason the producer reads, news once by the held rule, naming the call
  // type and the earlier row, never the request, so the same answer given again to a later request is a reason already
  // told, and another answer repeated is a new one. Only the newest request of its call type: an older one is settled.
  for (const h of pool.filter((x) => informs(x) && x.kind === CALL && repeatOf.has(x.id))) {
    const sel = byId.get(String(h.selection_ref))
    const type = typeOf.get(String(h.call_id))
    const req = latest.get(String(type))
    if (sel === undefined || type === undefined || req === undefined || String(sel.from) !== req.id) continue
    const was = repeatOf.get(h.id) as Row
    skipped.push({ id: req.id, of: "request", against_refs: [was.id],
      unserved: [`${type}: it answered as row ${was.seq} did, so it changed nothing the walk can tell apart; the same call again answers the same, and a different pointer is a different call`] })
  }
  // A CALL THAT WAITS ON A PERSON (agf_i033lib9c2hs: d929's git_land, sent again every few seconds). A tool may answer
  // that only a person's verdict lets it go on (waits_for "person" on the call's failure row, lifted by the walk from the
  // tool's own answer); asked the same again before the person speaks, it answers the same. So a call type whose latest
  // failure on this root waits for a person is not offered until the root holds a row a person wrote after that failure
  // (records puts a person's row about any of the root's rows in the root's pool); until then the walk's move is to wait
  // for one. An owner row does not lift it: a seed run says nothing about this root. Read from the failure's own field
  // and the writer kind.
  // the root's own rows: its pool, less what every root is given (the owner's configuration)
  const ownRows = new Set(pool.filter((r) => note.shared?.has(r.id) !== true && r.role !== OWNER).map((r) => r.id))
  const lastFailure = new Map<string, Row>()
  for (const f of pool.filter((r) => r.shape === FAILURE && r.role === WALK && typeof r.call_id === "string").sort((a, b) => a.seq - b.seq)) {
    const t = typeOf.get(String(f.call_id))
    if (t !== undefined) lastFailure.set(t, f)
  }
  // a person's row about this root (the root itself, or citing any row of the root's own: a verdict cites the diff it
  // judges, never the ask; qa), newer than the row that said it waits
  const spokeAfter = (seq: number): boolean => personSpokeAfter(pool, note.root, (id) => ownRows.has(id), seq)
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
    // a call no request asked for (the chain step, below) is held by its frontier row instead: there is no request
    // pointer to key it by
    if (a.startsWith(`${CALL}/`) && typeof sel?.from === "string") {
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
    // An install bearing on the call is news to a request made after it (the one try, made again over the install), never
    // to the request it found held: that one is not called again, so an install is one try, not two. Only the call's
    // latest refusal is asked: an install after it is after every earlier one too.
    const asKey = callKey(type, argsOf(asked))
    const lastRefusal = refused.filter((x) => x.key === asKey).at(-1)
    const reopened = lastRefusal !== undefined && await bearsOn(pool.filter((x) => x.seq > lastRefusal.seq && x.seq < r.seq), type)
    const prior = reopened ? undefined : settled(asKey)
    const over = frontierOf(frontierBefore(r.seq))
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
      ...(over.widened || over.calls.includes(type) ? {} : { out_of_scope: true }),
    }))
  }))

  // THE STEP A GATED CALL'S CHAIN NAMES IS OFFERED (USER ruling 11-23, the walk offers the step a refusal's chain names).
  // A call the owner's requires rows gate is told what it needs and where that comes from ("gitDiff comes from a git_diff
  // call"); when the call so named takes the root's newest made row, it is offered
  // without waiting for a producer to ask for it, as any call is: served, its inputs declared, nothing it requires
  // unmet, not waiting on a person. Its pointer is bound from the frontier row by the owner's requires row that takes
  // it (binds: {pointer field: row field}); a requires row naming no binds offers nothing, so which rows lead on to which
  // call is the owner's to say, never the walk's. Once per frontier row: a selection of the call made over the same
  // frontier (its frontier field) settles it, so it is offered again only over a newer made row. A request already
  // asking for the call, or a decline, leaves it to the request. A failed offered call writes a failure, not a made row,
  // so the same frontier is not offered again: the wait ends when the root makes a newer row (another commit, a refreshed
  // clone) or a producer asks for the call. That holds for an outage too, which the offer does not retry on its own: a
  // producer that sees the failure asks again. Records reads the frontier as the row an offered call consumed.
  const frontierRow = frontierBefore(Number.POSITIVE_INFINITY)
  const asked = new Set(call.flat().map((c) => c.id))
  const chained = frontierRow === undefined || declined ? [] : await Promise.all([...new Set([...new Set(reqs.map((q) => String(q.for)))]
    .flatMap((t) => unmetGroups(t, undefined, (rs) => !pointerBound(rs)).flat().flatMap((q) => chainOf(String(q.needs)).calls)))]
    .sort()
    .map(async (type): Promise<Cand[]> => {
      const id = [CALL, type].join("/")
      if (asked.has(id) || waitsOnPerson(type)) return []
      const q = reqs.find((x) => String(x.for) === type && String(x.needs) === String(frontierRow.shape) && takenBy(x, frontierRow)
        && typeof x.binds === "object" && x.binds !== null)
      if (q === undefined) return []
      const fields = Object.entries(q.binds as Record<string, unknown>).map(([k, from]) => [k, frontierRow[String(from)]] as const)
      if (fields.length === 0 || fields.some(([, v]) => v === undefined)) return []
      // the call is the one the chain names: a binds naming type does not change it
      const pointer: Record<string, unknown> = { ...Object.fromEntries(fields), type }
      const before = pool.some((x) => x.shape === SELECTION && x.a === id && (x.frontier as { id?: unknown } | undefined)?.id === frontierRow.id)
      if (before || !(await exists(type))) return []
      const vocab = declaredInputs()
      const { type: _t, ...args } = pointer
      if (vocab !== undefined && callProblem(vocab, type, args) !== undefined) return []
      if (unmet(type, pointer).length > 0) return []
      return [{ ...base, id, kind: CALL, pointer, reads: [String(frontierRow.shape)] }]
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
    .map(({ r, i }): Cand => ({ ...base, id: [RUN, r.id].join("/"), kind: RUN, calls: r.calls as Inner[], reads: [...(r.sig as { in: string[] }).in], inputs: inputs[i],
      ...(scheduled.has(r.id) ? { rhythm: true as const } : {}) }))

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
  // The request's deadlines are records' (its episode's dues, the at of each): which rows are deadlines, and that every
  // one counts ("Later deadlines close it"), is the rule records judges lapses by, read from its answer rather than kept
  // here as a copy (a copy of "the first deadline only" outlived the rule it copied). A wait is bounded by the next one
  // still ahead. One passed with none ahead makes grading the lapse the move. A records that answers no dues has none.
  const dues = note.dues ?? []
  const ahead = dues.filter((at) => at > now).sort((a, b) => a - b).slice(0, 1)
  const passed = dues.some((at) => at <= now)
  // A passed deadline holds every wait back only while grading its lapse is on offer this turn. Once that grade is
  // pending (the walk graded what it saw and nothing new came), waiting is the walk's move again: otherwise a request
  // graded but never closed would keep the walk from ever waiting.
  // A root whose call waits on a person is not overdue: its lapse is not graded (below), so it holds no other root's wait
  // back. Only a call's wait is read here: a row's wait holds the root's other moves and changes no grading (below).
  const callWait = [...latest.keys()].some(waitsOnPerson)
  const personWait = rowWaits || callWait
  const lapse = produce.flat().filter((c) => c.pointer.type === OUTCOME)
  const overdue = !callWait && passed && ahead.length === 0 && lapse.length > 0
  if (overdue) note.overdue = true
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
  if (callWait) return waitFor
  // A row of the root's own that waits on a person holds its other moves the same way, but the ruling names a call's
  // wait, not a row's: a passed deadline's lapse is still graded beside the wait, as on a root with no wait.
  if (rowWaits) return [...(overdue ? lapse : []), ...waitFor]
  return [...produce.flat(), ...call.flat(), ...chained.flat(), ...run, ...waitFor]
}
