// SPDX-License-Identifier: MIT
import { actsFactRow, frontierFields } from "./acts"
import { type Frontier, type Seen, type Skipped, applicable, installsRepoOrWalk } from "./applicable"
import { type Cand, READ_AGAIN_MS, READ_WAIT_MS, type Row, execute, loopCall, recordSkipped, shapeAnswers, stopped, writeRow } from "./calls"
import { VESSEL_ID } from "./config"
import { type Post, draw, pick } from "./draw"
import { ARM, DESCRIBED, DUE, FAILURE, INFRA_WINDOW, OWNER, PERSON, POSTERIOR, PRODUCE, RECORD_READ, RECORD_WAIT_EXACT, RHYTHM, SELECTION, STALL, STALL_RULE, WAIT_FOR, WALK } from "./shapes"

type Episodes = { shared: Row[]; roots: Array<{ root: Row; rows: Row[]; awaits?: boolean; dues?: number[] }> }
type Option = { cand: Cand; pool: Row[]; context: string[]; cell: string; skipped: Skipped[]; root: string; gated?: Record<string, string[]>; frontier?: Frontier; rootCell?: string }

// How long a root has waited, coarsely: 0 for its first minute, then one more per doubling of minutes. Context for
// selection to learn from, never an order.
const ageBucket = (root: Row, now: number): number => {
  const minutes = Math.max(0, (now - Date.parse(String(root.t))) / 60_000)
  return Number.isFinite(minutes) ? Math.floor(Math.log2(minutes + 1)) : 0
}

/**
 * Every open request is a root, and what to do next is chosen among the moves of all of them. Each root's moves are
 * worked out over the rows it shares with the others plus its own, never another request's, and carry the root's
 * asker (role) and age as context, so selection learns which requests are worth taking. Waiting is one move, bounded
 * by the earliest deadline ahead across every root, and not offered once any root's deadline has passed, so one root's
 * wait never lets another's deadline pass unseen.
 */
// What a tick learns of every root besides the options it offers: which roots had any move, a wait included (a root
// waiting on a person has one, though the wait is offered only when no root has another move), and, for each root with
// none at all, what it held back and why (its skipped requests and templates), so the tick can say so.
export type Held = { moving: Set<string>; still: Array<{ root: string; pool: Row[]; skipped: Skipped[] }> }

// A ROW MADE ON ANOTHER ROOT IS SHOWN, NEVER WORKED. A root's rows may hold a row whose `root` (the request it was made
// for, as its producer or the walk wrote it) names another root. Its producers are shown it, but it is never this root's
// work: not a call to make here, not this root's decline, not an answer this root's grade may judge, not an input a
// template binds here, not news that restarts its stall count. A row is the root's work when it names no root, names this
// one, or, on a gap, names a row of the same gap (a detector writing the gap again moves its root, and the work done
// under the earlier row is the same gap's). Read from the row's own field, never from whether it is among the root's
// rows: a person's follow-up that cites this root is among them, names no root, and is worked here as before.
// A gap is one gap only by a real id: an absent, null or empty gap_id names no gap, so two roots carrying one are never
// the same gap however alike their shape and role.
const isGapId = (v: unknown): boolean => v !== undefined && v !== null && v !== ""
export const worksOn = (root: Row, rows: Row[]): ((r: Row) => boolean) => {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const sameGap = (id: string): boolean => {
    const x = byId.get(id)
    return isGapId(root.gap_id) && x !== undefined && x.shape === root.shape && x.role === root.role &&
      JSON.stringify(x.gap_id) === JSON.stringify(root.gap_id)
  }
  return (r: Row): boolean => r.root === undefined || r.root === root.id || sameGap(String(r.root))
}

