// SPDX-License-Identifier: MIT
// The stall clock is also time. A root with no move is said once its newest counted row is the owner's stall_rule N
// store rows behind, or, when the owner's rhythm row naming the stall gives every_ms, once that row is every_ms old by
// its own t against the tick's now: whichever comes first. A walk parked on one wait writes a few rows an hour, so a
// count in store rows alone left a root with no move unsaid for most of a day. And whichever wait the tick offers ends
// by the earliest time such a root falls due, since the walk writes nothing while it waits. With no rhythm row, both
// are as before.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const realFetch = globalThis.fetch
const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
type Opt = { cand: { kind: string; id: string; pointer: Record<string, unknown> }; root: string }
let stalls: typeof import("../src/loop").stalls
let choices: (shared: any[], roots: any[], now?: number, answers?: Record<string, string>, arm?: any) => Promise<Opt[]>
beforeAll(async () => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
  })
  globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
  const loop = await import("../src/loop")
  stalls = loop.stalls
  choices = loop.choices as unknown as typeof choices
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]
})

const NOW = Date.parse("2026-01-10T12:00:00Z")
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const rule = { shape: "stall_rule", id: "sr", seq: 1, role: "owner", after_rows: 240 }
const clock = (every_ms: number, extra: Record<string, unknown> = {}) => ({ shape: "rhythm", id: `rh${every_ms}`, seq: 2, role: "owner", target: "stall", every_ms, ...extra })
// a gap root whose newest row is a hop `ago` ms before NOW, a few store rows behind the tick (the parked walk's rate)
const gapRoot = (id: string, ago: number, seq = 100) => ({
  root: { shape: "gap", id, seq: seq - 1, role: "detector", t: iso(NOW - ago - MIN) },
  rows: [{ shape: "hop", id: `${id}-h`, seq, role: "walk", t: iso(NOW - ago) }],
})
const AT = 110 // the tick's selection: ten store rows after the root's newest

describe("a root with no move is said by time", () => {
  test("[MUST-FAIL] newest row three hours old, ten store rows behind, a 30-minute rhythm: one stall row naming the time it counted from", () => {
    const g = gapRoot("g1", 180 * MIN)
    const rows = stalls([rule, clock(30 * MIN)], [g], [], AT, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ shape: "failure", kind: "stall", root: "g1", rows: 240, since_seq: 100, every_ms: 30 * MIN, since_t: g.rows[0]!.t, input_refs: ["g1"] })
    expect(["status", "r", "lapsed", "selection_ref", "call_id"].filter((k) => k in rows[0]!)).toEqual([])
  })

  test("[MUST-FAIL] every_ms is reached at exactly every_ms after the row's t, not a millisecond before", () => {
    const ms = 30 * MIN
    expect(stalls([rule, clock(ms)], [gapRoot("g1", ms - 1)], [], AT, NOW)).toEqual([])
    expect(stalls([rule, clock(ms)], [gapRoot("g1", ms)], [], AT, NOW)).toHaveLength(1)
  })

  test("[MUST-FAIL] the rhythm is read at use time: the owner's newest row by seq decides", () => {
    const g = gapRoot("g1", 180 * MIN)
    // a newer row raising the clock to four hours: three hours is not enough
    expect(stalls([rule, clock(30 * MIN), { ...clock(240 * MIN), seq: 3 }], [g], [], AT, NOW)).toEqual([])
    // a newer row lowering it to one hour: said
    expect(stalls([rule, { ...clock(240 * MIN), seq: 2 }, { ...clock(60 * MIN), seq: 3 }], [g], [], AT, NOW)).toMatchObject([{ every_ms: 60 * MIN }])
    // a newer retired row: the clock is off, the row count alone applies
    expect(stalls([rule, clock(30 * MIN), { ...clock(30 * MIN), seq: 3, retired: true }], [g], [], AT, NOW)).toEqual([])
  })

  test("[GUARD] no rhythm row naming the stall: the store-row count alone, as before", () => {
    const g = gapRoot("g1", 180 * MIN)
    expect(stalls([rule], [g], [], AT, NOW)).toEqual([])
    expect(stalls([rule], [g], [], 100 + 240, NOW)).toMatchObject([{ rows: 240, since_seq: 100 }])
    expect(stalls([rule], [g], [], 100 + 240, NOW)[0]).not.toHaveProperty("every_ms")
    // not the owner's, a rhythm of another target, a scheduled template's rhythm, a zero or non-number every_ms
    for (const r of [clock(30 * MIN, { role: "described" }), clock(30 * MIN, { target: "walkFailureReport" }),
      { shape: "rhythm", id: "rt", seq: 2, role: "owner", template: "tpl1", every_rows: 240 }, clock(0), clock(30 * MIN, { every_ms: "1800000" })])
      expect(stalls([rule, r], [g], [], AT, NOW)).toEqual([])
  })

  test("[GUARD] a root with a move, its wait included, is not said however old its newest row", () => {
    expect(stalls([rule, clock(30 * MIN)], [gapRoot("g1", 600 * MIN)], [{ root: "g1" }], AT, NOW)).toEqual([])
  })

  test("[MUST-FAIL] a rhythm with no stall_rule says by time alone; a row with no t is counted in store rows only", () => {
    expect(stalls([clock(30 * MIN)], [gapRoot("g1", 180 * MIN)], [], AT, NOW)).toMatchObject([{ since_seq: 100, every_ms: 30 * MIN }])
    expect(stalls([clock(30 * MIN)], [gapRoot("g1", 180 * MIN)], [], AT, NOW)[0]).not.toHaveProperty("rows")
    const noT = { root: { shape: "gap", id: "g1", seq: 99, role: "detector" }, rows: [{ shape: "hop", id: "h", seq: 100, role: "walk" }] }
    expect(stalls([rule, clock(30 * MIN)], [noT], [], AT, NOW)).toEqual([])
  })

  test("[MUST-FAIL] once said by time, an unchanged root is not said again; a new row of its own restarts the clock", () => {
    const g = gapRoot("g1", 180 * MIN)
    const said = { shape: "failure", id: "st", seq: 105, role: "walk", kind: "stall", root: "g1", t: iso(NOW - 120 * MIN) }
    expect(stalls([rule, clock(30 * MIN)], [{ root: g.root, rows: [...g.rows, said] }], [], AT, NOW)).toEqual([])
    const person = { shape: "note", id: "p", seq: 107, role: "person", t: iso(NOW - 40 * MIN) }
    expect(stalls([rule, clock(30 * MIN)], [{ root: g.root, rows: [...g.rows, said, person] }], [], AT, NOW))
      .toMatchObject([{ since_seq: 107, since_t: person.t }])
  })

  test("[MUST-FAIL] a root whose newest row is a request answering the walk's own produce, then nothing, is said by time", () => {
    // the shape of the roots that fell silent together: a produce selection, the described request it made, no move since
    const root = { shape: "gap", id: "g7", seq: 90, role: "detector", t: iso(NOW - 200 * MIN) }
    const sel = { shape: "selection", id: "s1", seq: 95, role: "walk", a: "produce/request/ch1", root: "g7", t: iso(NOW - 175 * MIN) }
    const req = { shape: "request", id: "q1", seq: 96, role: "described", selection_ref: "s1", root: "g7", t: iso(NOW - 174 * MIN) }
    expect(stalls([rule, clock(30 * MIN)], [{ root, rows: [sel, req] }], [], AT, NOW)).toMatchObject([{ root: "g7", since_seq: 96, since_t: req.t }])
  })
})

