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
})
