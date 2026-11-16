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

// the person surface's land mark, as hsv writes it: a land_verdict citing the gitDiff it judges, never the ask
const diff = { shape: "gitDiff", id: "d3b", seq: 3, role: "walk", call_id: "c0", tree: "t", input_refs: ["w1"] }
const mark = (seq: number, cites = "d3b") => ({ shape: "land_verdict", id: `v${seq}`, seq, role: "person", r: 1, repo: "x", tree: "t", input_refs: [cites] })

describe("a call that waits on a person", () => {
  test("[MUST-FAIL] the person's mark as the surface writes it (citing the diff, not the ask) lets the call go; one citing another root's diff does not (qa F1)", async () => {
    expect(await offered([ask, diff, req, sel, hop, waiting])).toBe(false)
    expect(await offered([ask, diff, req, sel, hop, waiting, mark(6)])).toBe(true)
    expect(await offered([ask, diff, req, sel, hop, waiting, mark(6, "d-other-root")])).toBe(false)
  })

  test("[MUST-FAIL] withheld, the walk's move is to wait, with no deadline ahead and not idle; no other try of the call (qa F2)", async () => {
    const ids = (await applicable([ask, diff, req, sel, hop, waiting], [], Date.now(), { root: "w1", awaits: true })).map((c) => c.id)
    expect(ids).toEqual(["wait-for"])
    const after = (await applicable([ask, diff, req, sel, hop, waiting, mark(6)], [], Date.now(), { root: "w1", awaits: true })).map((c) => c.id)
    expect(after).toEqual(["call/git_land"])
  })

  test("[MUST-FAIL] is not sent again while the person has not spoken; a person's newer row on the root lets it go once more", async () => {
    expect(await offered([ask, req, sel, hop, waiting])).toBe(false)
    expect(await offered([ask, req, sel, hop, waiting, { shape: "outcome", id: "p6", seq: 6, role: "person", r: 1, input_refs: ["w1"] }])).toBe(true)
  })

  test("[MUST-FAIL] with a request producer ready (d929's shape), the waiting failure makes no new request: produce/request is offered at most once until a person's row (qa F2-live)", async () => {
    const { createHash } = await import("node:crypto")
    const key = (ids: string[]) => createHash("sha256").update([...new Set(ids)].sort().join(",")).digest("hex")
    const owner = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
    const channel = owner({ shape: "channel", id: "ch", calls: [] }, -3)
    const schema = owner({ shape: "shape_schema", id: "sr", target: "request", inputs: ["world_changed"], context: ["hop", "failure", "answer", "outcome"] }, -2)
    // the request was produced over what the root held then (its selection kept the key)
    const made = { shape: "selection", id: "s1", seq: 1.5, role: "walk", a: "produce/request/ch", seen_key: key(["w1"]) }
    const reqMade = { ...req, selection_ref: "s1" }
    const base = [channel, schema, ask, diff, made, reqMade, sel, hop]
    const offers = async (pool: any[]) => (await applicable(pool, [], Date.now(), { root: "w1", awaits: true })).map((c) => c.id)
    const once = await offers([...base, waiting])
    const again = [...base, waiting, { ...hop, id: "h9", seq: 9, call_id: "c9" }, { ...waiting, id: "f10", seq: 10, call_id: "c9" }]
    const twice = await offers(again)
    expect(once.filter((id) => id.startsWith("produce/request")).length + twice.filter((id) => id.startsWith("produce/request")).length).toBeLessThanOrEqual(1)
    expect(twice).not.toContain("call/git_land")
    expect(twice).toContain("wait-for")
    // not vacuous: a person's new word on the root does offer the request producer (and the call, once)
    const word = { shape: "world_changed", id: "p11", seq: 11, role: "person", what: "more", input_refs: ["w1"] }
    const after = await offers([...again, word])
    expect([once, twice]).toEqual([["wait-for"], ["wait-for"]])
    expect(after.some((id) => id.startsWith("produce/request")) && after.includes("call/git_land")).toBe(true)
  })

  test("[MUST-FAIL] a newer row by a producer, the walk, a person of another root, or the owner does not", async () => {
    expect(await offered([ask, req, sel, hop, waiting, { shape: "answer", id: "a6", seq: 6, role: "described", input_refs: ["w1"] }])).toBe(false)
    expect(await offered([ask, req, sel, hop, waiting, { shape: "hop", id: "h6", seq: 6, role: "walk", phase: "ended" }])).toBe(false)
    expect(await offered([ask, req, sel, hop, waiting, { shape: "world_changed", id: "w9", seq: 6, role: "person", what: "other" }])).toBe(false)
    // an owner row (a seed run) says nothing about this root: it does not lift the wait (deployment)
    expect(await offered([ask, req, sel, hop, waiting, { shape: "requires", id: "o6", seq: 6, role: "owner", for: "x", needs: "y", input_refs: ["w1"] }])).toBe(false)
  })

  test("[MUST-FAIL] a failure that does not wait on a person leaves the call offered, as before; an older waiting one is not the latest", async () => {
    expect(await offered([ask, req, sel, hop, { ...waiting, waits_for: undefined, status: 0 }])).toBe(true)
    const hop2 = { ...hop, id: "h7", seq: 7, call_id: "c2" }
    const later = { shape: "failure", id: "f8", seq: 8, role: "walk", call_id: "c2", selection_ref: "s3", status: 0, input_refs: ["s3"] }
    expect(await offered([ask, req, sel, hop, waiting, hop2, later])).toBe(true)
  })
})