export const choices = async (shared: Row[], roots: Array<{ root: Row; rows: Row[]; awaits?: boolean; dues?: number[] }>, now = Date.now(), answers: Record<string, string> = {}, arm?: Row, head?: number, held?: Held): Promise<Option[]> => {
  const out: Option[] = []
  const waits = new Map<string, Option>()
  const moving = new Set<string>()
  let overdue = false
  const everyRoot = new Set(shared.map((r) => r.id))
  for (const { root, rows, awaits, dues } of roots) {
    const ids = new Set(rows.map((r) => r.id))
    // The pool is what the root's producers are handed; its moves are worked out over the part that is its work. What
    // every root shares (the owner's configuration, earned templates) is about no one root, so it stays in both.
    const pool = [...shared.filter((r) => !ids.has(r.id)), ...rows].sort((x, y) => x.seq - y.seq)
    const mine = worksOn(root, rows)
    const work = pool.filter((r) => everyRoot.has(r.id) || mine(r))
    const skipped: Skipped[] = []
    const seen: Seen = { awaits, dues, shared: new Set(shared.filter((r) => !ids.has(r.id)).map((r) => r.id)), root: root.id, head }
    // THE WALK'S ARM BESIDE OPEN ROOTS OFFERS ONLY WHAT ITS RHYTHMS MADE DUE. A rhythm is counted against the store's
    // head, not against idling, so a detector it schedules runs while requests stay open; offered only on the idle arm,
    // it never ran while any root was open. Beside other roots the arm's wait and its other produces are not offered:
    // they are idling, which is for when nothing else is open. Its due moves go through the same root draw, cell and
    // posterior as when it idles. Held back for the roots' work, the arm is not a root with no move, so no stall is said.
    const armBeside = roots.length > 1 && (awaits === false || (awaits === undefined && root.shape === ARM))
    const found = await applicable(work, skipped, now, seen, answers)
    const cands = armBeside ? found.filter((c) => c.rhythm === true) : found
    if (cands.length > 0 || armBeside) { held?.moving.add(root.id); moving.add(root.id) }
    else if (skipped.length > 0) held?.still.push({ root: root.id, pool, skipped })
    overdue = overdue || seen.overdue === true
    const gated = seen.gated
    const frontier = seen.frontier
    // A move's cell is the move in what it reads: the shapes of rows the walk did not write itself that the move consumes
    // (cand.reads), then the root's asker and age. Keyed on every shape in the pool, as it was, any new shape anywhere (an
    // owner's new row kind, a grade nothing here reads) made every cell of every root new and its learning start over.
    const present = new Set(work.filter((r) => r.writer !== VESSEL_ID).map((r) => r.shape))
    const tail = [`asker:${String(root.role)}`, `age:${ageBucket(root, now)}`]
    // The root's own cell: its kind and asker, then the root itself, so records' levels give root, then kind and asker,
    // then kind. Records grades a root by the selections that carry it; a wait spends nothing, so it carries none.
    const rootCell = `root:${String(root.shape)}|asker:${String(root.role)},id:${root.id}`
    for (const cand of cands) {
      const context = [...[...new Set(cand.reads ?? [])].filter((s) => present.has(s)).sort(), ...tail]
      const o: Option = { cand, pool, context, cell: [cand.id, context.join(",")].join("|"), skipped, root: root.id, gated, frontier,
        ...(cand.kind !== WAIT_FOR ? { rootCell } : {}) }
      if (cand.kind !== WAIT_FOR) { out.push(o); continue }
      const seen = waits.get(cand.id)
      const until = (c: Cand): number => Number(c.pointer.until ?? Number.POSITIVE_INFINITY)
      if (!seen || until(cand) < until(seen.cand)) waits.set(cand.id, o)
    }
  }
  // The walk makes one move at a time, so a wait holds every root until it ends: it is offered only when no root has
  // anything else to do. One request's long deadline must not park the walk while another root has a move.
  // A root whose first deadline has passed offers no wait of its own: grading the lapse is its move. Nor may another
  // root's wait be taken then, or a wait with no bound (an idle or gap root's) would keep that lapse ungraded until a row
  // happened to come.
  // A WAIT ENDS BY THE NEXT STALL DUE. A root with no move is said once its newest row is the owner's every_ms behind
  // (stalls, below), but the walk writes nothing while it waits, and a wait with no deadline ahead outlasts that clock:
  // the root went unsaid for as long as the wait's own bound. So whichever wait is offered, a root's or the idle one,
  // ends by the earliest time a root with no move, not yet said since its last change, falls due. A root with any move
  // (a wait included) is not counted. With no rhythm row naming the stall, no wait is changed.
  const due = stallDue(shared, roots.filter(({ root }) => !moving.has(root.id)), now)
  const capped = (o: Option): Option => {
    if (due === undefined) return o
    const until = Math.max(now, Math.min(Number(o.cand.pointer.until ?? Number.POSITIVE_INFINITY), due))
    return { ...o, cand: { ...o.cand, pointer: { ...o.cand.pointer, until } } }
  }
  const offered = out.length > 0 ? out : overdue ? [] : [...waits.values()].map(capped)
  if (offered.length > 0 || roots.length === 0) return offered
  // Nothing to do on any root (every produce pending, nothing to call, no wait offered): the walk waits for the next row
  // rather than having no move. A deadline still ahead bounds it, since one passing makes a lapse gradable. This wait is
  // the walk idling, about no root: it is the walk's arm's, as records names idling when no root is open. Labelled with
  // a root's id, its selection (and any failure ending it) was read back as that root's row, and its cell learned as if
  // waiting were that root's move. With no arm to name it by, there is no idle move.
  if (arm === undefined) return []
  const ahead = roots.flatMap(({ root, rows }) => rows.filter(worksOn(root, rows))).filter((r) => r.shape === DUE && r.role === DESCRIBED && typeof r.at === "number" && r.at > now)
    .map((r) => Number(r.at))
  const pool = [...shared, arm].sort((x, y) => x.seq - y.seq)
  const cand: Cand = { pointer: { shapes: [], ...(ahead.length > 0 ? { until: Math.min(...ahead) } : {}) }, calls: [], t: "", id: WAIT_FOR, kind: WAIT_FOR }
  const context = ["idle"]
  return [capped({ cand, pool, context, cell: [cand.id, context.join(",")].join("|"), skipped: [], root: arm.id })]
}

