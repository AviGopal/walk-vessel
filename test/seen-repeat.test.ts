// SPDX-License-Identifier: MIT
// A repeat does not stand in for what it repeats. A produce reading the newest row of a shape (latest_by) is due again
// when a row it would see came after the produce it last made. A row that says again what an earlier one said (a re-run
// diff of an unchanged tree, by the owner's news_key) is not news; it must not also become the newest row shown in place
// of the row it repeats, or both are hidden and the produce waits for news nothing can bring: a root whose verdict was
// made over an older tree, then committed a new tree and diffed it twice, was never judged again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
const base: any[] = [
  { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "change the page" },
  own({ shape: "channel", id: "ch1", calls: [] }, 2),
  own({ shape: "shape_schema", id: "sv", target: "verdict", inputs: ["world_changed", { shape: "gitDiff", latest_by: "shape" }] }, 3),
  own({ shape: "news_key", id: "nk", of: "gitDiff", fields: ["tree"] }, 4),
]
const diff = (seq: number, tree: string, ms: number) => {
  const out = { shape: "gitDiff", tree, check: { ran: true, passed: false, out: `1 fail [${ms}ms]` } }
  return [
    { shape: "selection", id: `sel${seq}`, seq, role: "walk", root: "w1", a: "call/git_diff" },
    { shape: "hop", id: `hs${seq}`, seq: seq + 1, role: "walk", phase: "started", kind: "call", call_id: `c${seq}`, pointer_type: "git_diff", selection_ref: `sel${seq}` },
    { shape: "hop", id: `he${seq}`, seq: seq + 2, role: "walk", phase: "ended", kind: "call", call_id: `c${seq}`, selection_ref: `sel${seq}`, output: out },
    { shape: "gitDiff", id: `gd${seq}`, seq: seq + 3, role: "walk", call_id: `c${seq}`, selection_ref: `sel${seq}`, ...out, input_refs: ["w1"] },
  ]
}
// the verdict made over the first diff: its selection (with the key of what it was handed), its ended hop, its row, ungraded
const made = [
  { shape: "selection", id: "sel20", seq: 20, role: "walk", root: "w1", a: "produce/verdict/ch1", seen_key: "k-made" },
  { shape: "hop", id: "hp21", seq: 21, role: "walk", phase: "ended", kind: "produce", selection_ref: "sel20" },
  { shape: "verdict", id: "v22", seq: 22, role: "described", r: 0, selection_ref: "sel20", input_refs: ["w1", "gd13"] },
]

describe("a repeat does not stand in for what it repeats", () => {
  // The stub and the env are this file's own: restored after it, or a later file in the same process (the vessel's
  // own /health fetch) is answered by the stub.
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
  const offered = async (pool: any[]): Promise<boolean> => {
    const { applicable } = await import("../src/applicable")
    return (await applicable(pool, [], Date.now(), { root: "w1" })).map((c) => c.id).includes("produce/verdict/ch1")
  }

  test("[MUST-FAIL] a verdict made over an older tree is offered again after a new tree's diff, though that diff was run twice", async () => {
    expect(await offered([...base, ...diff(10, "T0", 800), ...made, ...diff(30, "T1", 810), ...diff(40, "T1", 905)])).toBe(true)
  })
  test("[GUARD] after the new tree's diff run once, it is offered again", async () => {
    expect(await offered([...base, ...diff(10, "T0", 800), ...made, ...diff(30, "T1", 810)])).toBe(true)
  })
  test("[GUARD] with nothing new since the verdict was made, it is not offered again", async () => {
    expect(await offered([...base, ...diff(10, "T0", 800), ...made])).toBe(false)
  })
  test("[GUARD] a diff repeating only what the verdict already saw is no news", async () => {
    expect(await offered([...base, ...diff(10, "T0", 800), ...made, ...diff(30, "T0", 905)])).toBe(false)
  })
  test("[GUARD] a third tree after the repeat is news as before", async () => {
    expect(await offered([...base, ...diff(10, "T0", 800), ...made, ...diff(30, "T1", 810), ...diff(40, "T1", 905), ...diff(50, "T2", 700)])).toBe(true)
  })
})
