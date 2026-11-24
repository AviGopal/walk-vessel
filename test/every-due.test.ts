// SPDX-License-Identifier: MIT
// A request's deadlines are records': its episode answers each root's dues (the at of every deadline row the fold judges
// a lapse by, in seq order), and the walk reads them there rather than keeping its own copy of which rows count. A wait
// is bounded by the next one still ahead; one passed with none ahead makes grading the lapse the move.
//
// fixtures/every-due-episodes.json is records' own episodes answer (both read forms' roots: "all"), written by records
// at the every-deadline change over two requests, its times moved to the fixed instant these tests use:
//   A: its first deadline passed and its lapse was overtaken by a person's r 0, so the request is still open; its next
//      deadline is an hour ahead.
//   B: both its deadlines passed, each lapse overtaken by a person's r 0; still open, nothing ahead.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const realFetch = globalThis.fetch
const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
type Opt = { cand: { kind: string; id: string; pointer: Record<string, unknown> }; root: string }
let applicable: (pool: any[], skipped?: any[], now?: number, note?: any) => Promise<Array<{ id: string; kind: string; pointer: Record<string, unknown> }>>
let choices: (shared: any[], roots: any[], now?: number) => Promise<Opt[]>
beforeAll(async () => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
  })
  globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
  applicable = (await import("../src/applicable")).applicable
  choices = (await import("../src/loop")).choices as unknown as typeof choices
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]
})

const EPISODES = (await Bun.file(`${import.meta.dir}/fixtures/every-due-episodes.json`).json()) as
  { shared: any[]; roots: Array<{ root: { id: string }; rows: any[]; awaits: boolean; dues: number[] }> }
const [A, B] = EPISODES.roots as [typeof EPISODES.roots[0], typeof EPISODES.roots[0]]
const NOW = A.dues[0]! + 60_000
const shared = [
  { shape: "channel", id: "ch1", seq: 0.1, role: "owner", calls: [] },
  { shape: "shape_schema", id: "s-outcome", seq: 0.2, role: "owner", target: "outcome", inputs: ["world_changed"], context: ["answer", "due"] },
]
const waits = (got: Opt[]) => got.filter((o) => o.cand.kind === "wait-for").map((o) => [o.root, o.cand.pointer.until])

describe("the walk's deadlines are the ones records answers", () => {
  test("the fixture is what its header says: A has one deadline passed and one ahead, B has both passed, and both are open", () => {
    expect([A.dues.length, A.dues[0]! <= NOW, A.dues[1]! > NOW]).toEqual([2, true, true])
    expect([B.dues.length, B.dues.every((at) => at <= NOW)]).toEqual([2, true])
    for (const r of [A, B]) expect(r.dues).toEqual(r.rows.filter((x) => x.shape === "due").map((x) => x.at))
  })

  test("[MUST-FAIL] a request whose first deadline's lapse was refused is not overdue: its wait is bounded by its next deadline ahead", async () => {
    const note: any = { root: A.root.id, awaits: true, dues: A.dues }
    const got = await applicable([...shared, ...A.rows], [], NOW, note)
    expect(got.filter((c) => c.kind === "wait-for").map((c) => c.pointer.until)).toEqual([A.dues[1]])
    expect(note.overdue).toBeUndefined()
    // across roots it holds no other root's wait back: the walk grades what passed (a move) or waits
    const got2 = await choices(shared, [A], NOW)
    expect(got2.map((o) => o.cand.id)).toEqual(["produce/outcome/ch1"])
  })

  test("[GUARD] a request whose deadlines have all passed offers no wait, its lapse grade is the move, and it holds the other roots' waits back", async () => {
    const got = await choices(shared, [B], NOW)
    expect(waits(got)).toEqual([])
    expect(got.some((o) => o.root === B.root.id && o.cand.id === "produce/outcome/ch1")).toBe(true)
    expect(waits(await choices(shared, [A, B], NOW))).toEqual([])
  })

  test("[GUARD] a deadline due at this very instant has passed, as before: the root is overdue and offers no wait", async () => {
    const at = B.dues[0]!
    const note: any = { root: B.root.id, awaits: true, dues: [at] }
    const got = await applicable([...shared, ...B.rows.filter((x) => x.shape !== "due" || x.at === at)], [], at, note)
    expect([note.overdue, got.filter((c) => c.kind === "wait-for")]).toEqual([true, []])
  })

  test("[MUST-FAIL] a records that answers no dues (one older than this change) leaves the root as a root with no deadline: never an unbounded wait, never overdue", async () => {
    for (const r of [A, B]) {
      const plain = r.rows.filter((x) => x.shape !== "due")
      const note: any = { root: r.root.id, awaits: true }
      const got = await applicable([...shared, ...r.rows], [], NOW, note)
      const none = await applicable([...shared, ...plain], [], NOW, { root: r.root.id, awaits: true, dues: [] })
      expect(got.filter((c) => c.kind === "wait-for")).toEqual([])
      expect(note.overdue).toBeUndefined()
      expect(got.map((c) => c.id).filter((id) => id !== "produce/outcome/ch1")).toEqual(none.map((c) => c.id).filter((id) => id !== "produce/outcome/ch1"))
    }
  })
})
