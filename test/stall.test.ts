// SPDX-License-Identifier: MIT
// A root with no move is said (law 6): once its newest row is the owner's stall_rule N store rows behind this tick's
// selection, one failure row of kind stall, blaming no one and closing nothing; said once per change: the count runs
// from the root's newest row that is not its own stall row, and an unchanged root is not said again. No read is made.
// With no rule, nothing.
import { beforeAll, describe, expect, test } from "bun:test"

describe("a root with no move", () => {
  let stalls: typeof import("../src/loop").stalls
  beforeAll(async () => {
    Object.assign(process.env, { WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k" })
    stalls = (await import("../src/loop")).stalls
  })
  const rule = (n: number, extra: Record<string, unknown> = {}) => ({ shape: "stall_rule", id: "sr", seq: 1, role: "owner", after_rows: n, ...extra })
  const open = { root: { shape: "gap", id: "g1", seq: 10, role: "detector" }, rows: [{ shape: "hop", id: "h1", seq: 40, role: "walk" }] }
  const other = { root: { shape: "gap", id: "g2", seq: 11, role: "detector" }, rows: [] }

  test("[MUST-FAIL] N rows after its newest with no move, one stall row naming the root; it blames no one and closes nothing", () => {
    const rows = stalls([rule(20)], [open, other], [{ root: "g2" }], 60)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ shape: "failure", kind: "stall", root: "g1", rows: 20, since_seq: 40, input_refs: ["g1"] })
    // no status (never a call's failure), no r (never a grade), no lapse: it is the walk's own word, as a skip is; and
    // no selection_ref: the tick's selection is another root's move, and records would read it as that move failing
    expect(["status", "r", "lapsed", "blames", "selection_ref", "call_id"].filter((k) => k in rows[0])).toEqual([])
  })

  test("[MUST-FAIL] fewer than N rows, a root with a move, a retired, absent, zero or other writer's rule: no row", () => {
    expect(stalls([rule(20)], [open], [], 59)).toEqual([])
    expect(stalls([rule(20)], [open], [{ root: "g1" }], 99)).toEqual([])
    expect(stalls([rule(20, { retired: true })], [open], [], 99)).toEqual([])
    expect(stalls([], [open], [], 99)).toEqual([])
    expect(stalls([rule(0)], [open], [], 99)).toEqual([]) // a count of none is no rule: nothing is said
    expect(stalls([{ ...rule(20), role: "described" }], [open], [], 99)).toEqual([]) // only the owner's rule
  })

  test("[MUST-FAIL] the count runs from the root's newest row; once said, an unchanged root is not said again", () => {
    expect(stalls([rule(20)], [{ root: open.root, rows: [] }], [], 35)).toMatchObject([{ since_seq: 10 }]) // the root alone
    const sat = { root: open.root, rows: [...open.rows, { shape: "failure", id: "st1", seq: 100, role: "walk", kind: "stall" }] }
    expect(stalls([rule(20)], [sat], [], 119)).toEqual([])
    expect(stalls([rule(20)], [sat], [], 120)).toEqual([])
  })
})

