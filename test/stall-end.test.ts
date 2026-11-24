// SPDX-License-Identifier: MIT
// A root said stalled again and again with nothing of its own changing ends its attempt. With the owner's stall_rule
// naming ends_after S, a said root is said again each period from its last stall row, and the S-th stall row since its
// last change also writes one end row per produce made since the first of them (each answer moved nothing), or one
// citing none. An ended root is not said again and bounds no wait; it wakes on a change of its own or an owner's
// install of its repo after the end. A root waiting on a person is never ended. With no ends_after, as before.
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

  test("[MUST-NOT-END] a commit marked needs_person, ended before the exemption was read, woken by the walk's install: counted afresh, never ended again", () => {
    const marked = { shape: "gitCommitResult", id: "gc1", seq: 105, role: "walk", writer: "walk-test", root: "g1", needs_person: ["tight/a.ts (protected: repos/x/tight/)"], t: iso(NOW - 280 * MIN) }
    const walkInstall = { shape: "infra_window", id: "iw140", seq: 140, role: "owner", installed: [{ vessel: "walk-test" }], t: iso(NOW - 40 * MIN) }
    const rows = [marked, ...done, prod("p5", 142, 38), st("s4", 145, 90), prod("p6", 146, 89), st("s5", 150, 60)]
    const out = stalls([rule(), clock, walkInstall], one(rows), [], AT, NOW)
    expect(ends(out)).toEqual([])
    // not vacuous: the same rows with the commit unmarked end at the third say
    expect(ends(stalls([rule(), clock, walkInstall], one([{ ...marked, needs_person: [] }, ...rows.slice(1)]), [], AT, NOW))).toHaveLength(1)
  })

  test("[MUST-FAIL] wakes on a change of its own: said again from it", () => {
    const person = { shape: "note", id: "n1", seq: 140, role: "person", root: "g1", t: iso(NOW - 40 * MIN) }
    expect(says(stalls([rule(), clock], one([...done, person]), [], AT, NOW))).toMatchObject([{ said: 1, since_seq: 140 }])
  })
})