/**
 * Which option to take: a root first, uniformly among the roots with a move, then a move within it by its posterior. A
 * root whose many cells score well cannot take every draw from one with a single move, and every root is drawn. Both
 * from the seed the selection records, so the choice can be replayed.
 */
export const choose = (seed: number, options: Array<{ root: string }>, posts: Post[]): number => {
  const roots = [...new Set(options.map((o) => o.root))]
  const root = roots[pick(seed, roots.length)]
  const its = options.flatMap((o, j) => (o.root === root ? [j] : []))
  return its[draw(seed, its.map((j) => posts[j]))]
}

// A records that does not know roots answers its single episode as a list: worked as one root, its first row.
export const asEpisodes = (read: unknown): Episodes =>
  Array.isArray(read) ? { shared: [], roots: read.length > 0 ? [{ root: read[0] as Row, rows: read as Row[] }] : [] } : (read as Episodes)

// What records answers is data only when it is the shape the walk asked for. While records restarts, discovery can answer
// a read with a 200 that is no row at all (records re-registers within seconds). Taken as data, the walk's arm was
// "undefined" and its as_of_seq NaN, so no fold filter matched and every draw was made from no evidence; an answer that
// was no episode stopped the loop. Anything else is read again after a pause, never used, and said every 20 s with how
// long it has lasted. A wait has an end, well past a re-register gap (seconds): after READ_WAIT_MS of wrong answers the
// walk stops with a line naming what it got (its keys, never its values) and a non-zero exit, so its unit restarts it
// and the restart counter shows the fault, rather than the loop parking silently on a records that keeps answering
// something else.
const isObject = (a: unknown): a is Record<string, unknown> => !!a && typeof a === "object" && !Array.isArray(a)
export const isArm = (a: unknown): a is Row =>
  isObject(a) && typeof a.arm === "string" && a.arm !== "" && typeof a.as_of_seq === "number" && Number.isFinite(a.as_of_seq)
