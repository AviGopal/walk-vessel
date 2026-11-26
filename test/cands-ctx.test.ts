// SPDX-License-Identifier: MIT
// A selection names every option's context (cands[j].ctx), so each option's cell is on the row as id|ctx, aligned with
// its posterior: a composition offered and not chosen can be found at its next offer. The draw is not changed by it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const now = Date.parse("2026-01-01T12:00:00Z")
const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person", writer: "kid-p", t: "2026-01-01T11:59:30Z" }
const sch = { shape: "shape_schema", id: "s1", seq: 2, role: "owner", writer: "owner", target: "answer", inputs: ["world_changed"], context: ["fileContent"] }
const ch = { shape: "channel", id: "ch1", seq: 3, role: "owner", writer: "owner", calls: [] }
const req = { shape: "request", id: "q1", seq: 4, role: "described", writer: "described-x", pointer: { type: "fileContent", path: "README.md" } }
const tpl = { shape: "activity_template", id: "t-ok", seq: 5, role: "described", writer: "described-x", sig: { in: ["world_changed"], out: ["answer"] },
  calls: [{ shape: "fileContent", pointer: { path: "a" } }, { shape: "answer", pointer: { via_ref: "ch1" } }] }
const gap = { shape: "gap", id: "g9", seq: 6, role: "detector", gap_id: "x", status: "open", t: "2026-01-01T11:00:00Z" }

describe("a selection names every option's cell", () => {
  const realFetch = globalThis.fetch
  const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
  const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  afterAll(() => {
    globalThis.fetch = realFetch
    for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]
  })
  beforeAll(() => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "node-key-for-test",
    })
    globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
  })

  test("[MUST-FAIL] each cands entry's id|ctx is the cell its posterior was asked for, on two roots with their own asker and age", async () => {
    const { choices, selectionRow } = await import("../src/loop")
    const sch2 = { ...sch, id: "s2", inputs: ["gap"] }
    const options = await choices([], [{ root: ask as any, rows: [ask, sch, ch, req, tpl] as any }, { root: gap as any, rows: [gap, sch2, ch] as any }], now)
    expect(new Set(options.map((o) => o.root))).toEqual(new Set(["w1", "g9"]))
    const post = { at_seq: 6, posts: options.map((o, j) => ({ cell: o.cell, alpha: 1 + j, beta: 1 })) }
    for (let i = 0; i < options.length; i++) {
      const row = selectionRow("treated", options, post, 7, i, {} as any) as any
      expect(row.cands.length).toBe(options.length)
      row.cands.forEach((c: any, j: number) => {
        expect(`${c.id}|${c.ctx}`).toBe(post.posts[j].cell)
        expect(row.posts[j].alpha).toBe(1 + j)
      })
      expect(`${row.cands[i].id}|${row.cands[i].ctx}`).toBe(row.cell)
    }
    // the two roots' contexts differ in their tails: no one context is the row's
    const tails = new Set(options.map((o) => o.context.slice(-2).join(",")))
    expect(tails.size).toBe(2)
  })

  test("[MUST-FAIL] the walk's idle wait names its own context", async () => {
    const { choices, selectionRow } = await import("../src/loop")
    const arm = { shape: "arm", id: "arm1", seq: 0, role: "walk", arm: "treated" }
    // a root with no move: the walk idles beside it
    const options = await choices([], [{ root: ask as any, rows: [ask] as any }], now, {}, arm as any)
    expect(options.length).toBe(1)
    const row = selectionRow("treated", options, { at_seq: 1, posts: [{ alpha: 1, beta: 1 }] as any }, 7, 0, {} as any) as any
    expect(row.cands[0]).toMatchObject({ id: options[0].cand.id, ctx: "idle" })
    expect(`${row.cands[0].id}|${row.cands[0].ctx}`).toBe(row.cell)
  })
})
