// SPDX-License-Identifier: MIT
// A root with no move is said (law 6): once its newest row is the owner's stall_rule N store rows behind this tick's
// selection, one failure row of kind stall, blaming no one and closing nothing; again every N rows while it sits
// (records keeps the row among the root's rows, so it is the root's newest). No read is made. With no rule, nothing.
import { beforeAll, describe, expect, test } from "bun:test"

describe("a root with no move", () => {
  let stalls: typeof import("../src/loop").stalls
  beforeAll(async () => {
    Object.assign(process.env, { WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k" })
    stalls = (await import("../src/loop")).stalls
  })
  const rule = (n: number, extra: Record<string, unknown> = {}) => ({ shape: "stall_rule", id: "sr", seq: 1, role: "owner", after_rows: n, ...extra })
  const open = { root: { shape: "gap", id: "g1", seq: 10, role: "detector" }, rows: [{ shape: "hop", id: "h1", seq: 40, role: "walk" }] }
  const other = { root: { shape: "gap", id: "g2", seq: 11, role: "detector" }, rows: [] }

  test("[MUST-FAIL] N rows after its newest with no move, one stall row naming the root; it blames no one and closes nothing", () => {
    const rows = stalls([rule(20)], [open, other], [{ root: "g2" }], 60)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ shape: "failure", kind: "stall", root: "g1", rows: 20, since_seq: 40, input_refs: ["g1"] })
    // no status (never a call's failure), no r (never a grade), no lapse: it is the walk's own word, as a skip is; and
    // no selection_ref: the tick's selection is another root's move, and records would read it as that move failing
    expect(["status", "r", "lapsed", "blames", "selection_ref", "call_id"].filter((k) => k in rows[0])).toEqual([])
  })

  test("[MUST-FAIL] fewer than N rows, a root with a move, a retired, absent, zero or other writer's rule: no row", () => {
    expect(stalls([rule(20)], [open], [], 59)).toEqual([])
    expect(stalls([rule(20)], [open], [{ root: "g1" }], 99)).toEqual([])
    expect(stalls([rule(20, { retired: true })], [open], [], 99)).toEqual([])
    expect(stalls([], [open], [], 99)).toEqual([])
    expect(stalls([rule(0)], [open], [], 99)).toEqual([]) // a count of none is no rule: nothing is said
    expect(stalls([{ ...rule(20), role: "described" }], [open], [], 99)).toEqual([]) // only the owner's rule
  })

  test("[MUST-FAIL] the count runs from the root's newest row: a stall row there is said again only after N more rows", () => {
    expect(stalls([rule(20)], [{ root: open.root, rows: [] }], [], 35)).toMatchObject([{ since_seq: 10 }]) // the root alone
    const sat = { root: open.root, rows: [...open.rows, { shape: "failure", id: "st1", seq: 100, role: "walk", kind: "stall" }] }
    expect(stalls([rule(20)], [sat], [], 119)).toEqual([])
    expect(stalls([rule(20)], [sat], [], 120)).toMatchObject([{ root: "g1", since_seq: 100 }])
  })
})
