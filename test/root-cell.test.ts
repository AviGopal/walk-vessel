// SPDX-License-Identifier: MIT
// A selection names its root's own cell (root_cell): the root's kind and asker, then the root, so records can count a
// root's progress per draw by the cell the walk wrote, never by a key format of its own. A wait spends nothing and names
// none. The draw itself is not changed by it.
import { beforeAll, describe, expect, test } from "bun:test"

const NODE_KEY = "node-key-for-test"
const now = Date.parse("2026-01-01T12:00:00Z")
const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person", writer: "kid-p", t: "2026-01-01T11:59:30Z" }
const sch = { shape: "shape_schema", id: "s1", seq: 2, role: "owner", writer: "owner", target: "answer", inputs: ["world_changed"], context: ["fileContent"] }
const ch = { shape: "channel", id: "ch1", seq: 3, role: "owner", writer: "owner", calls: [] }
const req = { shape: "request", id: "q1", seq: 4, role: "described", writer: "described-x", pointer: { type: "fileContent", path: "README.md" } }
const tpl = { shape: "activity_template", id: "t-ok", seq: 5, role: "described", writer: "described-x", sig: { in: ["world_changed"], out: ["answer"] },
  calls: [{ shape: "fileContent", pointer: { path: "a" } }, { shape: "answer", pointer: { via_ref: "ch1" } }] }
const ROOT_CELL = "root:world_changed|asker:person,id:w1"

describe("a selection names its root's cell", () => {
  beforeAll(() => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
  })

  test("[MUST-FAIL] every move on a root carries the root's cell (produce, call and run alike), and the selection row writes it", async () => {
    const { choices, selectionRow } = await import("../src/loop")
    const options = await choices([], [{ root: ask as any, rows: [ask, sch, ch, req, tpl] as any }], now)
    const kinds = new Set(options.map((o) => o.cand.id.split("/")[0]))
    expect([...kinds].sort()).toEqual(["call", "produce", "run"])
    for (const o of options) expect(o.rootCell).toBe(ROOT_CELL)
    const post = { at_seq: 5, posts: options.map((o) => ({ cell: o.cell, alpha: 1, beta: 1 })) }
    for (let i = 0; i < options.length; i++) expect(selectionRow("treated", options, post, 7, i, {} as any).root_cell).toBe(ROOT_CELL)
  })

  test("[MUST-FAIL] the root cell's kind and asker are the root row's own shape and role", async () => {
    const { choices } = await import("../src/loop")
    const gap = { shape: "gap", id: "g9", seq: 1, role: "detector", gap_id: "x", status: "open", t: "2026-01-01T11:59:30Z" }
    const sch2 = { ...sch, inputs: ["gap"] }
    const options = await choices([], [{ root: gap as any, rows: [gap, sch2, ch] as any }], now)
    expect(options.length).toBeGreaterThan(0)
    for (const o of options) expect(o.rootCell).toBe("root:gap|asker:detector,id:g9")
  })

  test("[GUARD] a wait names no root cell: a root's own wait and the walk's idle wait alike", async () => {
    const { choices, selectionRow } = await import("../src/loop")
    const due = { shape: "due", id: "d2", seq: 3, role: "described", within_ms: 60_000, at: now + 300_000, input_refs: ["w1"] }
    const arm = { shape: "arm", id: "arm1", seq: 0, role: "walk", arm: "treated" }
    for (const rows of [[ask, due], [ask]]) {
      const got = await choices([], [{ root: ask as any, rows: rows as any }], now, {}, arm as any)
      expect(got.map((o) => o.cand.kind)).toEqual(["wait-for"])
      expect(got[0].rootCell).toBeUndefined()
      expect("root_cell" in selectionRow("treated", got, { at_seq: 3, posts: [{ cell: got[0].cell, alpha: 1, beta: 1 }] }, 7, 0, {} as any)).toBe(false)
    }
  })

  test("[GUARD] the root cell changes neither a move's own cell nor the draw: the same seed takes the same option", async () => {
    const { choices, choose } = await import("../src/loop")
    const options = await choices([], [{ root: ask as any, rows: [ask, sch, ch, req, tpl] as any }], now)
    for (const o of options) expect(o.cell.startsWith(`${o.cand.id}|`)).toBe(true)
    for (const o of options) expect(o.cell).not.toContain("root:")
    const bare = options.map(({ rootCell: _r, ...o }) => o)
    const posts = options.map((_, j) => ({ alpha: 1 + j, beta: 2 }))
    for (let seed = 1; seed <= 200; seed++) expect(choose(seed, options, posts)).toBe(choose(seed, bare, posts))
  })
  test("[GUARD] the pick replays from the selection row alone: its seed, candidates (with their roots) and posts", async () => {
    const { choices, choose, selectionRow } = await import("../src/loop")
    const ask2 = { ...ask, id: "w2", seq: 6 }
    const req2 = { ...req, id: "q2", seq: 7 }
    const options = await choices([], [
      { root: ask as any, rows: [ask, sch, ch, req, tpl] as any },
      { root: ask2 as any, rows: [ask2, sch, ch, req2] as any },
    ], now)
    expect(new Set(options.map((o) => o.root)).size).toBe(2)
    const post = { at_seq: 7, posts: options.map((o, j) => ({ cell: o.cell, alpha: 1 + j, beta: 1 + ((j * 7) % 5), from: "cell" })) }
    for (let seed = 1; seed <= 300; seed++) {
      const i = choose(seed, options, post.posts)
      const row = selectionRow("treated", options, post, seed, i, {} as any) as any
      const j = choose(row.seed, row.cands, row.posts)
      expect(row.cands[j].id).toBe(row.a)
      expect(row.cands[j].root).toBe(row.root)
    }
  })
})
