// SPDX-License-Identifier: MIT
// A row of the root's own that says it waits for a person (a detector's gap whose claim only a person can judge) holds the
// whole root, as a call's failure that waits for a person does, and the same person's row lifts it: the field means one
// thing whoever wrote it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const realFetch = globalThis.fetch
const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
let applicable: (pool: any[], skipped?: any[], now?: number, note?: any) => Promise<Array<{ id: string }>>
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

const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
const config = [
  own({ shape: "channel", id: "ch1", calls: [] }, 2),
  own({ shape: "shape_schema", id: "sr", target: "request", inputs: ["gap"] }, 3),
]
const gap = (extra: Record<string, unknown> = {}) => ({ shape: "gap", id: "g1", seq: 10, role: "detector", claim: "the source must change", ...extra })
const ids = async (pool: any[]) => (await applicable(pool, [], Date.now(), { root: "g1", shared: new Set(config.map((r) => r.id)) })).map((c) => c.id)

describe("a root whose own row waits for a person", () => {
  test("[MUST-FAIL] a gap that waits for a person offers only the wait, no produce (red before: the request is produced)", async () => {
    expect(await ids([...config, gap({ waits_for: "person" })])).toEqual(["wait-for"])
  })
  test("[MUST-FAIL] a person's row about another root does not lift it", async () => {
    const elsewhere = { shape: "outcome", id: "p11", seq: 11, role: "person", r: 1, input_refs: ["g-other"] }
    expect(await ids([...config, gap({ waits_for: "person" }), elsewhere])).toEqual(["wait-for"])
  })
  test("[GUARD] a person's newer row citing the gap lifts the wait, and the root moves as before", async () => {
    const verdict = { shape: "outcome", id: "p11", seq: 11, role: "person", r: 1, input_refs: ["g1"] }
    expect(await ids([...config, gap({ waits_for: "person" }), verdict])).toContain("produce/request/ch1")
  })
  test("[GUARD] a newer row of the same gap without the field ends the wait: the newest row says whether it waits, and a writer ends a wait by writing the gap again (red on 2064fd26)", async () => {
    const again = { shape: "gap", id: "g2", seq: 20, role: "detector", claim: "the source must change", check_runnable: true, input_refs: ["g1"] }
    // listed newest first: the newest is told by seq, not by where a row sits in the pool
    expect(await ids([...config, again, gap({ waits_for: "person" })])).toContain("produce/request/ch1")
  })
  test("[MUST-FAIL] a newer row of the same gap that still waits holds the root", async () => {
    const again = { shape: "gap", id: "g2", seq: 20, role: "detector", claim: "the source must change", waits_for: "person", input_refs: ["g1"] }
    expect(await ids([...config, gap(), again])).toEqual(["wait-for"])
  })
  test("[MUST-FAIL] a newer row of another shape does not end the gap's wait: each shape's newest row speaks for that shape", async () => {
    const later = { shape: "failure", id: "f12", seq: 12, role: "walk", kind: "skip", input_refs: ["g1"] }
    expect(await ids([...config, gap({ waits_for: "person" }), later])).toEqual(["wait-for"])
  })
  test("[MUST-FAIL] the walk's own later skip or stall row does not end another writer's waiting failure: each writer's newest row speaks for it", async () => {
    const theirs = { shape: "failure", id: "x11", seq: 11, role: "described", writer: "other", waits_for: "person", input_refs: ["g1"] }
    const stall = { shape: "failure", id: "f12", seq: 12, role: "walk", writer: "walk", kind: "stall", input_refs: ["g1"] }
    expect(await ids([...config, gap(), theirs, stall])).toEqual(["wait-for"])
  })
  test("[MUST-FAIL] another writer's newer row of the same shape and role does not end it: two detectors on one gap each speak for their own", async () => {
    const mine = gap({ writer: "detector-a", waits_for: "person" })
    const theirs = { shape: "gap", id: "g2", seq: 20, role: "detector", writer: "detector-b", claim: "the source must change", input_refs: ["g1"] }
    expect(await ids([...config, mine, theirs])).toEqual(["wait-for"])
  })
  test("[GUARD] a row shared with every root (not the root's own) that waits holds no root", async () => {
    const shared = { shape: "failure", id: "s11", seq: 11, role: "detector", waits_for: "person" }
    const note = { root: "g1", shared: new Set([...config.map((r) => r.id), "s11"]) }
    const offered = (await applicable([...config, gap(), shared], [], Date.now(), note)).map((c) => c.id)
    expect(offered).toContain("produce/request/ch1")
  })
  test("[MUST-FAIL] on an ask, the person's own ask before the waiting row does not lift it: only a person's row after the wait does", async () => {
    const askConfig = [own({ shape: "channel", id: "ch1", calls: [] }, 2), own({ shape: "shape_schema", id: "sa", target: "request", inputs: ["world_changed"] }, 3)]
    const ask = { shape: "world_changed", id: "w1", seq: 5, role: "person", what: "x" }
    const earlier = { shape: "world_changed", id: "p6", seq: 6, role: "person", what: "and this", input_refs: ["w1"] }
    const waits = { shape: "failure", id: "x11", seq: 11, role: "described", waits_for: "person", input_refs: ["w1"] }
    const offered = async (pool: any[]) => (await applicable(pool, [], Date.now(), { root: "w1", shared: new Set(askConfig.map((r) => r.id)) })).map((c) => c.id)
    expect(await offered([...askConfig, ask, earlier, waits])).toEqual(["wait-for"])
    // not vacuous: the person's row after the wait lifts it
    const after = { shape: "world_changed", id: "p12", seq: 12, role: "person", what: "more", input_refs: ["w1"] }
    expect(await offered([...askConfig, ask, earlier, waits, after])).toContain("produce/request/ch1")
  })
  test("[MUST-FAIL] the same writer's newer row of another shape does not end the gap's wait: the key is the shape and its writer together", async () => {
    const mine = gap({ writer: "pull-sync", waits_for: "person" })
    const note = { shape: "check_result", id: "c20", seq: 20, role: "detector", writer: "pull-sync", input_refs: ["g1"] }
    expect(await ids([...config, mine, note])).toEqual(["wait-for"])
  })
  test("[MUST-FAIL] a waiting row with no writer is not ended by a named writer's newer row of its shape and role", async () => {
    const theirs = { shape: "gap", id: "g2", seq: 20, role: "detector", writer: "detector-b", claim: "the source must change", input_refs: ["g1"] }
    expect(await ids([...config, gap({ waits_for: "person" }), theirs])).toEqual(["wait-for"])
  })
  test("[GUARD] the same writer's newer row of the shape without the field ends its wait", async () => {
    const theirs = { shape: "failure", id: "x11", seq: 11, role: "described", writer: "other", waits_for: "person", input_refs: ["g1"] }
    const again = { shape: "failure", id: "x12", seq: 12, role: "described", writer: "other", input_refs: ["g1"] }
    expect(await ids([...config, gap(), again, theirs])).toContain("produce/request/ch1")
  })
  test("[MUST-FAIL] a later call failure that does not wait does not end a walk row's wait that names no call: call failures are read per call, apart", async () => {
    const mine = { shape: "failure", id: "f11", seq: 11, role: "walk", waits_for: "person", input_refs: ["g1"] }
    const call = { shape: "failure", id: "f12", seq: 12, role: "walk", call_id: "c1", input_refs: ["g1"] }
    expect(await ids([...config, gap(), mine, call])).toEqual(["wait-for"])
  })
  test("[MUST-FAIL] a walk row naming no call that waits for a person holds the root: only a call's failure is read per call", async () => {
    const mine = { shape: "failure", id: "f11", seq: 11, role: "walk", waits_for: "person", input_refs: ["g1"] }
    expect(await ids([...config, gap(), mine])).toEqual(["wait-for"])
  })
  test("[GUARD] a row waiting for someone other than a person holds nothing: only a person's wait is read", async () => {
    expect(await ids([...config, gap({ waits_for: "owner" })])).toContain("produce/request/ch1")
  })
  test("[MUST-FAIL] a failure another vessel wrote, naming a call and waiting for a person, holds the root: only the walk's own call failures are read per call", async () => {
    const theirs = { shape: "failure", id: "x11", seq: 11, role: "described", call_id: "cx", waits_for: "person", input_refs: ["g1"] }
    expect(await ids([...config, gap(), theirs])).toEqual(["wait-for"])
  })
  test("[GUARD] a gap without the field moves as before", async () => {
    expect(await ids([...config, gap()])).toContain("produce/request/ch1")
  })
  test("[GUARD] an owner's row saying it waits holds no root: the owner's configuration is every root's, not this one's", async () => {
    const said = own({ shape: "note", id: "o4", waits_for: "person" }, 4)
    expect(await ids([...config, said, gap()])).toContain("produce/request/ch1")
  })
})