export const isEpisodes = (a: unknown): boolean =>
  Array.isArray(a) || (isObject(a) && Array.isArray(a.roots) && Array.isArray(a.shared))
export const isPosterior = (cells: number) => (a: unknown): boolean =>
  isObject(a) && typeof a.at_seq === "number" && Number.isFinite(a.at_seq) && Array.isArray(a.posts) && a.posts.length === cells
const SAY_EVERY_MS = 20_000
export { READ_WAIT_MS }
// What an answer was, without its values: a list and its length, an object's keys, or its type.
export const shapeOf = (a: unknown): string =>
  Array.isArray(a) ? `a list of ${a.length}` : isObject(a) ? `an object with keys [${Object.keys(a).slice(0, 12).join(",")}]` : String(a === null ? "null" : typeof a)
export const readUntil = async (read: () => Promise<unknown>, ok: (a: unknown) => boolean, what: string,
  pause: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms), now: () => number = Date.now,
  giveUp: () => void = () => process.exit(1)): Promise<unknown | undefined> => {
  const start = now()
  for (let said = -Infinity; ; ) {
    const a = await read()
    if (ok(a)) return a
    const waited = now() - start
    if (waited >= READ_WAIT_MS) {
      console.error(`[walk] records answered no ${what} for ${Math.round(waited / 1000)} s (last: ${shapeOf(a)}); stopping so the unit restarts`)
      giveUp()
      return undefined
    }
    if (waited - said >= SAY_EVERY_MS) {
      console.log(`[walk] records answered no ${what}; reading again (${Math.round(waited / 1000)} s)`)
      said = waited
    }
    if (stopped()) return undefined
    await pause(READ_AGAIN_MS)
  }
}

/** How long each part of one tick took (ms) and how many reads each read needed, for the selection row. */
export type Timing = { episodes_ms: number; episodes_reads: number; choices_ms: number; posterior_ms: number; posterior_reads: number; draw_ms: number; cands: number; cells: number }

/**
 * The selection row for the option the draw chose. What the tick cost is kept apart, in timing: no key the walk or
 * records compares reads it (the cell and its context, pool_refs, input_refs, a, from, root), so two ticks that differ
 * only in how long they took make the same choice look the same.
 */
export const selectionRow = (arm: string, options: Option[], post: { at_seq: number; posts: Post[] }, seed: number, i: number, timing: Timing): Record<string, unknown> => {
  const { cand: a, context, root } = options[i]
  return {
    shape: SELECTION,
    arm,
    cands: options.map((o) => ({ id: o.cand.id, kind: o.cand.kind, root: o.root })),
    // Each draw's posterior as records gave it, with the level of evidence it came from, so how a choice was made (its
    // own cell's record, or a coarser one's) can be judged later from the row.
    posts: post.posts.map((p) => ({ alpha: p.alpha, beta: p.beta, ...(typeof p.from === "string" ? { from: p.from } : {}) })),
    posts_seq: post.at_seq,
    seed,
    a: a.id,
    ...(a.from ? { from: a.from } : {}),
    ...(a.out_of_scope ? { out_of_scope: true } : {}),
    cell: options[i].cell,
    context,
    // Which way the cell was keyed: "reads" (the move's own inputs). Before it, every shape in the root's pool.
    cell_scheme: "reads",
    root,
    ...(options[i].rootCell !== undefined ? { root_cell: options[i].rootCell } : {}),
    // The root's newest made row and the calls that take it (applicable.ts), so what a request was allowed is on the row.
    ...(options[i].frontier !== undefined ? frontierFields(options[i].frontier!) : {}),
    // What the selection is about: its root. The rows the move had are handed to its call (a produce, a run) and not
    // kept here: kept, each selection carried every id of its root's episode, so rows grew with the episode and each
    // read with the rows. What a produce saw is kept as its key (seen_key), which is what a refusal is compared by.
    pool_refs: [root],
    ...(typeof a.seen_key === "string" ? { seen_key: a.seen_key } : {}),
    timing,
  }
}

