// SPDX-License-Identifier: MIT
// A call whose tool answered that only a person can let it go on (waits_for "person") is not sent again until the person
// (or the owner) speaks on the root (agf_i033lib9c2hs: d929's git_land, re-sent every few seconds).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const realFetch = globalThis.fetch
let applicable: (pool: any[], skipped?: any[], now?: number, note?: any) => Promise<Array<{ id: string }>>
beforeAll(async () => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
  })
  globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "tools", endpoint: "http://tools.test" }] } })) as typeof fetch
  applicable = (await import("../src/applicable")).applicable
})
afterAll(() => { globalThis.fetch = realFetch })

const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person" }
const req = { shape: "request", id: "q2", seq: 2, role: "described", pointer: { type: "git_land", cwd: "/trees/x" }, input_refs: ["w1"] }
const sel = { shape: "selection", id: "s3", seq: 3, role: "walk", a: "call/git_land", from: "q2" }
const hop = { shape: "hop", id: "h4", seq: 4, role: "walk", phase: "started", kind: "call", call_id: "c1", pointer_type: "git_land", selection_ref: "s3" }
const waiting = { shape: "failure", id: "f5", seq: 5, role: "walk", call_id: "c1", selection_ref: "s3", status: 409, waits_for: "person", input_refs: ["s3"] }
const offered = async (pool: any[]) => (await applicable(pool, [], Date.now(), { root: "w1" })).map((c) => c.id).includes("call/git_land")

describe("a call that waits on a person", () => {
  test("[MUST-FAIL] is not sent again while the person has not spoken; a person's newer row on the root lets it go once more", async () => {
    expect(await offered([ask, req, sel, hop, waiting])).toBe(false)
    expect(await offered([ask, req, sel, hop, waiting, { shape: "outcome", id: "p6", seq: 6, role: "person", r: 1, input_refs: ["w1"] }])).toBe(true)
  })

  test("[MUST-FAIL] a newer row by a producer, the walk, or a person of another root does not; the owner's does", async () => {
    expect(await offered([ask, req, sel, hop, waiting, { shape: "answer", id: "a6", seq: 6, role: "described", input_refs: ["w1"] }])).toBe(false)
    expect(await offered([ask, req, sel, hop, waiting, { shape: "hop", id: "h6", seq: 6, role: "walk", phase: "ended" }])).toBe(false)
    expect(await offered([ask, req, sel, hop, waiting, { shape: "world_changed", id: "w9", seq: 6, role: "person", what: "other" }])).toBe(false)
    expect(await offered([ask, req, sel, hop, waiting, { shape: "requires", id: "o6", seq: 6, role: "owner", for: "x", needs: "y" }])).toBe(true)
  })

  test("[MUST-FAIL] a failure that does not wait on a person leaves the call offered, as before; an older waiting one is not the latest", async () => {
    expect(await offered([ask, req, sel, hop, { ...waiting, waits_for: undefined, status: 0 }])).toBe(true)
    const hop2 = { ...hop, id: "h7", seq: 7, call_id: "c2" }
    const later = { shape: "failure", id: "f8", seq: 8, role: "walk", call_id: "c2", selection_ref: "s3", status: 0, input_refs: ["s3"] }
    expect(await offered([ask, req, sel, hop, waiting, hop2, later])).toBe(true)
  })
})
