// SPDX-License-Identifier: MIT
import { actsFactRow } from "./acts"
import { type Seen, type Skipped, applicable } from "./applicable"
import { type Cand, READ_AGAIN_MS, READ_WAIT_MS, type Row, execute, loopCall, recordSkipped, shapeAnswers, stopped, writeRow } from "./calls"
import { VESSEL_ID } from "./config"
import { type Post, draw, pick } from "./draw"
import { ARM, DESCRIBED, DUE, FAILURE, OWNER, POSTERIOR, PRODUCE, RECORD_READ, RECORD_WAIT_EXACT, SELECTION, STALL, STALL_RULE, WAIT_FOR, WALK } from "./shapes"

type Episodes = { shared: Row[]; roots: Array<{ root: Row; rows: Row[]; awaits?: boolean }> }
type Option = { cand: Cand; pool: Row[]; context: string[]; cell: string; skipped: Skipped[]; root: string; gated?: Record<string, string[]>; rootCell?: string }

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

export const choices = async (shared: Row[], roots: Array<{ root: Row; rows: Row[]; awaits?: boolean }>, now = Date.now(), answers: Record<string, string> = {}, arm?: Row, head?: number, held?: Held): Promise<Option[]> => {
  const out: Option[] = []
  const waits = new Map<string, Option>()
  let overdue = false
  const everyRoot = new Set(shared.map((r) => r.id))
  for (const { root, rows, awaits } of roots) {
    const ids = new Set(rows.map((r) => r.id))
    // The pool is what the root's producers are handed; its moves are worked out over the part that is its work. What
    // every root shares (the owner's configuration, earned templates) is about no one root, so it stays in both.
    const pool = [...shared.filter((r) => !ids.has(r.id)), ...rows].sort((x, y) => x.seq - y.seq)
    const mine = worksOn(root, rows)
    const work = pool.filter((r) => everyRoot.has(r.id) || mine(r))
    const skipped: Skipped[] = []
    const seen: Seen = { awaits, shared: new Set(shared.filter((r) => !ids.has(r.id)).map((r) => r.id)), root: root.id, head }
    const cands = await applicable(work, skipped, now, seen, answers)
    if (cands.length > 0) held?.moving.add(root.id)
    else if (skipped.length > 0) held?.still.push({ root: root.id, pool, skipped })
    overdue = overdue || seen.overdue === true
    const gated = seen.gated
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
      const o: Option = { cand, pool, context, cell: [cand.id, context.join(",")].join("|"), skipped, root: root.id, gated,
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
  const offered = out.length > 0 ? out : overdue ? [] : [...waits.values()]
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
  return [{ cand, pool, context, cell: [cand.id, context.join(",")].join("|"), skipped: [], root: arm.id }]
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
    cell: options[i].cell,
    context,
    // Which way the cell was keyed: "reads" (the move's own inputs). Before it, every shape in the root's pool.
    cell_scheme: "reads",
    root,
    ...(options[i].rootCell !== undefined ? { root_cell: options[i].rootCell } : {}),
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
export const stalls = (shared: Row[], roots: Array<{ root: Row; rows: Row[] }>, options: Array<{ root: string }>, at: number): Array<Record<string, unknown>> => {
  const rule = shared.filter((r) => r.shape === STALL_RULE && r.role === OWNER).sort((a, b) => a.seq - b.seq).at(-1)
  const n = Number(rule?.after_rows)
  if (rule === undefined || rule.retired === true || !Number.isInteger(n) || n < 1 || !Number.isFinite(at)) return []
  const moving = new Set(options.map((o) => o.root))
  const said = (r: Row): boolean => r.shape === FAILURE && r.role === WALK && r.kind === STALL && r.selection_ref === undefined
  const out: Array<Record<string, unknown>> = []
  for (const { root, rows: all } of roots.filter(({ root }) => !moving.has(root.id))) {
    // Only the root's work counts: a row made on another root is shown to its producers, never news here (worksOn).
    const rows = all.filter(worksOn(root, all))
    // WHAT THE WALK'S OWN PRODUCERS SAY IN ANSWER TO BEING SAID IS NOT A CHANGE. A stall row is news to the root's
    // producers once, so one is offered again; with nothing to do it declines, and counted as a change that decline
    // restarted the count, and the root was said again every N rows. A row made under a produce selection newer than
    // the root's newest stall row (the selection, its hops and facts, the row it produced) is that answer. What follows
    // from it still is a change: a call it asked for runs under a call selection, and rows from outside the walk carry
    // no selection of a produce. A tick writes its selection before its stall rows, so a produce answering a stall is
    // always under a newer selection; one already in flight when the root was said is under an older one, and counts.
    // What the walk itself held back from that answer is the answer too (below).
    // A root never said has no answer to give: every row of it counts, as before.
    const last = Math.max(-Infinity, ...rows.filter(said).map((r) => r.seq))
    const sels = new Map(rows.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
    const produced = (r: Row | undefined): boolean => {
      const s = r === undefined ? undefined : r.shape === SELECTION ? r : sels.get(String(r.selection_ref))
      return Number.isFinite(last) && s !== undefined && s.seq > last && String(s.a).startsWith(`${PRODUCE}/`)
    }
    // A reason the walk held back that answer for (its own row, under no selection: a root with no move is not drawn)
    // names the request it holds back (request_ref): when that request is the answer, so is the held reason. One step
    // only: the request named must itself be under that produce, so no chain of the walk's own rows hides a change.
    const byId = new Map(rows.map((r) => [r.id, r]))
    const answer = (r: Row): boolean => produced(r) ||
      (r.role === WALK && r.selection_ref === undefined && typeof r.request_ref === "string" && produced(byId.get(r.request_ref)))
    const newest = Math.max(root.seq, ...rows.filter((r) => !said(r) && !answer(r)).map((r) => r.seq))
    if (rows.some((r) => said(r) && r.seq > newest)) continue
    if (at - newest >= n) out.push({ shape: FAILURE, kind: STALL, root: root.id, rows: n, since_seq: newest, input_refs: [root.id] })
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
  while (!stopped()) {
    // Each part of the tick is timed and each read's tries counted, so where a tick's time goes is on its row.
    const ms = (t0: number) => Math.round(performance.now() - t0)
    let episodesReads = 0
    let posteriorReads = 0
    const t0 = performance.now()
    const read = await readUntil(() => { episodesReads++; return loopCall(RECORD_READ, { episode: VESSEL_ID, roots: "all", omit: UNREAD }) }, isEpisodes, "episodes")
    if (read === undefined) return
    const episodesMs = ms(t0)
    const { shared, roots } = asEpisodes(read)
    const t1 = performance.now()
    const held: Held = { moving: new Set(), still: [] }
    const options = await choices(shared, roots, Date.now(), await shapeAnswers(), armRow, head, held)
    const choicesMs = ms(t1)
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
    // A root with no move at all still says what it holds back and why, once per reason (recordSkipped keeps to that): a
    // request held by a gate or as a repeat is otherwise never written, so its producer, never shown why, is never offered
    // again, and the root sits with no move. No selection: the tick's selection is another root's.
    for (const h of held.still) await recordSkipped(h.pool, h.skipped, undefined, h.root)
    // No selection_ref on a stall row: the tick's selection is another root's move, and records reads a walk failure's
    // selection_ref as that move having failed. A root with any move, a wait included, is not stalled.
    for (const row of stalls(shared, roots, [...options, ...[...held.moving].map((root) => ({ root }))], Number(sel.seq))) await writeRow(row)
    // A produce is also shown what its request has done (acts.ts): a row recomputed from the pool, written on change.
    const fact = a.kind === PRODUCE ? await actsFactRow(pool, options[i].root, writeRow, sel.id, options[i].gated) : undefined
    await execute(a, sel, [...pool.map((r) => r.id), ...(fact !== undefined && !pool.some((r) => r.id === fact) ? [fact] : [])])
  }
}
