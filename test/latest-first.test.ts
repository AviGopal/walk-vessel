// SPDX-License-Identifier: MIT
// An input entry with latest_by reads what a thing stands at now: the latest row per value of that field, and its where
// met by that row or not at all, as records' reads and the owner's requires take it. A gap released since (its latest row
// no longer localized false) offers nothing that waits on an unlocalized gap, though an older row of it was one; a refusal
// a later verdict on the same tree overturned is no longer a refusal. And an {answers_a_call} entry, which names no
// shape, reads a tool's answer as news: a producer asking for them is offered again when one comes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
const root = { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "fix the failing test" }
const channel = own({ shape: "channel", id: "ch1", calls: [] }, 2)
const gap = (seq: number, localized: boolean) => ({ shape: "gap", id: `g${seq}`, seq, role: "detector", gap_id: "G1", localized, input_refs: ["w1"] })
const verdict = (seq: number, r: number, tree = "T1") => ({ shape: "land_verdict", id: `v${seq}`, seq, role: "described", r, tree, input_refs: ["w1"] })

describe("an input's latest row, then its where", () => {
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
  const offered = async (pool: any[], target: string): Promise<boolean> => {
    const { applicable } = await import("../src/applicable")
    return (await applicable(pool, [], Date.now(), { root: "w1" })).map((c) => c.id).includes(`produce/${target}/ch1`)
  }
  const wants = own({ shape: "shape_schema", id: "sw", target: "change_wanted", inputs: ["world_changed", { shape: "gap", latest_by: "gap_id", where: { localized: false } }] }, 3)
  const explains = own({ shape: "shape_schema", id: "se", target: "attempt_explanation", inputs: ["world_changed", { shape: "land_verdict", latest_by: "tree", where: { r: 0 } }] }, 3)

  test("[MUST-FAIL] a gap released since (its latest row localized) offers nothing that waits on an unlocalized one", async () => {
    expect(await offered([root, channel, wants, gap(10, false), gap(20, true)], "change_wanted")).toBe(false)
  })
  test("[GUARD] a gap whose latest row is unlocalized is one, whatever came before it", async () => {
    expect(await offered([root, channel, wants, gap(10, false)], "change_wanted")).toBe(true)
    expect(await offered([root, channel, wants, gap(10, true), gap(20, false)], "change_wanted")).toBe(true)
    // each gap is read apart: another gap released after it leaves this one unlocalized
    expect(await offered([root, channel, wants, gap(10, false), { ...gap(20, true), gap_id: "G2" }], "change_wanted")).toBe(true)
  })
  test("[MUST-FAIL] a refusal a later verdict on the same tree overturned is not one", async () => {
    expect(await offered([root, channel, explains, verdict(10, 0), verdict(20, 1)], "attempt_explanation")).toBe(false)
  })
  test("[GUARD] each tree is read apart: an overturned refusal on one tree leaves another tree's refusal standing", async () => {
    expect(await offered([root, channel, explains, verdict(10, 0), verdict(20, 1), verdict(30, 0, "T2")], "attempt_explanation")).toBe(true)
    expect(await offered([root, channel, explains, verdict(10, 1), verdict(20, 0)], "attempt_explanation")).toBe(true)
  })

  // a producer reading tool answers, its produce made once, then a call answered
  const asks = own({ shape: "shape_schema", id: "sa", target: "next_step", inputs: ["world_changed"], context: [{ answers_a_call: true, latest_by: "call_id" }] }, 3)
  const made = [
    { shape: "selection", id: "sel20", seq: 20, role: "walk", root: "w1", a: "produce/next_step/ch1", seen_key: "k-made" },
    { shape: "hop", id: "hp21", seq: 21, role: "walk", phase: "ended", kind: "produce", selection_ref: "sel20" },
    { shape: "next_step", id: "n22", seq: 22, role: "described", selection_ref: "sel20", input_refs: ["w1"] },
  ]
  const answered = (seq: number) => [
    { shape: "selection", id: `sel${seq}`, seq, role: "walk", root: "w1", a: "call/fs_read" },
    { shape: "hop", id: `hs${seq}`, seq: seq + 1, role: "walk", phase: "started", kind: "call", call_id: `c${seq}`, pointer_type: "fs_read", selection_ref: `sel${seq}` },
    { shape: "hop", id: `he${seq}`, seq: seq + 2, role: "walk", phase: "ended", kind: "call", call_id: `c${seq}`, selection_ref: `sel${seq}` },
    { shape: "fileContent", id: `fc${seq}`, seq: seq + 3, role: "walk", call_id: `c${seq}`, selection_ref: `sel${seq}`, path: "src/a.ts", content: "x", input_refs: ["w1"] },
  ]
  test("[MUST-FAIL] a tool's answer after the produce is news to a producer reading call answers", async () => {
    expect(await offered([root, channel, asks, ...made, ...answered(30)], "next_step")).toBe(true)
  })
  test("[GUARD] with no answer since, it is not offered again; nor for a row no entry reads", async () => {
    expect(await offered([root, channel, asks, ...made], "next_step")).toBe(false)
    const other = { shape: "note", id: "nt40", seq: 40, role: "described", input_refs: ["w1"] }
    expect(await offered([root, channel, asks, ...made, other], "next_step")).toBe(false)
    // a call started and ended with no answer row yet, and a producer's row that carries a call_id, are not answers
    expect(await offered([root, channel, asks, ...made, ...answered(30).slice(0, 3)], "next_step")).toBe(false)
    expect(await offered([root, channel, asks, ...made, { ...answered(30)[3], role: "described" }], "next_step")).toBe(false)
    // nor a row the walk wrote with no call behind it
    const { call_id: _c, ...uncalled } = answered(30)[3]
    expect(await offered([root, channel, asks, ...made, uncalled], "next_step")).toBe(false)
  })
})
