// SPDX-License-Identifier: MIT
// Wave 9B invariants in walk-vessel (D1.1 & D1.2):
//   1. Russo-Van Roy Monte-Carlo Information-Directed Sampling (argmin delta^2 / IG) in draw().
//   2. Settle & skip unchanged unserved tool failures in applicable() while keeping waits_for: "person" untouched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { draw } from "../src/draw"
import type { Skipped } from "../src/applicable"

describe("Wave 9B — Information-Directed Sampling (IDS) in draw()", () => {
  test("[MUST-FAIL] prefers informative uncertain Beta(1, 1) over exhausted Beta(50, 50) against a strong Beta(8, 6) benchmark", () => {
    // Under naive Thompson sampling, Beta(50, 50) (mean 0.50, variance ~0.0025 -> ~0 IG!) and Beta(1, 1) both get
    // occasionally picked when Beta(8, 6) fluctuates low. Under IDS, Beta(1, 1) has ~0.50 mean vs ~0.57 AND huge IG,
    // while Beta(50, 50) has tiny IG (~0.004) and large delta^2/IG -> IDS NEVER prefers exhausted Beta(50, 50) over Beta(1, 1).
    const posts = [
      { alpha: 50, beta: 50 }, // index 0: known mediocre (zero learning value)
      { alpha: 8, beta: 6 },   // index 1: leading uncertain arm
      { alpha: 1, beta: 1 },   // index 2: uninformative prior (high IG)
    ]
    const counts = [0, 0, 0]
    for (let s = 1; s <= 100; s++) counts[draw(s, posts)]++
    expect(counts[0]).toBe(0)
    expect(counts[1] + counts[2]).toBe(100)
    expect(counts[2]).toBeGreaterThan(0)
  })

  test("[MUST-FAIL] exploits an overwhelmingly dominant arm and explores tied priors across seeds", () => {
    // Unanimous winner Beta(45, 5) vs Beta(2, 20)
    for (let s = 1; s <= 25; s++) {
      expect(draw(s, [{ alpha: 2, beta: 20 }, { alpha: 45, beta: 5 }])).toBe(1)
    }
    // Single option always returns 0
    expect(draw(42, [{ alpha: 1, beta: 1 }])).toBe(0)
    // Tied Beta(1, 1) arms split selections across seeds rather than pinning one arm
    const picked = new Set<number>()
    for (let s = 1; s <= 30; s++) picked.add(draw(s, [{ alpha: 1, beta: 1 }, { alpha: 1, beta: 1 }, { alpha: 1, beta: 1 }]))
    expect(picked.size).toBeGreaterThan(1)
  })
})