// What the walk writes on its selection for other readers (the fold's replay of a draw, the page, a retrospective, any
// reader by id) and never reads back from its episodes: every candidate of the draw, their posteriors, and the tick's
// timing. They grow with the options a tick has and were most of each tick's episodes answer, so the walk names them on
// that read and records leaves them out of the selections it wrote itself, marking each row (fields_omitted). The
// stored row keeps them. A field read from an episode row must never be named here (test/omit.test.ts).
export const UNREAD: Record<string, string[]> = { [SELECTION]: ["cands", "posts", "timing"] }

// A ROOT WITH NO MOVE IS SAID (law 6: the class 82ac fell into, an open root offering nothing, silently, for hours).
// When the owner's stall_rule names after_rows N, a root that offers no move this tick (not even a wait: a root waiting
// on a person offers its wait), whose newest row is N or more store rows behind this tick's selection, gets one failure
// row of kind stall, naming the root, N and the seq it counted from. Records keeps that row among the root's rows (it
// cites the root), and its producers are shown it once. It is said ONCE PER CHANGE: the count runs from the root's
// newest row that is not one of the walk's own stall rows, and a root whose stall row is already newer than that row
// is not said again. Restating a root nothing has changed in re-offers its producers the same rows, which make the
// same refusal. A new row in the root (a person's, a deadline, a held reason, a call) is news to its producers by the
// rules that offer news, and once it too sits N rows the root is said again. It blames no one and closes nothing: a
// kind (the walk's own word, as a skip is), no status, never a grade or a lapse. Counted in store rows, the unit a
// detector's quiet window is counted in, from seqs the walk already holds: no read is made. Derived from rows alone, so
// it replays over any past window. With no stall_rule, nothing is written.
// THE STALL CLOCK IS ALSO TIME. A count in store rows stops when the walk does: parked on one wait it writes a few rows
// an hour, and a root with no move sat a day before N rows came. The owner's rhythm row naming the stall
// ({target: "stall", every_ms}) says a root once its newest counted row is every_ms or more old by that row's own t,
// against the tick's now; whichever count is reached first says it. Read at use time like the rule; with no such row,
// or one retired, the store-row count alone applies, as before. Replays from the rows and their t.
// A ROOT SAID AGAIN AND AGAIN WITH NOTHING CHANGING ENDS ITS ATTEMPT (the USER: "a root said stalled S times with no
// change ends as failed"). When the stall_rule also names ends_after S, a said root is said again each period (after_rows
// store rows, or every_ms, from its last stall row) while nothing of its own changes, and the S-th stall row since its
// last change also ends the attempt: one row per selection of a produce made since the first of those stall rows (each
// answer moved nothing), {ends: "stall", selection_ref}, which records reads as blaming the request, so each such cell is
// charged once through the one debit path; with no such selection, one row citing none, which charges no one. An ended
// root is not said again and bounds no wait. Its gap is never touched: it stays open, and the root wakes, counted afresh,
// on a row of its own (a change) or on an owner's install of its repo or of the walk written after the end, the news
// that something it could not do may now be done. A root waiting on a person (a row of its own saying waits_for person,
// no person's row since) is never ended and is said once per change, as before (the USER: changes waiting on the
// person's verdict are shown on the person's page and wait until the person decides). With no ends_after, a root is
// said once per change, as before.
type Clock = { rows?: number; ms?: number; ends?: number }
const stallClock = (shared: Row[]): Clock => {
  const newest = (f: (r: Row) => boolean): Row | undefined => shared.filter((r) => r.role === OWNER && f(r)).sort((a, b) => a.seq - b.seq).at(-1)
  const rule = newest((r) => r.shape === STALL_RULE)
  const rhythm = newest((r) => r.shape === RHYTHM && r.target === STALL)
  const n = Number(rule?.after_rows)
  // every_ms is a number or no clock: a string is not read as one
  const ms = typeof rhythm?.every_ms === "number" ? rhythm.every_ms : Number.NaN
  const s = rule?.ends_after
  const live = rule !== undefined && rule.retired !== true
  return {
    ...(live && Number.isInteger(n) && n >= 1 ? { rows: n } : {}),
    ...(live && typeof s === "number" && Number.isInteger(s) && s >= 1 ? { ends: s } : {}),
    ...(rhythm !== undefined && rhythm.retired !== true && Number.isFinite(ms) && ms >= 1 ? { ms } : {}),
  }
}