describe("a wait ends by the next stall due", () => {
  const arm = { shape: "arm", id: "arm1", seq: 1, arm: "treated", as_of_seq: 99, role: "walk" }
  // a root nothing takes: no move at all, not a wait either (someone awaits it, no deadline)
  const still = (id: string, ago: number, extra: Record<string, unknown>[] = []) => {
    const g = gapRoot(id, ago)
    return { ...g, rows: [...g.rows, ...extra], awaits: true, dues: [] as number[] }
  }
  // a root whose deadline is two hours ahead: it offers its own wait, bounded by that deadline (a root no one awaits is
  // the walk's arm beside other roots, and offers none)
  const dueRoot = (ago: number, at = NOW + 120 * MIN) => ({ ...gapRoot("i1", ago, 50), awaits: true, dues: [at] })
  const waits = (got: Opt[]) => got.filter((o) => o.cand.kind === "wait-for").map((o) => [o.root, o.cand.pointer.until])

  test("[MUST-FAIL] the idle wait, with a root that has no move ten minutes old and a 30-minute clock, ends 20 minutes from now", async () => {
    const got = await choices([clock(30 * MIN)], [still("g1", 10 * MIN)], NOW, {}, arm)
    expect(waits(got)).toEqual([["arm1", NOW + 20 * MIN]])
  })

  test("[MUST-FAIL] a root's own wait ends by another root's stall due, the earliest of them, before its deadline", async () => {
    const got = await choices([clock(30 * MIN)], [dueRoot(600 * MIN), still("g1", 10 * MIN), still("g2", 25 * MIN)], NOW)
    expect(waits(got)).toEqual([["i1", NOW + 5 * MIN]])
  })

  test("[GUARD] no rhythm row: the waits are as before (idle unbounded, the root's by its deadline)", async () => {
    expect(waits(await choices([], [still("g1", 10 * MIN)], NOW, {}, arm))).toEqual([["arm1", undefined]])
    expect(waits(await choices([], [dueRoot(600 * MIN), still("g1", 10 * MIN)], NOW))).toEqual([["i1", NOW + 120 * MIN]])
  })

  test("[GUARD] a root already said since its last change, or one with a move, sets no bound", async () => {
    const said = { shape: "failure", id: "st", seq: 105, role: "walk", kind: "stall", root: "g1", t: iso(NOW - 5 * MIN) }
    expect(waits(await choices([clock(30 * MIN)], [still("g1", 10 * MIN, [said])], NOW, {}, arm))).toEqual([["arm1", undefined]])
    // the waiting root's own old row is its own: it has a move
    expect(waits(await choices([clock(30 * MIN)], [dueRoot(600 * MIN)], NOW))).toEqual([["i1", NOW + 120 * MIN]])
  })

  test("[MUST-FAIL] a stall already due (not yet said) ends the wait now, never in the past", async () => {
    expect(waits(await choices([clock(30 * MIN)], [still("g1", 45 * MIN)], NOW, {}, arm))).toEqual([["arm1", NOW]])
  })

  test("[GUARD] a deadline earlier than the stall due still bounds the wait", async () => {
    const got = await choices([clock(30 * MIN)], [dueRoot(600 * MIN, NOW + 2 * MIN), still("g1", 10 * MIN)], NOW)
    expect(waits(got)).toEqual([["i1", NOW + 2 * MIN]])
  })
})
