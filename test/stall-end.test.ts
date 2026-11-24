// SPDX-License-Identifier: MIT
// A root said stalled again and again with nothing of its own changing ends its attempt. With the owner's stall_rule
// naming ends_after S, a said root is said again each period from its last stall row, and the S-th stall row since its
// last change also writes one end row per produce made since the first of them (each answer moved nothing), or one
// citing none. An ended root is not said again and bounds no wait; it wakes on a change of its own or an owner's
// install of its repo after the end. No root waits on a person: a row naming one is information, and its root ends
// as any other. With no ends_after, as before.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const realFetch = globalThis.fetch
const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
type R = Record<string, unknown>
let stalls: (shared: any[], roots: any[], options: Array<{ root: string }>, at: number, now: number) => R[]
let stallDue: (shared: any[], roots: any[], now: number) => number | undefined
beforeAll(async () => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
  })
  globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
  const loop = await import("../src/loop")
  stalls = loop.stalls as unknown as typeof stalls
  stallDue = loop.stallDue as unknown as typeof stallDue
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]
})

const NOW = Date.parse("2026-01-10T12:00:00Z")
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const rule = (extra: R = {}) => ({ shape: "stall_rule", id: "sr", seq: 1, role: "owner", after_rows: 240, ends_after: 3, ...extra })
const clock = { shape: "rhythm", id: "rh", seq: 2, role: "owner", target: "stall", every_ms: 30 * MIN }
const AT = 200 // fewer than after_rows store rows past every row here: only the time clock says
// the root, and its newest work row 300 minutes ago
const root = { shape: "gap", id: "g1", seq: 99, role: "detector", repo: "r1", t: iso(NOW - 301 * MIN) }
const hop = { shape: "hop", id: "h", seq: 100, role: "walk", root: "g1", t: iso(NOW - 300 * MIN) }
const st = (id: string, seq: number, ago: number, of = "g1") => ({ shape: "failure", id, seq, role: "walk", kind: "stall", root: of, t: iso(NOW - ago * MIN), input_refs: [of] })
const prod = (id: string, seq: number, ago: number) => ({ shape: "selection", id, seq, role: "walk", a: "produce/request/ch1", root: "g1", t: iso(NOW - ago * MIN) })
const req = (id: string, seq: number, sel: string, ago: number) => ({ shape: "request", id, seq, role: "described", root: "g1", selection_ref: sel, t: iso(NOW - ago * MIN) })
const ends = (out: R[]) => out.filter((r) => r.ends === "stall")
const says = (out: R[]) => out.filter((r) => r.kind === "stall")
const one = (rows: R[]) => [{ root, rows: [hop, ...rows] }]

describe("a said root is said again each period", () => {
  test("[MUST-FAIL] one stall row 30 minutes old, nothing since but the producer's answer: said again, the second of three", () => {
    const out = stalls([rule(), clock], one([st("s1", 110, 30), prod("p1", 111, 29), req("q1", 112, "p1", 29)]), [], AT, NOW)
    expect(says(out)).toMatchObject([{ root: "g1", since_seq: 100, said: 2, ends_after: 3 }])
    expect(ends(out)).toEqual([])
  })

  test("[MUST-FAIL] the period runs from the last stall row: 29 minutes is not enough, 30 is", () => {
    expect(stalls([rule(), clock], one([st("s1", 110, 29)]), [], AT, NOW)).toEqual([])
    expect(says(stalls([rule(), clock], one([st("s1", 110, 30)]), [], AT, NOW))).toHaveLength(1)
  })

  test("[GUARD] with no ends_after a root is said once per change, as before", () => {
    const r = rule({ ends_after: undefined })
    expect(stalls([r, clock], one([st("s1", 110, 60)]), [], AT, NOW)).toEqual([])
    expect(stalls([rule({ ends_after: "3" }), clock], one([st("s1", 110, 60)]), [], AT, NOW)).toEqual([])
    // 0 is how the owner turns ending off: no ending, and no re-say
    expect(stalls([rule({ ends_after: 0 }), clock], one([st("s1", 110, 60), st("s2", 120, 31)]), [], AT, NOW)).toEqual([])
  })

  test("[MUST-FAIL] the wait is bounded by the next say of a said root", () => {
    expect(stallDue([rule(), clock], one([st("s1", 110, 10)]), NOW)).toBe(NOW + 20 * MIN)
  })
})