describe("a root waiting on a person is never ended", () => {
  // the land call refused for a person's verdict, then the walk's capped waits ending with nothing
  const waits = { shape: "failure", id: "f1", seq: 105, role: "walk", root: "g1", call_id: "c1", waits_for: "person", t: iso(NOW - 280 * MIN) }
  const nulls = Array.from({ length: 12 }, (_, i) => ({ shape: "selection", id: `w${i}`, seq: 140 + i, role: "walk", a: "wait-for/c1", root: "g1", t: iso(NOW - (200 - i * 15) * MIN) }))

  test("[GUARD] waiting (a move): no stall row, no end row, whatever the store holds", () => {
    expect(stalls([rule(), clock], one([waits, ...nulls, st("s1", 160, 90), st("s2", 170, 60)]), [{ root: "g1" }], AT, NOW)).toEqual([])
  })

  test("[MUST-NOT-END] a stretch with no move: said once per change, never ended", () => {
    expect(stalls([rule(), clock], one([waits, st("s1", 110, 90), st("s2", 120, 60)]), [], AT, NOW)).toEqual([])
    expect(stalls([rule(), clock], one([waits, prod("p1", 106, 270)]), [], AT, NOW)).toMatchObject([{ kind: "stall" }])
    expect(stallDue([rule(), clock], one([waits, st("s1", 110, 10)]), NOW)).toBeUndefined()
  })

  test("[MUST-NOT-END] a person's row about nothing of the root's (a page viewed, naming no root) is not their word: never ended", () => {
    const viewed = { shape: "exposure", id: "x1", seq: 107, role: "person", t: iso(NOW - 270 * MIN), input_refs: ["elsewhere"] }
    expect(ends(stalls([rule(), clock], one([waits, viewed, st("s1", 110, 90), st("s2", 120, 60)]), [], AT, NOW))).toEqual([])
    // in the root's pool (naming it) but citing nothing of its rows: still not their word on it
    const inPool = { ...viewed, id: "x2", root: "g1" }
    expect(ends(stalls([rule(), clock], one([waits, inPool, st("s1", 110, 90), st("s2", 120, 60)]), [], AT, NOW))).toEqual([])
  })

  test("[MUST-NOT-END] a person's row citing only an owner row, or only a row every root is given, is not their word on the root", () => {
    const owners = { shape: "infra_window", id: "iw0", seq: 50, role: "owner", installed: [{ repo: "r9" }], t: iso(NOW - 400 * MIN) }
    const given = { shape: "channel", id: "chx", seq: 51, role: "described", t: iso(NOW - 400 * MIN) }
    const cites = (id: string, ref: string) => ({ shape: "exposure", id, seq: 107, role: "person", t: iso(NOW - 270 * MIN), input_refs: [ref] })
    const said = [st("s1", 110, 90), st("s2", 120, 60)]
    expect(ends(stalls([rule(), clock], one([owners, waits, cites("x3", "iw0"), ...said]), [], AT, NOW))).toEqual([])
    expect(ends(stalls([rule(), clock, given], one([given, waits, cites("x4", "chx"), ...said]), [], AT, NOW))).toEqual([])
  })

  // a commit the protected list marked: made, landing only on a person's verdict; no failure says it waits
  const marked = { shape: "gitCommitResult", id: "gc1", seq: 105, role: "walk", writer: "walk-test", root: "g1", needs_person: ["tight/a.ts (protected: repos/x/tight/)"], t: iso(NOW - 280 * MIN) }
  const said2 = [st("s1", 110, 90), st("s2", 120, 60)]

  test("[MUST-NOT-END] a commit marked needs_person, with no failure saying it waits: never ended (USER ruling 11-23, show them on my page)", () => {
    expect(ends(stalls([rule(), clock], one([marked, ...said2]), [], AT, NOW))).toEqual([])
    expect(says(stalls([rule(), clock], one([marked, prod("p1", 106, 270)]), [], AT, NOW))).toHaveLength(1)
  })

  test("[MUST-FAIL] the marked commit's exemption: a person's word after it, a newer commit marking nothing, or an empty mark each end it as any root", () => {
    const spoke = { shape: "verdict", id: "v2", seq: 107, role: "person", root: "g1", t: iso(NOW - 270 * MIN), input_refs: ["gc1"] }
    expect(ends(stalls([rule(), clock], one([marked, spoke, ...said2]), [], AT, NOW))).toHaveLength(1)
    const clean = { ...marked, id: "gc2", seq: 106, needs_person: [] }
    expect(ends(stalls([rule(), clock], one([marked, clean, ...said2]), [], AT, NOW))).toHaveLength(1)
    expect(ends(stalls([rule(), clock], one([{ ...marked, needs_person: [] }, ...said2]), [], AT, NOW))).toHaveLength(1)
  })

  test("[MUST-FAIL] only the root's own rows mark it: a needs_person row naming no root (shown to every root) does not", () => {
    const { root: _r, ...stray } = marked
    expect(ends(stalls([rule(), clock], one([stray, ...said2]), [], AT, NOW))).toHaveLength(1)
  })

  // the field set the walk writes a tool's answer with: selection_ref to the root's selection, no root field
  const answered = { shape: "gitCommitResult", id: "gc3", seq: 107, role: "walk", writer: "walk-test", selection_ref: "p1", call_id: "c1", input_refs: ["g1"], needs_person: ["tight/a.ts (protected: repos/x/tight/)"], t: iso(NOW - 268 * MIN) }

  test("[MUST-NOT-END] a marked commit as the walk writes it (under the root's selection, no root field): never ended", () => {
    expect(ends(stalls([rule(), clock], one([prod("p1", 106, 270), answered, ...said2]), [], AT, NOW))).toEqual([])
    // not vacuous: the same rows with the commit unmarked end at the third say
    expect(ends(stalls([rule(), clock], one([prod("p1", 106, 270), { ...answered, needs_person: [] }, ...said2]), [], AT, NOW))).toHaveLength(1)
  })

  test("[MUST-NOT-END] a wait lifted by a protect_list row, retried, and answered marked again (live shape): said, never ended", () => {
    const p0 = prod("p0", 104, 290)
    const wait = { shape: "failure", id: "f0", seq: 105, role: "walk", selection_ref: "p0", call_id: "c0", status: 409, waits_for: "person", list_sha256: "a".repeat(64), input_refs: ["g1"], t: iso(NOW - 285 * MIN) }
    const list = { shape: "protect_list", id: "pl1", seq: 106, role: "owner", list_sha256: "b".repeat(64), t: iso(NOW - 280 * MIN) }
    const retried = { ...answered, selection_ref: "p1", list_sha256: "b".repeat(64) }
    expect(ends(stalls([rule(), clock, list], one([p0, wait, prod("p1", 106, 270), retried, ...said2]), [], AT, NOW))).toEqual([])
  })

  test("[MUST-FAIL] a marked row every root is given is no root's mark: the root ends", () => {
    const sharedMark = { ...answered, id: "gc-shared" }
    expect(ends(stalls([rule(), clock, sharedMark], one([prod("p1", 106, 270), sharedMark, ...said2]), [], AT, NOW))).toHaveLength(1)
  })

  test("[MUST-NOT-END] the newest of each shape by each writer: another writer's newer unmarked row of the shape, or the writer's newer row of another shape, leaves the mark", () => {
    const p2 = prod("p2", 108, 265)
    const byOther = { ...answered, id: "gc4", seq: 109, writer: "other-test", selection_ref: "p2", call_id: "c2", needs_person: [] }
    expect(ends(stalls([rule(), clock], one([prod("p1", 106, 270), answered, p2, byOther, ...said2]), [], AT, NOW))).toEqual([])
    const diff = { shape: "gitDiffResult", id: "gd1", seq: 109, role: "walk", writer: "walk-test", selection_ref: "p2", call_id: "c2", input_refs: ["g1"], t: iso(NOW - 262 * MIN) }
    expect(ends(stalls([rule(), clock], one([prod("p1", 106, 270), answered, p2, diff, ...said2]), [], AT, NOW))).toEqual([])
  })

  test("[MUST-FAIL] the newest by seq, whatever order the rows come in: a newer unmarked commit listed first still ends the mark", () => {
    const clean = { ...answered, id: "gc5", seq: 109, selection_ref: "p2", call_id: "c2", needs_person: [] }
    expect(ends(stalls([rule(), clock], one([prod("p2", 108, 265), clean, prod("p1", 106, 270), answered, ...said2]), [], AT, NOW))).toHaveLength(1)
  })

  test("[MUST-FAIL] a marked commit under another root's selection does not mark this root", () => {
    const other = { ...prod("p1", 106, 270), root: "g2" }
    expect(ends(stalls([rule(), clock], one([other, answered, ...said2]), [], AT, NOW))).toHaveLength(1)
  })

  test("[MUST-FAIL] once a person has spoken, it ends as any root does", () => {
    const spoke = { shape: "verdict", id: "v1", seq: 107, role: "person", root: "g1", t: iso(NOW - 270 * MIN), input_refs: ["h"] }
    expect(ends(stalls([rule(), clock], one([waits, spoke, st("s1", 110, 90), st("s2", 120, 60)]), [], AT, NOW))).toHaveLength(1)
  })
})
