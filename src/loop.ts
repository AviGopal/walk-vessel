// SPDX-License-Identifier: MIT
import { type Seen, type Skipped, applicable } from "./applicable"
import { type Cand, type Row, execute, loopCall, recordSkipped, shapeAnswers, stopped, writeRow } from "./calls"
import { VESSEL_ID } from "./config"
import { type Post, draw, pick } from "./draw"
import { ARM, DESCRIBED, DUE, POSTERIOR, RECORD_READ, RECORD_WAIT_EXACT, SELECTION, WAIT_FOR } from "./shapes"

type Episodes = { shared: Row[]; roots: Array<{ root: Row; rows: Row[]; awaits?: boolean }> }
type Option = { cand: Cand; pool: Row[]; context: string[]; cell: string; skipped: Skipped[]; root: string }

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
export const choices = async (shared: Row[], roots: Array<{ root: Row; rows: Row[]; awaits?: boolean }>, now = Date.now(), answers: Record<string, string> = {}, arm?: Row): Promise<Option[]> => {
  const out: Option[] = []
  const waits = new Map<string, Option>()
  let overdue = false
  for (const { root, rows, awaits } of roots) {
    const ids = new Set(rows.map((r) => r.id))
    const pool = [...shared.filter((r) => !ids.has(r.id)), ...rows].sort((x, y) => x.seq - y.seq)
    const skipped: Skipped[] = []
    const seen: Seen = { awaits, shared: new Set(shared.filter((r) => !ids.has(r.id)).map((r) => r.id)) }
    const cands = await applicable(pool, skipped, now, seen, answers)
    overdue = overdue || seen.overdue === true
    // A move's cell is the move in what it reads: the shapes of rows the walk did not write itself that the move consumes
    // (cand.reads), then the root's asker and age. Keyed on every shape in the pool, as it was, any new shape anywhere (an
    // owner's new row kind, a grade nothing here reads) made every cell of every root new and its learning start over.
    const present = new Set(pool.filter((r) => r.writer !== VESSEL_ID).map((r) => r.shape))
    const tail = [`asker:${String(root.role)}`, `age:${ageBucket(root, now)}`]
    for (const cand of cands) {
      const context = [...[...new Set(cand.reads ?? [])].filter((s) => present.has(s)).sort(), ...tail]
      const o: Option = { cand, pool, context, cell: [cand.id, context.join(",")].join("|"), skipped, root: root.id }
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
  const ahead = roots.flatMap(({ rows }) => rows).filter((r) => r.shape === DUE && r.role === DESCRIBED && typeof r.at === "number" && r.at > now)
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
const READ_AGAIN_MS = 2_000
const SAY_EVERY_MS = 20_000
export const READ_WAIT_MS = 60_000
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
    // What the selection is about: its root. The rows the move had are handed to its call (a produce, a run) and not
    // kept here: kept, each selection carried every id of its root's episode, so rows grew with the episode and each
    // read with the rows. What a produce saw is kept as its key (seen_key), which is what a refusal is compared by.
    pool_refs: [root],
    ...(typeof a.seen_key === "string" ? { seen_key: a.seen_key } : {}),
    timing,
  }
}

export const chain = async (): Promise<void> => {
  const armRow = (await readUntil(() => loopCall(RECORD_WAIT_EXACT, { shapes: [ARM], after_seq: 0, where: { vessel_id: VESSEL_ID } }), isArm, "arm row")) as Row | undefined
  if (armRow === undefined) return
  const arm = String(armRow.arm)
  const asOf = Number(armRow.as_of_seq)
  while (!stopped()) {
    // Each part of the tick is timed and each read's tries counted, so where a tick's time goes is on its row.
    const ms = (t0: number) => Math.round(performance.now() - t0)
    let episodesReads = 0
    let posteriorReads = 0
    const t0 = performance.now()
    const read = await readUntil(() => { episodesReads++; return loopCall(RECORD_READ, { episode: VESSEL_ID, roots: "all" }) }, isEpisodes, "episodes")
    if (read === undefined) return
    const episodesMs = ms(t0)
    const { shared, roots } = asEpisodes(read)
    const t1 = performance.now()
    const options = await choices(shared, roots, Date.now(), await shapeAnswers(), armRow)
    const choicesMs = ms(t1)
    const cells = options.map((o) => o.cell)
    const t2 = performance.now()
    const post = (await readUntil(() => { posteriorReads++; return loopCall(POSTERIOR, { cells, as_of_seq: asOf }) }, isPosterior(cells.length), "posterior")) as
      { at_seq: number; posts: Post[] } | undefined
    if (post === undefined) return
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
    await execute(a, sel, pool.map((r) => r.id))
  }
}