describe("the S-th say ends the attempt", () => {
  test("[MUST-FAIL] two stall rows and a third due: the third is said and each produce since the first is ended, once", () => {
    const rows = [prod("p0", 105, 250), st("s1", 110, 90), prod("p1", 111, 89), req("q1", 112, "p1", 89), st("s2", 120, 60), prod("p2", 121, 59), req("q2", 122, "p2", 59)]
    const out = stalls([rule(), clock], one(rows), [], AT, NOW)
    expect(says(out)).toMatchObject([{ said: 3, since_seq: 105 }])
    expect(ends(out)).toEqual([
      { shape: "failure", ends: "stall", root: "g1", selection_ref: "p1", input_refs: ["g1", "s2"] },
      { shape: "failure", ends: "stall", root: "g1", selection_ref: "p2", input_refs: ["g1", "s2"] },
    ])
    expect(out.every((r) => !("status" in r) && !("call_id" in r))).toBe(true)
  })

  test("[MUST-FAIL] with S 2 the second say ends; with S 4 the third does not", () => {
    const rows = [st("s1", 110, 90), st("s2", 120, 60)]
    expect(ends(stalls([rule({ ends_after: 4 }), clock], one(rows), [], AT, NOW))).toEqual([])
    expect(ends(stalls([rule({ ends_after: 2 }), clock], one([st("s1", 110, 60)]), [], AT, NOW))).toHaveLength(1)
  })

  test("[MUST-FAIL] with S 1 the first say ends; a retired rule ends nothing", () => {
    expect(ends(stalls([rule({ ends_after: 1 }), clock], one([]), [], AT, NOW))).toHaveLength(1)
    expect(ends(stalls([rule({ retired: true }), clock], one([st("s1", 110, 90), st("s2", 120, 60)]), [], AT, NOW))).toEqual([])
  })

  test("[MUST-FAIL] only the walk's own produces are charged: another writer's selection since the first say is not", () => {
    const other = { shape: "selection", id: "o1", seq: 112, role: "described", a: "produce/request/ch1", root: "g1", t: iso(NOW - 85 * MIN) }
    const rows = [st("s1", 110, 90), prod("p1", 111, 89), other, st("s2", 120, 60)]
    expect(ends(stalls([rule(), clock], one(rows), [], AT, NOW)).map((r) => r.selection_ref)).toEqual(["p1"])
  })

  test("[MUST-FAIL] a produce made on another root, shown in this root's episode, is not charged to it", () => {
    const elsewhere = { ...prod("o2", 112, 85), root: "g2" }
    const rows = [st("s1", 110, 90), prod("p1", 111, 89), elsewhere, st("s2", 120, 60)]
    expect(ends(stalls([rule(), clock], one(rows), [], AT, NOW)).map((r) => r.selection_ref)).toEqual(["p1"])
  })

  test("[MUST-FAIL] no produce since the first say: one end row citing no selection", () => {
    expect(ends(stalls([rule(), clock], one([st("s1", 110, 90), st("s2", 120, 60)]), [], AT, NOW)))
      .toEqual([{ shape: "failure", ends: "stall", root: "g1", input_refs: ["g1", "s2"] }])
  })

  test("[MUST-FAIL] a change of its own restarts the count: a person's row after two says, then one say, no end", () => {
    const person = { shape: "note", id: "n1", seq: 125, role: "person", root: "g1", t: iso(NOW - 45 * MIN) }
    const out = stalls([rule(), clock], one([st("s1", 110, 120), st("s2", 120, 90), person]), [], AT, NOW)
    expect(says(out)).toMatchObject([{ said: 1, since_seq: 125 }])
    expect(ends(out)).toEqual([])
  })

  test("[MUST-FAIL] a produce after a change that followed a say is itself a change, not an answer", () => {
    const person = { shape: "note", id: "n1", seq: 115, role: "person", root: "g1", t: iso(NOW - 100 * MIN) }
    expect(says(stalls([rule(), clock], one([st("s1", 110, 120), person, prod("p1", 116, 50)]), [], AT, NOW))).toMatchObject([{ said: 1, since_seq: 116 }])
  })

  test("[MUST-FAIL] another root's stall rows are not this root's", () => {
    const out = stalls([rule(), clock], one([st("x1", 110, 90, "g2"), st("x2", 120, 60, "g2")]), [], AT, NOW)
    expect(says(out)).toMatchObject([{ said: 1 }])
    expect(ends(out)).toEqual([])
  })
})

