// SPDX-License-Identifier: MIT
import { type Seen, type Skipped, applicable } from "./applicable"
import { type Cand, type Row, execute, loopCall, recordSkipped, writeRow } from "./calls"
import { VESSEL_ID } from "./config"
import { type Post, draw } from "./draw"
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
export const choices = async (shared: Row[], roots: Array<{ root: Row; rows: Row[]; awaits?: boolean }>, now = Date.now()): Promise<Option[]> => {
  const out: Option[] = []
  const waits = new Map<string, Option>()
  let overdue = false
  for (const { root, rows, awaits } of roots) {
    const ids = new Set(rows.map((r) => r.id))
    const pool = [...shared.filter((r) => !ids.has(r.id)), ...rows].sort((x, y) => x.seq - y.seq)
    const skipped: Skipped[] = []
    const seen: Seen = { awaits }
    const cands = await applicable(pool, skipped, now, seen)
    overdue = overdue || seen.overdue === true
    const context = [
      ...[...new Set(pool.filter((r) => r.writer !== VESSEL_ID).map((r) => r.shape))].sort(),
      `asker:${String(root.role)}`, `age:${ageBucket(root, now)}`,
    ]
    for (const cand of cands) {
      const o: Option = { cand, pool, context, cell: [cand.id, context.join(",")].join("|"), skipped, root: root.id }
      if (cand.kind !== WAIT_FOR) { out.push(o); continue }
      const seen = waits.get(cand.id)
      const until = (c: Cand): number => Number(c.pointer.until ?? Number.POSITIVE_INFINITY)
      if (!seen || until(cand) < until(seen.cand)) waits.set(cand.id, o)
    }
  }
  // A root whose first deadline has passed offers no wait of its own: grading the lapse is its move. Nor may another
  // root's wait be taken then, or a wait with no bound (an idle or gap root's) would keep that lapse ungraded until a row
  // happened to come.
  const offered = [...out, ...(overdue ? [] : waits.values())]
  if (offered.length > 0 || roots.length === 0) return offered
  // Nothing to do on any root (every produce pending, nothing to call, no wait offered): the walk waits for the next row
  // rather than having no move. A deadline still ahead bounds it, since one passing makes a lapse gradable.
  const ahead = roots.flatMap(({ rows }) => rows).filter((r) => r.shape === DUE && r.role === DESCRIBED && typeof r.at === "number" && r.at > now)
    .map((r) => Number(r.at))
  const { root, rows } = roots[0]
  const pool = [...shared, ...rows].sort((x, y) => x.seq - y.seq)
  const cand: Cand = { pointer: { shapes: [], ...(ahead.length > 0 ? { until: Math.min(...ahead) } : {}) }, calls: [], t: "", id: WAIT_FOR, kind: WAIT_FOR }
  const context = [`asker:${String(root.role)}`, `age:${ageBucket(root, now)}`]
  return [{ cand, pool, context, cell: [cand.id, context.join(",")].join("|"), skipped: [], root: root.id }]
}

// A records that does not know roots answers its single episode as a list: worked as one root, its first row.
export const asEpisodes = (read: unknown): Episodes =>
  Array.isArray(read) ? { shared: [], roots: read.length > 0 ? [{ root: read[0] as Row, rows: read as Row[] }] : [] } : (read as Episodes)

export const chain = async (): Promise<void> => {
  const armRow = (await loopCall(RECORD_WAIT_EXACT, { shapes: [ARM], after_seq: 0, where: { vessel_id: VESSEL_ID } })) as Row
  const arm = String(armRow.arm)
  const asOf = Number(armRow.as_of_seq)
  while (true) {
    const { shared, roots } = asEpisodes(await loopCall(RECORD_READ, { episode: VESSEL_ID, roots: "all" }))
    const options = await choices(shared, roots)
    const cells = options.map((o) => o.cell)
    const post = (await loopCall(POSTERIOR, { cells, as_of_seq: asOf })) as { at_seq: number; posts: Post[] }
    const seed = Date.now() >>> 0
    const i = draw(seed, post.posts)
    const { cand: a, pool, context, skipped, root } = options[i]
    const poolRefs = pool.map((r) => r.id)
    const sel = await writeRow({
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
      cell: cells[i],
      context,
      root,
      pool_refs: poolRefs,
      input_refs: poolRefs,
    })
    await recordSkipped(pool, skipped, sel)
    await execute(a, sel)
  }
}