// A root's newest counted row (its work, past the walk's own stall rows and its producers' answers to them), and whether
// it was already said since. Only the root's work counts: a row made on another root is shown to its producers, never
// news here (worksOn).
const said = (r: Row): boolean => r.shape === FAILURE && r.role === WALK && r.kind === STALL && r.selection_ref === undefined
// The walk's own end of an attempt: never a change.
const ended = (r: Row): boolean => r.shape === FAILURE && r.role === WALK && r.ends === STALL
const sat = (root: Row, all: Row[]): { row: Row; said: boolean } => {
  const rows = all.filter(worksOn(root, all))
  // WHAT THE WALK'S OWN PRODUCERS SAY IN ANSWER TO BEING SAID IS NOT A CHANGE. A stall row is news to the root's
  // producers once, so one is offered again; with nothing to do it declines, and counted as a change that decline
  // restarted the count, and the root was said again every N rows. A row made under a produce selection made after a
  // stall row with no change of the root's since (the selection, its hops and facts, the row it produced) is that
  // answer; with the root said again each period, an answer to an earlier stall row is one too. What follows from it
  // still is a change: a call it asked for runs under a call selection, and rows from outside the walk carry no
  // selection of a produce. A tick writes its selection before its stall rows, so a produce answering a stall is always
  // under a newer selection; one already in flight when the root was said is under an older one, and counts. What the
  // walk itself held back from that answer is the answer too (below). Read in store order, one pass.
  // A root never said has no answer to give: every row of it counts, as before.
  const answers = new Set<string>()
  let stalled = false
  let row = root
  for (const r of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (said(r)) { stalled = true; continue }
    if (ended(r)) continue
    const under = r.shape === SELECTION ? r.id : String(r.selection_ref)
    if (r.shape === SELECTION && stalled && String(r.a).startsWith(`${PRODUCE}/`)) answers.add(r.id)
    // A reason the walk held back that answer for (its own row, under no selection: a root with no move is not drawn)
    // names the request it holds back (request_ref): when that request is the answer, so is the held reason. One step
    // only: the request named must itself be under that produce, so no chain of the walk's own rows hides a change.
    if (answers.has(under)) { answers.add(`req:${r.id}`); continue }
    if (r.role === WALK && r.selection_ref === undefined && typeof r.request_ref === "string" && answers.has(`req:${r.request_ref}`)) continue
    if (r.seq > row.seq) row = r
    stalled = false
  }
  return { row, said: rows.some((r) => said(r) && r.seq > row.seq) }
}