describe("an ended root", () => {
  const done = [st("s1", 110, 150), st("s2", 120, 120), st("s3", 130, 90), { shape: "failure", id: "e1", seq: 131, role: "walk", ends: "stall", root: "g1", t: iso(NOW - 90 * MIN), input_refs: ["g1", "s2"] }]
  const install = (seq: number, repo: string) => ({ shape: "infra_window", id: `iw${seq}`, seq, role: "owner", installed: [{ repo }], t: iso(NOW - 40 * MIN) })

  test("[MUST-FAIL] is not said again and bounds no wait", () => {
    expect(stalls([rule(), clock], one(done), [], AT, NOW)).toEqual([])
    expect(stallDue([rule(), clock], one(done), NOW)).toBeUndefined()
  })

  test("[MUST-FAIL] wakes on an install of its repo after the end, counted from the install", () => {
    const out = stalls([rule(), clock, install(140, "r1")], one(done), [], AT, NOW)
    expect(says(out)).toMatchObject([{ said: 1, since_seq: 140 }])
    expect(ends(out)).toEqual([])
  })

  test("[MUST-FAIL] an install of another repo, or one before the end, wakes nothing", () => {
    expect(stalls([rule(), clock, install(140, "r2")], one(done), [], AT, NOW)).toEqual([])
    expect(stalls([rule(), clock, install(115, "r1")], one(done), [], AT, NOW)).toEqual([])
  })

  test("[MUST-FAIL] woken, it ends again after S more says, citing only the produces since the first of those", () => {
    const rows = [...done, prod("p5", 142, 38), st("s4", 145, 90), prod("p6", 146, 89), st("s5", 150, 60)]
    expect(ends(stalls([rule(), clock, install(140, "r1")], one(rows), [], AT, NOW)))
      .toEqual([{ shape: "failure", ends: "stall", root: "g1", selection_ref: "p6", input_refs: ["g1", "s5"] }])
  })

  test("[MUST-FAIL] wakes on a change of its own: said again from it", () => {
    const person = { shape: "note", id: "n1", seq: 140, role: "person", root: "g1", t: iso(NOW - 40 * MIN) }
    expect(says(stalls([rule(), clock], one([...done, person]), [], AT, NOW))).toMatchObject([{ said: 1, since_seq: 140 }])
  })
})

describe("no root waits on a person", () => {
  const said2 = [st("s1", 110, 90), st("s2", 120, 60)]
  // a land call's failure as the walk writes it (calls.ts: selection_ref and input_refs to the call's selection, no
  // root), still saying waits_for person from before no change waited on one (120950's field set)
  const callSel = { shape: "selection", id: "cs1", seq: 104, role: "walk", a: "call/git_land", root: "g1", t: iso(NOW - 290 * MIN) }
  const waits = { shape: "failure", id: "f1", seq: 105, role: "walk", writer: "walk-test", call_id: "c1", selection_ref: "cs1", status: 409,
    body: "{\"error\":\"only a person's verdict lands it\"}", input_refs: ["cs1"], waits_for: "person", t: iso(NOW - 285 * MIN) }

  test("[MUST-FAIL] a call's failure saying waits_for person, as the walk writes it: the root ends at the third say as any root does", () => {
    expect(ends(stalls([rule(), clock], one([callSel, waits, ...said2]), [], AT, NOW))).toHaveLength(1)
    const { selection_ref: _s, ...byRoot } = { ...waits, root: "g1" }
    expect(ends(stalls([rule(), clock], one([byRoot, ...said2]), [], AT, NOW))).toHaveLength(1)
  })

  test("[MUST-FAIL] a row of its own saying waits_for person (a gap marked before no gap waited on one): the root ends", () => {
    const marked = { shape: "gap", id: "g1-2", seq: 106, role: "detector", root: "g1", waits_for: "person", t: iso(NOW - 280 * MIN) }
    expect(ends(stalls([rule(), clock], one([marked, ...said2]), [], AT, NOW))).toHaveLength(1)
  })

  // a commit as the walk writes a tool's answer (selection_ref to the root's selection, no root field), still carrying
  // needs_person from before no change waited on a person
  const answered = { shape: "gitCommitResult", id: "gc3", seq: 107, role: "walk", writer: "walk-test", selection_ref: "p1", call_id: "c1", input_refs: ["g1"], needs_person: ["tight/a.ts (protected: repos/x/tight/)"], t: iso(NOW - 268 * MIN) }

  test("[MUST-FAIL] a root whose newest commit carries needs_person is not exempt: it ends as any root does", () => {
    expect(ends(stalls([rule(), clock], one([prod("p1", 106, 270), answered, ...said2]), [], AT, NOW))).toHaveLength(1)
    const { selection_ref: _s, ...byRoot } = { ...answered, id: "gc1", root: "g1" }
    expect(ends(stalls([rule(), clock], one([byRoot, ...said2]), [], AT, NOW))).toHaveLength(1)
  })

  test("[MUST-FAIL] a wait lifted by a protect_list row, retried, and answered marked again (live shape): ends", () => {
    const p0 = prod("p0", 104, 290)
    const wait = { shape: "failure", id: "f0", seq: 105, role: "walk", selection_ref: "p0", call_id: "c0", status: 409, waits_for: "person", list_sha256: "a".repeat(64), input_refs: ["g1"], t: iso(NOW - 285 * MIN) }
    const list = { shape: "protect_list", id: "pl1", seq: 106, role: "owner", list_sha256: "b".repeat(64), t: iso(NOW - 280 * MIN) }
    const retried = { ...answered, selection_ref: "p1", list_sha256: "b".repeat(64) }
    expect(ends(stalls([rule(), clock, list], one([p0, wait, prod("p1", 106, 270), retried, ...said2]), [], AT, NOW))).toHaveLength(1)
  })
})
