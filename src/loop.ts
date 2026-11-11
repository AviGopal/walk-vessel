// SPDX-License-Identifier: MIT
import { applicable } from "./applicable"
import { type Row, execute, loopCall, writeRow } from "./calls"
import { VESSEL_ID } from "./config"
import { type Post, draw } from "./draw"
import { ARM, POSTERIOR, RECORD_READ, RECORD_WAIT_EXACT, SELECTION } from "./shapes"

export const chain = async (): Promise<void> => {
  const armRow = (await loopCall(RECORD_WAIT_EXACT, { shapes: [ARM], after_seq: 0, where: { vessel_id: VESSEL_ID } })) as Row
  const arm = String(armRow.arm)
  const asOf = Number(armRow.as_of_seq)
  while (true) {
    const pool = (await loopCall(RECORD_READ, { episode: VESSEL_ID })) as Row[]
    const cands = await applicable(pool)
    const context = [...new Set(pool.filter((r) => r.writer !== VESSEL_ID).map((r) => r.shape))].sort()
    const cells = cands.map((c) => [c.id, context.join(",")].join("|"))
    const post = (await loopCall(POSTERIOR, { cells, as_of_seq: asOf })) as { at_seq: number; posts: Post[] }
    const seed = Date.now() >>> 0
    const i = draw(seed, post.posts)
    const a = cands[i]
    const poolRefs = pool.map((r) => r.id)
    const sel = await writeRow({
      shape: SELECTION,
      arm,
      cands: cands.map((c) => ({ id: c.id, kind: c.kind })),
      posts: post.posts.map((p) => ({ alpha: p.alpha, beta: p.beta })),
      posts_seq: post.at_seq,
      seed,
      a: a.id,
      ...(a.from ? { from: a.from } : {}),
      cell: cells[i],
      context,
      pool_refs: poolRefs,
      input_refs: poolRefs,
    })
    await execute(a, sel)
  }
}