describe("Wave 9B — unserved tool failure settle & skip in applicable()", () => {
  const realFetch = globalThis.fetch
  const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
  const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  let applicable: (pool: any[], skipped?: Skipped[], now?: number, note?: any) => Promise<Array<{ id: string }>>

  beforeAll(async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
    })
    globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "tools", endpoint: "http://tools.test" }] } })) as typeof fetch
    applicable = (await import("../src/applicable")).applicable
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]
  })

  const schema = { shape: "shape_schema", id: "sch-req", seq: 0, role: "owner", target: "request", inputs: ["gap"], context: ["failure"] }
  const channel = { shape: "channel", id: "ch1", seq: 0.5, role: "owner", calls: [] }
  const gap = { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "g-unserved", status: "open" }
  const req1 = { shape: "request", id: "req-1", seq: 2, role: "described", pointer: { type: "some_tool", target: "x" }, input_refs: ["g1"] }
  const sel1 = { shape: "selection", id: "sel-1", seq: 3, role: "walk", a: "call/some_tool", from: "req-1", root: "g1", cell: "call/some_tool|g", seen_key: "k1" }

  test("[MUST-FAIL] unserved callee failure settles the request pointer, wakes produce/request once, skips repeated request, and reopens on detector served", async () => {
    const unservedFail = { shape: "failure", id: "f-uns", seq: 4, role: "walk", call_id: "c1", selection_ref: "sel-1", status: 200, blames: "callee", unserved: "some_tool", input_refs: ["sel-1"] }
    const shared = new Set(["sch-req", "ch1"])

    // 1. After first unserved failure on req-1: call/some_tool is settled/answered, produce/request wakes to see failure!
    const candsAfterFail = await applicable([schema, channel, gap, req1, sel1, unservedFail], [], Date.now(), { root: "g1", shared })
    expect(candsAfterFail.map((c) => c.id)).not.toContain("call/some_tool")
    expect(candsAfterFail.map((c) => c.id)).toContain("produce/request/ch1")

    // 2. If producer writes a fresh request req-2 with identical pointer while nothing changed: skipped with unserved reason, call not offered!
    const selProd = { shape: "selection", id: "sel-prod", seq: 5, role: "walk", a: "produce/request/ch1", root: "g1", seen_key: "k2" }
    const req2 = { shape: "request", id: "req-2", seq: 6, role: "described", selection_ref: "sel-prod", pointer: { type: "some_tool", target: "x" }, input_refs: ["g1", "f-uns"] }
    const skipped: Skipped[] = []
    const candsOnRepeat = await applicable([schema, channel, gap, req1, sel1, unservedFail, selProd, req2], skipped, Date.now(), { root: "g1", shared })
    expect(candsOnRepeat.map((c) => c.id)).not.toContain("call/some_tool")
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ id: "req-2", of: "request" })
    expect(skipped[0]!.unserved[0]).toContain("some_tool was unserved here (row 4)")

    // 3. Once detector writes served: "some_tool", the call is offered again!
    const recovered = { shape: "recovery", id: "rec-1", seq: 7, role: "detector", served: "some_tool", input_refs: ["f-uns"] }
    const skippedAfterRec: Skipped[] = []
    const candsAfterRec = await applicable([schema, channel, gap, req1, sel1, unservedFail, selProd, req2, recovered], skippedAfterRec, Date.now(), { root: "g1", shared })
    expect(candsAfterRec.map((c) => c.id)).toContain("call/some_tool")
    expect(skippedAfterRec).toHaveLength(0)
  })

  test("[GUARD] waits_for: person failure is NEVER gated even when unserved or callee-blamed", async () => {
    const waiting = { shape: "failure", id: "f-wait", seq: 4, role: "walk", call_id: "c1", selection_ref: "sel-1", status: 409, blames: "callee", waits_for: "person", unserved: "some_tool", input_refs: ["sel-1"] }
    const skipped: Skipped[] = []
    const cands = await applicable([schema, channel, gap, req1, sel1, waiting], skipped, Date.now(), { root: "g1", shared: new Set(["sch-req", "ch1"]) })
    expect(cands.map((c) => c.id)).toContain("call/some_tool")
    expect(skipped).toHaveLength(0)
  })

  test("[GUARD] produce/* unserved failure (e.g. llm_completion outage) does NOT trigger spoke() to re-wake produce/request", async () => {
    const selProd = { shape: "selection", id: "sel-prod", seq: 2, role: "walk", a: "produce/request/ch1", root: "g1", seen_key: "k1" }
    const reqMade = { shape: "request", id: "req-1", seq: 3, role: "described", selection_ref: "sel-prod", pointer: { type: "some_tool", target: "x" }, input_refs: ["g1"] }
    const selAns = { shape: "selection", id: "sel-ans", seq: 4, role: "walk", a: "produce/answer/ch1", root: "g1" }
    const prodOutage = { shape: "failure", id: "f-llm", seq: 5, role: "walk", call_id: "c-llm", selection_ref: "sel-ans", status: 503, blames: "callee", unserved: "llm_completion", input_refs: ["sel-ans"] }
    const cands = await applicable([schema, channel, gap, selProd, reqMade, selAns, prodOutage], [], Date.now(), { root: "g1", shared: new Set(["sch-req", "ch1"]) })
    expect(cands.map((c) => c.id)).not.toContain("produce/request/ch1")
  })

  test("[MUST-FAIL] settled RUN template on unserved tool failure stays suppressed until detector writes served", async () => {
    const tpl = { shape: "activity_template", id: "tpl-1", seq: 0.7, role: "described", sig: { in: ["gap"], out: [] }, calls: [{ shape: "some_tool", pointer: { target: "x" } }] }
    const selRun = { shape: "selection", id: "sel-run", seq: 2, role: "walk", a: "run/tpl-1", root: "g1" }
    const hopStart = { shape: "hop", id: "h-run", seq: 3, role: "walk", phase: "started", kind: "run", call_id: "cr1", selection_ref: "sel-run", pointer_type: "some_tool", args: { target: "x" } }
    const runFail = { shape: "failure", id: "f-run", seq: 4, role: "walk", call_id: "cr1", selection_ref: "sel-run", status: 200, blames: "callee", unserved: "some_tool", input_refs: ["sel-run"] }
    const shared = new Set(["sch-req", "ch1", "tpl-1"])

    const suppressed = await applicable([schema, channel, tpl, gap, selRun, hopStart, runFail], [], Date.now(), { root: "g1", shared })
    expect(suppressed.map((c) => c.id)).not.toContain("run/tpl-1")

    const recovered = { shape: "recovery", id: "rec-run", seq: 5, role: "detector", served: "some_tool", input_refs: ["f-run"] }
    const reopened = await applicable([schema, channel, tpl, gap, selRun, hopStart, runFail, recovered], [], Date.now(), { root: "g1", shared })
    expect(reopened.map((c) => c.id)).toContain("run/tpl-1")
  })
})