describe("a call's failure that waits for a person is read as before", () => {
  const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person" }
  const req = { shape: "request", id: "q2", seq: 2, role: "described", pointer: { type: "git_land", cwd: "/trees/x" }, input_refs: ["w1"] }
  const tried = (n: number, waits: boolean) => [
    { shape: "selection", id: `s${n}`, seq: n, role: "walk", a: "call/git_land", from: "q2" },
    { shape: "hop", id: `h${n}`, seq: n + 1, role: "walk", phase: "started", kind: "call", call_id: `c${n}`, pointer_type: "git_land", selection_ref: `s${n}` },
    { shape: "failure", id: `f${n}`, seq: n + 2, role: "walk", call_id: `c${n}`, selection_ref: `s${n}`, status: 409, input_refs: [`s${n}`], ...(waits ? { waits_for: "person" } : {}) },
  ]
  test("[GUARD] a later failure of the same call that no longer waits lets the call go, though an earlier one waited", async () => {
    const got = (await applicable([ask, req, ...tried(3, true), ...tried(10, false)], [], Date.now(), { root: "w1" })).map((c) => c.id)
    expect(got).toContain("call/git_land")
  })
  test("[GUARD] the latest failure waiting still holds the root to its wait", async () => {
    const got = (await applicable([ask, req, ...tried(3, false), ...tried(10, true)], [], Date.now(), { root: "w1", awaits: true })).map((c) => c.id)
    expect(got).toEqual(["wait-for"])
  })
  test("[MUST-FAIL] a row's wait still holds the root's other moves when it is overdue: only the lapse grade is offered beside the wait", async () => {
    const owner = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
    const shared = [owner({ shape: "channel", id: "ch", calls: [] }, -5),
      ...["outcome", "request"].map((target, i) => owner({ shape: "shape_schema", id: `s-${target}`, target, inputs: ["world_changed"], context: ["answer", "due"] }, -4 + i * 0.1))]
    const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "x" }
    const answer = { shape: "answer", id: "a1", seq: 1.2, role: "described", text: "done", input_refs: ["w1"] }
    const due = { shape: "due", id: "d1", seq: 1.3, role: "described", within_ms: 1, at: 100, input_refs: ["w1"] }
    const waits = { shape: "failure", id: "f2", seq: 2, role: "walk", waits_for: "person", input_refs: ["w1"] }
    const ids = (await applicable([...shared, ask, answer, due, waits], [], 1_000, { root: "w1", awaits: true })).map((c) => c.id)
    expect(ids.sort()).toEqual(["produce/outcome/ch", "wait-for"])
  })
  test("[MUST-FAIL] before its deadline a root whose row waits offers only the wait: no lapse is graded early", async () => {
    const owner = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
    const shared = [owner({ shape: "channel", id: "ch", calls: [] }, -5),
      ...["outcome", "request"].map((target, i) => owner({ shape: "shape_schema", id: `s-${target}`, target, inputs: ["world_changed"], context: ["answer", "due"] }, -4 + i * 0.1))]
    const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "x" }
    const answer = { shape: "answer", id: "a1", seq: 1.2, role: "described", text: "done", input_refs: ["w1"] }
    const due = { shape: "due", id: "d1", seq: 1.3, role: "described", within_ms: 1, at: 100_000, input_refs: ["w1"] }
    const waits = { shape: "failure", id: "f2", seq: 2, role: "walk", waits_for: "person", input_refs: ["w1"] }
    const ids = (await applicable([...shared, ask, answer, due, waits], [], 1_000, { root: "w1", awaits: true })).map((c) => c.id)
    expect(ids).toEqual(["wait-for"])
  })
})

