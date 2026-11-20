// SPDX-License-Identifier: MIT
// A verdict that judges the same thing the same way as the one before it is not news. The owner says on the verdict's
// schema row which field names the thing judged and which the way (repeat_key, repeat_value: a land verdict's tree and
// r); request_acts already counts such a run as a repeat. Read where news is decided, a second r 0 on a tree already
// refused makes no producer that reads verdicts due again: a tree refused 40 times is explained once, not 40 times.
// Within one root, role and writer: a person's verdict is never absorbed by a grader's, another grader's is its own
// evidence with its own why, and a different r is news.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
const verdictSchema = (repeat: boolean) => own({ shape: "shape_schema", id: "s-lv", target: "land_verdict", inputs: ["world_changed", "gitDiff"],
  ...(repeat ? { repeat_key: "tree", repeat_value: "r" } : {}) }, 3)
const base = (repeat = true): any[] => [
  { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "fix the failing test" },
  own({ shape: "channel", id: "ch1", calls: [] }, 2),
  verdictSchema(repeat),
  own({ shape: "shape_schema", id: "s-ex", target: "explanation", inputs: ["world_changed", { shape: "land_verdict", latest_by: "tree" }] }, 4),
  own({ shape: "shape_schema", id: "s-rq", target: "request", inputs: ["world_changed"], context: [{ shape: "land_verdict", latest_by: "tree", keep: true }] }, 5),
]
const lv = (seq: number, tree: string, r: 0 | 1, role = "described", root = "w1", writer = "grader-1") =>
  ({ shape: "land_verdict", id: `lv${seq}`, seq, role, writer, root, tree, r, input_refs: [root] })
// what a producer made over what it was shown: its selection (with the key of what it was handed), its ended hop, its row
const made = (target: string, seq: number) => [
  { shape: "selection", id: `sel${seq}`, seq, role: "walk", root: "w1", a: `produce/${target}/ch1`, seen_key: `k-${target}-${seq}` },
  { shape: "hop", id: `hp${seq}`, seq: seq + 1, role: "walk", phase: "ended", kind: "produce", selection_ref: `sel${seq}` },
  { shape: target, id: `${target}${seq}`, seq: seq + 2, role: "described", root: "w1", selection_ref: `sel${seq}`, input_refs: ["w1"] },
]