describe("a root with no move is said once per change", () => {
  let stalls: typeof import("../src/loop").stalls
  beforeAll(async () => {
    Object.assign(process.env, { WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k" })
    stalls = (await import("../src/loop")).stalls
  })
  const N = 20
  const rule = { shape: "stall_rule", id: "sr", seq: 1, role: "owner", after_rows: N }
  const root = { shape: "gap", id: "g1", seq: 10, role: "detector" }
  // Ticks one row apart from `from` to `to`, each fed the stall rows the ticks before it wrote, as records serves them:
  // every stall row the root got, at the seq it was written.
  const run = (rows: Array<Record<string, unknown>>, from: number, to: number, options: Array<{ root: string }> = []) => {
    const got: Array<Record<string, unknown>> = []
    let held = [...rows]
    for (let at = from; at <= to; at++) {
      for (const w of stalls([rule], [{ root, rows: held as any }], options, at)) {
        const r = { ...w, id: `st${at}`, seq: at, role: "walk", writer: "walk-test" }
        got.push(r)
        held = [...held, r]
      }
    }
    return got
  }

  test("[MUST-FAIL] an unchanged root gets exactly one stall row over 3×N rows", () => {
    const got = run([], 11, 10 + 3 * N + 5)
    expect(got.map((r) => [r.seq, r.since_seq])).toEqual([[10 + N, 10]])
  })
  test("[MUST-FAIL] a new person row after it is a change: it ages N, then the root is said once more", () => {
    const first = run([], 11, 10 + N)
    const person = { shape: "note", id: "p1", seq: 45, role: "person" }
    const got = run([...first, person], 10 + N + 1, 45 + 3 * N)
    expect(got.map((r) => [r.seq, r.since_seq])).toEqual([[45 + N, 45]])
  })
  test("[GUARD] a root with a move this tick (its wait included) gets none, however long it sits", () => {
    expect(run([], 11, 10 + 3 * N, [{ root: "g1" }])).toEqual([])
  })
  test("[MUST-FAIL] a held skip the walk wrote for the root (once per reason) is a change, not a restatement", () => {
    const first = run([], 11, 10 + N)
    const skip = { shape: "failure", id: "k1", seq: 50, role: "walk", kind: "skip", input_refs: ["g1", "q1"] }
    expect(run([...first, skip], 10 + N + 1, 50 + 2 * N).map((r) => r.since_seq)).toEqual([50])
  })
  // Only the walk's own stall row is a restatement: one that differs in any one of its marks is a row of the root.
  for (const [what, row] of [
    ["another writer's stall-kind row", { shape: "failure", role: "described", kind: "stall" }],
    ["a walk failure of another kind", { shape: "failure", role: "walk", kind: "refused" }],
    ["a walk stall-kind failure under a selection (a move's)", { shape: "failure", role: "walk", kind: "stall", selection_ref: "s1" }],
    ["a walk row of another shape marked stall", { shape: "hop", role: "walk", kind: "stall" }],
  ] as const) {
    test(`[MUST-FAIL] ${what} after the stall row is a change`, () => {
      const first = run([], 11, 10 + N)
      const got = run([...first, { id: "x1", seq: 50, ...row }], 10 + N + 1, 50 + 2 * N)
      expect(got.map((r) => r.since_seq)).toEqual([50])
    })
  }
})

describe("what the walk's own producers say in answer to a stall is not a change", () => {
  let stalls: typeof import("../src/loop").stalls
  beforeAll(async () => {
    Object.assign(process.env, { WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k" })
    stalls = (await import("../src/loop")).stalls
  })
  const N = 20
  const rule = { shape: "stall_rule", id: "sr", seq: 1, role: "owner", after_rows: N }
  const root = { shape: "gap", id: "g1", seq: 10, role: "detector" }
  // A produce on the root as live rows carry it (5449: selection 82060, request_acts 82061, hop 82062, request 82063
  // with `none` citing the stall row, hop 82064): the selection, its fact and hops, and what it produced.
  const produce = (seq: number, made: Record<string, unknown>, cites: string[] = []) => [
    { shape: "selection", id: `ps${seq}`, seq, role: "walk", root: "g1", a: "produce/request/gap/ch1" },
    { shape: "request_acts", id: `ra${seq}`, seq: seq + 1, role: "walk", selection_ref: `ps${seq}`, input_refs: ["g1"] },
    { shape: "hop", id: `ph${seq}`, seq: seq + 2, role: "walk", phase: "started", kind: "produce", selection_ref: `ps${seq}` },
    { shape: "request", id: `rq${seq}`, seq: seq + 3, role: "described", selection_ref: `ps${seq}`, input_refs: ["g1", ...cites], ...made },
    { shape: "hop", id: `pe${seq}`, seq: seq + 4, role: "walk", phase: "ended", kind: "produce", selection_ref: `ps${seq}` },
  ]
  const decline = { none: "the gap is held: nothing can be done here" }
  const call = (seq: number) => [
    { shape: "selection", id: `cs${seq}`, seq, role: "walk", root: "g1", a: "call/fs_edit" },
    { shape: "hop", id: `cs${seq}h`, seq: seq + 1, role: "walk", phase: "started", kind: "call", selection_ref: `cs${seq}` },
    { shape: "hop", id: `cs${seq}e`, seq: seq + 2, role: "walk", phase: "ended", kind: "call", selection_ref: `cs${seq}`, output: { shape: "fileEditResult", path: "/c/a.ts", ok: true } },
  ]
  // Ticks one row apart; each stall row written goes back into the root's rows, and the producer answers it `after`
  // rows later with what `reply` makes (citing the stall row), as the walk re-offers it.
  const run = (rows: Array<Record<string, unknown>>, from: number, to: number, reply?: (seq: number, stall: string) => Array<Record<string, unknown>>, after = 5,
    later: Array<[number, Array<Record<string, unknown>>]> = []) => {
    const got: Array<Record<string, unknown>> = []
    let held = [...rows]
    const due: Array<[number, Array<Record<string, unknown>>]> = [...later]
    for (let at = from; at <= to; at++) {
      for (const [when, rs] of due) if (when === at) held = [...held, ...rs]
      for (const w of stalls([rule], [{ root, rows: held as any }], [], at)) {
        const r = { ...w, id: `st${at}`, seq: at, role: "walk", writer: "walk-test" }
        got.push(r)
        held = [...held, r]
        if (reply) due.push([at + after, reply(at + after, r.id)])
      }
    }
    return got
  }

  test("[MUST-FAIL] said, then a decline in answer (5449's rows): never said again over 3×N", () => {
    const got = run([], 11, 10 + 4 * N, (seq, st) => produce(seq, decline, [st]))
    expect(got.map((r) => r.seq)).toEqual([10 + N])
  })
  test("[MUST-FAIL] the producer's answer is not a change whatever it produced (an answer or a due, not only a decline)", () => {
    for (const made of [{ shape: "answer", text: "nothing to do" }, { shape: "due", within_ms: 60_000 }]) {
      const got = run([], 11, 10 + 4 * N, (seq, st) => produce(seq, made, [st]).map((r) => (r.role === "described" ? { ...r, ...made } : r)))
      expect([made.shape, got.length]).toEqual([made.shape, 1])
    }
  })
  test("[GUARD] a request with a pointer in answer is no change itself; the call it asks for is, and the root is said again N rows after it", () => {
    const got = run([], 11, 10 + 4 * N, (seq, st) => (seq < 40 ? [...produce(seq, { pointer: { type: "fs_edit" } }, [st]), ...call(seq + 6)] : []))
    // said at 30; the answer at 35, its call at 41-43: said again at 43 + N
    expect(got.map((r) => [r.seq, r.since_seq])).toEqual([[30, 10], [43 + N, 43]])
  })
  test("[MUST-FAIL] a person's row after a decline is a change: said once more, N rows after it", () => {
    const first = run([], 11, 10 + N, (seq, st) => produce(seq, decline, [st]))
    const held = [...first, ...produce(35, decline, [String(first[0].id)]), { shape: "note", id: "p1", seq: 45, role: "person" }]
    expect(run(held, 31, 45 + 3 * N, (seq, st) => produce(seq, decline, [st])).map((r) => [r.seq, r.since_seq])).toEqual([[45 + N, 45]])
  })
  test("[GUARD] a produce already in flight when the root was said (its selection older than the stall row) is a change when it lands", () => {
    // its selection, fact and started hop at 25-27; the root is said at 27 + N; what it made lands after, at 50 and 51
    const [sel, fact, started, made, ended] = produce(25, decline)
    const got = run([sel, fact, started], 28, 51 + 3 * N, undefined, 5, [[50, [{ ...made, seq: 50 }]], [51, [{ ...ended, seq: 51 }]]])
    expect(got.map((r) => [r.seq, r.since_seq])).toEqual([[27 + N, 27], [51 + N, 51]])
  })
  test("[GUARD] before the root is ever said, a produce's rows are changes like any other (the first stall counts from them)", () => {
    expect(run(produce(25, decline), 31, 29 + 2 * N).map((r) => [r.seq, r.since_seq])).toEqual([[29 + N, 29]])
  })
  test("a fresh root is still said the first time; a root no longer open (closed by an outcome) is not passed and is not said (guards)", () => {
    expect(run([], 11, 10 + N).map((r) => r.seq)).toEqual([10 + N])
    expect(stalls([rule], [], [], 10 + 3 * N)).toEqual([])
  })
})