describe("a row's wait changes no grading", () => {
  test("[GUARD] a past deadline is overdue and its lapse graded as before when the root's wait is a row's, not a call's (red on 2064fd26 and 5fba8889)", async () => {
    const owner = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
    const shared = [owner({ shape: "channel", id: "ch", calls: [] }, -5),
      owner({ shape: "shape_schema", id: "s-outcome", target: "outcome", inputs: ["world_changed"], context: ["answer", "due"] }, -4)]
    const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "x" }
    const answer = { shape: "answer", id: "a1", seq: 1.2, role: "described", text: "done", input_refs: ["w1"] }
    const due = { shape: "due", id: "d1", seq: 1.3, role: "described", within_ms: 1, at: 100, input_refs: ["w1"] }
    const waits = { shape: "failure", id: "f2", seq: 2, role: "walk", waits_for: "person", input_refs: ["w1"] }
    const seen = async (pool: any[]) => { const note: any = { root: "w1", awaits: true }; const ids = (await applicable(pool, [], 1_000, note)).map((c) => c.id); return { overdue: note.overdue === true, lapse: ids.includes("produce/outcome/ch") } }
    const without = await seen([...shared, ask, answer, due])
    expect(without).toEqual({ overdue: true, lapse: true })
    // the lapse grade is still offered (beside the wait), and the root is overdue as before
    expect(await seen([...shared, ask, answer, due, waits])).toEqual(without)
  })
})