describe("a verdict repeating the one before it is not news", () => {
  // The stub and the env are this file's own: restored after it, or a later file in the same process is answered by it.
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
  const offered = async (pool: any[], target = "explanation"): Promise<boolean> => {
    const { applicable } = await import("../src/applicable")
    return (await applicable(pool, [], Date.now(), { root: "w1" })).map((c) => c.id).includes(`produce/${target}/ch1`)
  }

  test("[MUST-FAIL] a second r 0 from the grader on a tree it already refused, after that refusal was explained, offers no explanation", async () => {
    expect(await offered([...base(), lv(10, "T0", 0), ...made("explanation", 20), lv(30, "T0", 0)])).toBe(false)
  })
  test("[MUST-FAIL] nor does it make the request due again", async () => {
    expect(await offered([...base(), lv(10, "T0", 0), ...made("request", 20), lv(30, "T0", 0)], "request")).toBe(false)
  })
  test("[GUARD] with no repeat key on the verdict's schema row, the second r 0 is news, as before", async () => {
    expect(await offered([...base(false), lv(10, "T0", 0), ...made("explanation", 20), lv(30, "T0", 0)])).toBe(true)
  })
  test("[GUARD] an r 0 on a new tree is news", async () => {
    expect(await offered([...base(), lv(10, "T0", 0), ...made("explanation", 20), lv(30, "T1", 0)])).toBe(true)
  })
  test("[GUARD] an r 1 after an r 0 on the same tree is news: judged another way", async () => {
    expect(await offered([...base(), lv(10, "T0", 0), ...made("explanation", 20), lv(30, "T0", 1)])).toBe(true)
  })
  test("[GUARD] an r 0 after an r 1 after an r 0 on the same tree is news: it repeats only the one just before it", async () => {
    expect(await offered([...base(), lv(10, "T0", 0), lv(12, "T0", 1), ...made("explanation", 20), lv(30, "T0", 0)])).toBe(true)
  })
  test("[GUARD] a person's r 0 on a tree the grader refused is news: a person's verdict is never absorbed as a repeat", async () => {
    expect(await offered([...base(), lv(10, "T0", 0), ...made("explanation", 20), lv(30, "T0", 0, "person")])).toBe(true)
    expect(await offered([...base(), lv(10, "T0", 0), ...made("request", 20), lv(30, "T0", 0, "person")], "request")).toBe(true)
  })
  test("[GUARD] another grader's r 0 on a tree one grader refused is news: its own evidence, with its own why", async () => {
    expect(await offered([...base(), lv(10, "T0", 0), ...made("explanation", 20), lv(30, "T0", 0, "described", "w1", "grader-2")])).toBe(true)
  })
  test("[GUARD] a verdict carrying no root is placed by its selection's root: another root's refusal of the tree is not its repeat", async () => {
    const at = (seq: number, root: string) => {
      const { root: _r, ...v } = lv(seq, "T0", 0, "described", root)
      return [{ shape: "selection", id: `vs${seq}`, seq: seq - 1, role: "walk", root, a: "produce/land_verdict/ch1", seen_key: `v-${seq}` }, { ...v, selection_ref: `vs${seq}` }]
    }
    expect(await offered([...base(), ...at(10, "w9"), ...made("explanation", 20), ...at(30, "w1")])).toBe(true)
  })
  test("[MUST-FAIL] only the target's own rows run: another shape carrying the same fields does not break a run of verdicts", async () => {
    expect(await offered([...base(), lv(10, "T0", 0), ...made("explanation", 20), { ...lv(25, "T0", 1), shape: "land_note", id: "note25" }, lv(30, "T0", 0)])).toBe(false)
  })
  test("[GUARD] another root's verdict on the same tree makes this root's first one no repeat", async () => {
    expect(await offered([...base(), lv(10, "T0", 0, "described", "w9"), ...made("explanation", 20), lv(30, "T0", 0)])).toBe(true)
  })
  test("[GUARD] a first verdict on a tree carrying no r is news: it repeats nothing", async () => {
    const { r: _r, ...bare } = lv(30, "T1", 0, "person")
    expect(await offered([...base(), lv(10, "T0", 0), ...made("explanation", 20), bare])).toBe(true)
  })
  test("[MUST-FAIL] rows are compared in seq order, not in the order the pool lists them", async () => {
    expect(await offered([lv(30, "T0", 0), ...made("explanation", 20).reverse(), lv(10, "T0", 0), ...base().reverse()])).toBe(false)
  })
  test("[GUARD] verdicts naming no tree are not one tree: two with the same r are each news", async () => {
    const { tree: _a, ...first } = lv(10, "T0", 0)
    const { tree: _b, ...second } = lv(30, "T0", 0)
    expect(await offered([...base(), first, ...made("explanation", 20), second])).toBe(true)
  })
  test("[GUARD] a value is compared whole: two object values differing inside are news", async () => {
    expect(await offered([...base(), { ...lv(10, "T0", 0), r: { score: 0, why: "a" } }, ...made("explanation", 20), { ...lv(30, "T0", 0), r: { score: 0, why: "b" } }])).toBe(true)
  })
  test("[MUST-FAIL] a value is compared whole: an equal text value repeats", async () => {
    expect(await offered([...base(), { ...lv(10, "T0", 0), r: "refused" }, ...made("explanation", 20), { ...lv(30, "T0", 0), r: "refused" }])).toBe(false)
  })
  test("[MUST-FAIL] a value is compared whole: an equal object value repeats, whatever order its fields were written in", async () => {
    expect(await offered([...base(), { ...lv(10, "T0", 0), r: { score: 0, why: "a" } }, ...made("explanation", 20), { ...lv(30, "T0", 0), r: { why: "a", score: 0 } }])).toBe(false)
  })
  test("[GUARD] with nothing new since the explanation was made, it is not offered again", async () => {
    expect(await offered([...base(), lv(10, "T0", 0), ...made("explanation", 20)])).toBe(false)
  })
})