const bySeq = (a: Row, b: Row): number => a.seq - b.seq
// Where a root's count runs from (its newest counted row, or the install that woke it after an end), its stall rows
// since, whether it ends, and the row the next say is counted from (none: not said again, or ended).
type Stall = { base: Row; said: Row[]; ends?: number; from?: Row }
const stallOf = (shared: Row[], root: Row, all: Row[], c: Clock): Stall => {
  const { row } = sat(root, all)
  // the root's own rows: a gap's rows of the same gap_id, the detector having written it again, are its own (worksOn)
  const rows = all.filter(worksOn(root, all))
  const end = rows.filter((r) => ended(r) && r.seq > row.seq).sort(bySeq).at(-1)
  const wake = end === undefined ? undefined
    : [...shared, ...rows].filter((x) => x.shape === INFRA_WINDOW && x.role === OWNER && x.seq > end.seq && installsRepoOrWalk([x], root.repo)).sort(bySeq).at(-1)
  if (end !== undefined && wake === undefined) return { base: row, said: [] }
  const base = wake ?? row
  const stalled = rows.filter((r) => said(r) && r.seq > base.seq).sort(bySeq)
  const person = rows.some((r) => r.waits_for === "person" && !rows.some((p) => p.role === PERSON && p.seq > r.seq))
  const ends = person ? undefined : c.ends
  const from = stalled.length === 0 ? base : ends !== undefined ? stalled.at(-1) : undefined
  return { base, said: stalled, ...(ends !== undefined ? { ends } : {}), ...(from !== undefined ? { from } : {}) }
}

// When the time clock next says a root among these (the earliest newest-row t plus every_ms of a root not yet said), or
// undefined with no time clock or no such root.
export const stallDue = (shared: Row[], roots: Array<{ root: Row; rows: Row[] }>, now: number): number | undefined => {
  const c = stallClock(shared)
  const { ms } = c
  if (ms === undefined || !Number.isFinite(now)) return undefined
  const dues = roots.map(({ root, rows }) => stallOf(shared, root, rows, c).from).filter((x): x is Row => x !== undefined)
    .map((x) => Date.parse(String(x.t)) + ms).filter(Number.isFinite)
  return dues.length > 0 ? Math.min(...dues) : undefined
}

// now is required: the time clock says nothing without the tick's time, and a caller that left it out would compile.
export const stalls = (shared: Row[], roots: Array<{ root: Row; rows: Row[] }>, options: Array<{ root: string }>, at: number, now: number): Array<Record<string, unknown>> => {
  const c = stallClock(shared)
  const { rows: n, ms } = c
  if (n === undefined && ms === undefined) return []
  const moving = new Set(options.map((o) => o.root))
  const out: Array<Record<string, unknown>> = []
  for (const { root, rows } of roots.filter(({ root }) => !moving.has(root.id))) {
    const { base, said: stalled, ends, from } = stallOf(shared, root, rows, c)
    if (from === undefined) continue
    const byRows = n !== undefined && Number.isFinite(at) && at - from.seq >= n
    const t = Date.parse(String(from.t))
    const byTime = ms !== undefined && Number.isFinite(now) && Number.isFinite(t) && now - t >= ms
    if (!byRows && !byTime) continue
    const last = stalled.at(-1)
    out.push({ shape: FAILURE, kind: STALL, root: root.id, ...(n !== undefined ? { rows: n } : {}),
      since_seq: base.seq, ...(byTime ? { every_ms: ms, since_t: base.t } : {}),
      ...(ends !== undefined ? { said: stalled.length + 1, ends_after: ends } : {}), input_refs: [root.id] })
    if (ends === undefined || stalled.length + 1 < ends) continue
    // the answers since the first of these stall rows: each moved nothing
    const first = stalled[0]?.seq ?? Number.POSITIVE_INFINITY
    const refs = [root.id, ...(last !== undefined ? [last.id] : [])]
    const answers = rows.filter((r) => r.shape === SELECTION && r.role === WALK && r.seq > first && String(r.a).startsWith(`${PRODUCE}/`)).sort(bySeq)
    for (const s of answers) out.push({ shape: FAILURE, ends: STALL, root: root.id, selection_ref: s.id, input_refs: refs })
    if (answers.length === 0) out.push({ shape: FAILURE, ends: STALL, root: root.id, input_refs: refs })
  }
  return out
}

