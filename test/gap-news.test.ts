// SPDX-License-Identifier: MIT
// A gap restated with nothing its owner's news_key names changed is not news: a producer that judged the gap's tree does
// not judge it again for a restatement alone (a tree already refused was re-judged on three later roots). A restatement
// that changes what the key names (released, given an edit site, held, closed) is news, as before.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
const FIELDS = ["gap_id", "status", "localized", "waits_for", "check_runnable", "meta.edit_site", "meta.operator_hold", "meta.evidence_resolve.input.only_tests"]
const gap = (seq: number, more: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  shape: "gap", id: `g${seq}`, seq, role: "detector", gap_id: "G1", status: "open", localized: false,
  claim: `the test fails (said at ${seq})`, meta: { filed_by: "generator", ...meta }, ...more,
})
const base = [
  gap(1),
  own({ shape: "channel", id: "ch1", calls: [] }, 2),
  own({ shape: "shape_schema", id: "sv", target: "land_verdict", variant: "gap", inputs: ["gap", { shape: "gitDiff", latest_by: "shape" }] }, 3),
  own({ shape: "news_key", id: "nk", of: "gap", fields: FIELDS }, 4),
  { shape: "gitDiff", id: "gd10", seq: 10, role: "walk", call_id: "c10", tree: "T1", input_refs: ["g1"] },
]
// the verdict already made on T1
const made = [
  { shape: "selection", id: "sel20", seq: 20, role: "walk", root: "g1", a: "produce/land_verdict/gap/ch1", seen_key: "k-made" },
  { shape: "hop", id: "hp21", seq: 21, role: "walk", phase: "ended", kind: "produce", selection_ref: "sel20" },
  { shape: "land_verdict", id: "v22", seq: 22, role: "described", r: 0, tree: "T1", selection_ref: "sel20", input_refs: ["g1", "gd10"] },
]

describe("a gap restated, by its news_key", () => {
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
  const offered = async (pool: any[], root = "g1"): Promise<boolean> => {
    const { applicable } = await import("../src/applicable")
    return (await applicable(pool, [], Date.now(), { root })).map((c) => c.id).includes("produce/land_verdict/gap/ch1")
  }

  test("[MUST-FAIL] a restatement changing only the claim's wording does not judge the same tree again, on its own root too", async () => {
    expect(await offered([...base, ...made, gap(30)])).toBe(false)
    expect(await offered([...base, ...made, gap(30)], "g30")).toBe(false)
    // nor one citing a row of another root's work: a restatement is compared across roots
    expect(await offered([...base, ...made, { ...gap(30), input_refs: ["sel20"] }], "g30")).toBe(false)
  })
  test("[GUARD] a restatement changing what the key names is news: released, given an edit site, other tests failing", async () => {
    expect(await offered([...base, ...made, gap(30, { localized: true })])).toBe(true)
    expect(await offered([...base, ...made, gap(30, {}, { edit_site: "repos/v/src/a.ts" })])).toBe(true)
    expect(await offered([...base, ...made, gap(30, {}, { evidence_resolve: { input: { only_tests: ["b"] } } })])).toBe(true)
  })
  test("[MUST-FAIL] a field absent from both rows is no change; one the release deletes is news", async () => {
    // neither row has check_runnable or an edit site: the restatement is still a repeat
    const bare = (seq: number) => { const g: Record<string, unknown> = gap(seq); delete g.localized; return g }
    expect(await offered([...base.filter((r) => r.id !== "g1"), bare(1), ...made, bare(30)])).toBe(false)
    // the release deleting localized (top level), and a restatement deleting the edit site it had, are news
    expect(await offered([...base, ...made, bare(30)])).toBe(true)
    const sited = gap(1, {}, { edit_site: "repos/v/src/a.ts" })
    expect(await offered([...base.filter((r) => r.id !== "g1"), sited, ...made, gap(30)])).toBe(true)
  })
  test("[GUARD] another gap's row is its own news; with no news_key for gaps, a restatement is news as before", async () => {
    expect(await offered([...base, ...made, { ...gap(30), gap_id: "G2" }])).toBe(true)
    expect(await offered([...base.filter((r) => r.shape !== "news_key"), ...made, gap(30)])).toBe(true)
    // the same row again, with no key for its shape, is news: only a key the owner names weighs another writer's rows
    expect(await offered([...base.filter((r) => r.shape !== "news_key"), ...made, { ...gap(1), id: "g30", seq: 30 }])).toBe(true)
    expect(await offered([...base, ...made])).toBe(false)
  })
})