export const chain = async (): Promise<void> => {
  const armRow = (await readUntil(() => loopCall(RECORD_WAIT_EXACT, { shapes: [ARM], after_seq: 0, where: { vessel_id: VESSEL_ID } }), isArm, "arm row")) as Row | undefined
  if (armRow === undefined) return
  const arm = String(armRow.arm)
  const asOf = Number(armRow.as_of_seq)
  // The store's latest seq as records said it on the last tick (its posterior's at_seq): what a rhythm counts against.
  let head: number | undefined
  // whether this tick's read follows one that wrote held reasons (below)
  let reread = false
  while (!stopped()) {
    // Each part of the tick is timed and each read's tries counted, so where a tick's time goes is on its row.
    const ms = (t0: number) => Math.round(performance.now() - t0)
    let episodesReads = 0
    let posteriorReads = 0
    const t0 = performance.now()
    // arm "beside": records hands the walk's arm after the open roots too, so a rhythm the arm made due is offered while
    // requests stay open (choices offers it there only its rhythm moves).
    const read = await readUntil(() => { episodesReads++; return loopCall(RECORD_READ, { episode: VESSEL_ID, roots: "all", omit: UNREAD, arm: "beside" }) }, isEpisodes, "episodes")
    if (read === undefined) return
    const episodesMs = ms(t0)
    const { shared, roots } = asEpisodes(read)
    const t1 = performance.now()
    const held: Held = { moving: new Set(), still: [] }
    const now = Date.now()
    const options = await choices(shared, roots, now, await shapeAnswers(), armRow, head, held)
    const choicesMs = ms(t1)
    // A root with no move at all still says what it holds back and why, once per reason (recordSkipped keeps to that): a
    // request held by a gate or as a repeat is otherwise never written, so its producer, never shown why, is never offered
    // again, and the root sits with no move. No selection: the tick's selection is another root's. Said BEFORE THE DRAW:
    // a reason is news to its root's producer only once read, and written after a draw that had nothing else to do it sat
    // unread until the idle wait's bound, since the walk's own rows end no wait (15 minutes on every told root). So a tick
    // that wrote one reads again, once, and the draw sees them. The re-read writes none: what it would say is what was
    // just written, or is said on the next tick, so no reason is written twice in a tick whatever the read shows.
    let wrote = 0
    if (!reread) for (const h of held.still) wrote += await recordSkipped(h.pool, h.skipped, undefined, h.root)
    reread = wrote > 0
    if (reread) continue
    const cells = options.map((o) => o.cell)
    const t2 = performance.now()
    const post = (await readUntil(() => { posteriorReads++; return loopCall(POSTERIOR, { cells, as_of_seq: asOf }) }, isPosterior(cells.length), "posterior")) as
      { at_seq: number; posts: Post[] } | undefined
    if (post === undefined) return
    head = post.at_seq
    const posteriorMs = ms(t2)
    const t3 = performance.now()
    const seed = Date.now() >>> 0
    const i = choose(seed, options, post.posts)
    const { cand: a, pool, skipped } = options[i]
    const sel = await writeRow(selectionRow(arm, options, post, seed, i, {
      episodes_ms: episodesMs, episodes_reads: episodesReads, choices_ms: choicesMs, posterior_ms: posteriorMs,
      posterior_reads: posteriorReads, draw_ms: ms(t3), cands: options.length, cells: new Set(cells).size,
    }))
    await recordSkipped(pool, skipped, sel)
    // No selection_ref on a stall row: the tick's selection is another root's move, and records reads a walk failure's
    // selection_ref as that move having failed. A root with any move, a wait included, is not stalled.
    for (const row of stalls(shared, roots, [...options, ...[...held.moving].map((root) => ({ root }))], Number(sel.seq), now)) await writeRow(row)
    // A produce is also shown what its request has done (acts.ts): a row recomputed from the pool, written on change.
    const fact = a.kind === PRODUCE ? await actsFactRow(pool, options[i].root, writeRow, sel.id, options[i].gated, options[i].frontier) : undefined
    await execute(a, sel, [...pool.map((r) => r.id), ...(fact !== undefined && !pool.some((r) => r.id === fact) ? [fact] : [])])
  }
}
