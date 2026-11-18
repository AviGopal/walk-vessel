// SPDX-License-Identifier: MIT
// A row made on another root is shown, never worked (loop.ts worksOn). A root's rows may hold a row whose `root` names
// another root (records joining a row named by another root's work). Its producers are handed it (the pool), but it is
// never this root's work: not a call offered here, not this root's decline, not an answer its grade may judge, not a
// clone binding's statement, not news for its stall count. A row naming no root (a person's follow-up that cites this
// root) and, on a gap, a row naming an earlier row of the same gap stay this root's work exactly as before.
// Rows are in the live forms: selections with root, pool_refs [root] and seen_key; described rows with root and
// selection_ref (produce.ts writes both); a gap episode of several detector rows of one gap_id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const realFetch = globalThis.fetch
type Loop = typeof import("../src/loop")
let choices: Loop["choices"]
let stalls: Loop["stalls"]
beforeAll(async () => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
  })
  globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v", endpoint: "http://v.test" }] } })) as typeof fetch
  ;({ choices, stalls } = await import("../src/loop"))
})
afterAll(() => { globalThis.fetch = realFetch })

const now = Date.parse("2026-11-17T12:00:00Z")
const t = "2026-11-17T11:59:00Z"
// The owner's configuration, as the seed writes it: a channel, the answer, outcome and request schemas.
const shared = [
  { shape: "channel", id: "ch1", seq: 1, role: "owner", writer: "owner", calls: [] },
  { shape: "shape_schema", id: "s-answer", seq: 2, role: "owner", writer: "owner", target: "answer", inputs: ["world_changed"],
    context: ["request", "failure", { shape: "hop", where: { phase: "ended", kind: ["call", "run"] } }] },
  { shape: "shape_schema", id: "s-outcome", seq: 3, role: "owner", writer: "owner", target: "outcome", inputs: ["world_changed"],
    context: ["answer", "due", { shape: "hop", where: { phase: "ended", kind: ["call", "run"] } }] },
]
const askA = { shape: "world_changed", id: "wA", seq: 10, t, role: "person", writer: "hsv", input_refs: [] }
const askB = { shape: "world_changed", id: "wB", seq: 11, t, role: "person", writer: "hsv", input_refs: [] }
// A produce selection on a root, as the walk writes it (selectionRow), and a described row made under it.
const sel = (id: string, seq: number, root: string, a: string) =>
  ({ shape: "selection", id, seq, t, role: "walk", writer: "walk-test", arm: "arm1", a, cell: `${a}|asker:person,age:0`,
    context: ["asker:person", "age:0"], cell_scheme: "reads", root, pool_refs: [root], seen_key: `k-${id}` })
const made = (shape: string, id: string, seq: number, root: string, selection: string, cites: string[], extra: Record<string, unknown> = {}) =>
  ({ shape, id, seq, t, role: "described", writer: "described-shape-vessel", input_refs: cites, context_omitted: 0, root,
    selection_ref: selection, call_id: `c-${id}`, producer: "model", ...extra })

// Root A's producer was shown B's ask (a follow-up joined A under the person rule) and named it: its request and answer
// cite wB and carry root wA. Joined into B's rows, they are B's to see, never B's to work.
const selA = sel("sA", 20, "wA", "produce/request/ch1")
const reqA = made("request", "qA", 21, "wA", "sA", ["wA", "wB"], { pointer: { type: "git_diff", cwd: "/trees/a" }, uses: ["wB"] })
const declineA = made("request", "qA0", 23, "wA", "sA", ["wA", "wB"], { none: "nothing more to call", uses: ["wB"] })
const ansA = made("answer", "aA", 22, "wA", "sA", ["wA", "wB"], { text: "done on A", uses: ["wB"] })

const of = (got: Awaited<ReturnType<Loop["choices"]>>, root: string) => got.filter((o) => o.root === root)
const ids = (got: Awaited<ReturnType<Loop["choices"]>>, root: string) => of(got, root).map((o) => o.cand.id).sort()

describe("W1: a request made on another root is not called here and is not this root's decline", () => {
  test("[MUST-FAIL] another root's request in B's rows offers no call on B", async () => {
    const got = await choices(shared as any, [{ root: askB as any, rows: [askB, reqA] as any, awaits: true }], now)
    expect(ids(got, "wB").filter((id) => id.startsWith("call/"))).toEqual([])
  })
  test("[MUST-FAIL] another root's decline, newer than B's own request, does not make B read as declined", async () => {
    const selB = sel("sB", 30, "wB", "produce/request/ch1")
    const reqB = made("request", "qB", 31, "wB", "sB", ["wB"], { pointer: { type: "git_status", cwd: "/trees/b" } })
    const later = { ...declineA, seq: 40 }
    const got = await choices(shared as any, [{ root: askB as any, rows: [askB, selB, reqB, later] as any, awaits: true }], now)
    expect(ids(got, "wB").filter((id) => id.startsWith("call/"))).toEqual(["call/git_status"])
    expect(of(got, "wB").find((o) => o.cand.id === "call/git_status")?.cand.from).toBe("qB")
  })
})

describe("W2: an answer made on another root does not make this root's grade judgeable", () => {
  test("[MUST-FAIL] B with no answer of its own: no outcome produce is offered over A's answer", async () => {
    const got = await choices(shared as any, [{ root: askB as any, rows: [askB, ansA] as any, awaits: true }], now)
    expect(ids(got, "wB")).not.toContain("produce/outcome/ch1")
    // nor does A's answer stand as B's own: B's answer is still to be produced
    expect(ids(got, "wB")).toContain("produce/answer/ch1")
  })
  test("[GUARD] B's own answer makes its grade judgeable, A's beside it or not", async () => {
    const selB = sel("sB", 30, "wB", "produce/answer/ch1")
    const ansB = made("answer", "aB", 31, "wB", "sB", ["wB"], { text: "done on B" })
    for (const rows of [[askB, selB, ansB], [askB, selB, ansB, ansA]]) {
      const got = await choices(shared as any, [{ root: askB as any, rows: rows as any, awaits: true }], now)
      expect(ids(got, "wB")).toContain("produce/outcome/ch1")
    }
  })
})

describe("W3: a row made on another root is still handed to this root's producers", () => {
  test("[GUARD] every option on B carries A's rows in the pool its producer is handed", async () => {
    const got = await choices(shared as any, [{ root: askB as any, rows: [askB, reqA, ansA] as any, awaits: true }], now)
    expect(of(got, "wB").length).toBeGreaterThan(0)
    for (const o of of(got, "wB")) expect(["qA", "aA"].every((id) => o.pool.some((r) => r.id === id))).toBe(true)
  })
  test("[MUST-FAIL] a move's cell is keyed on B's own work: A's answer in the pool does not change B's cells", async () => {
    const alone = await choices(shared as any, [{ root: askB as any, rows: [askB] as any, awaits: true }], now)
    const joined = await choices(shared as any, [{ root: askB as any, rows: [askB, ansA, reqA] as any, awaits: true }], now)
    const cells = (got: typeof alone) => of(got, "wB").map((o) => o.cell).sort()
    expect(cells(joined)).toEqual(cells(alone))
  })
})

describe("W4: a row made on another root is not news for this root's stall count", () => {
  const rule = { shape: "stall_rule", id: "sr", seq: 1, role: "owner", after_rows: 20 }
  test("[MUST-FAIL] B sat since its ask; A's answer joined later does not restart the count", () => {
    const late = { ...ansA, seq: 50 }
    const rows = stalls([rule as any], [{ root: askB as any, rows: [askB, late] as any }], [], 60)
    expect(rows).toEqual([{ shape: "failure", kind: "stall", root: "wB", rows: 20, since_seq: 11, input_refs: ["wB"] }])
  })
  test("[GUARD] B's own answer does restart it", () => {
    const own = made("answer", "aB", 50, "wB", "sB", ["wB"])
    expect(stalls([rule as any], [{ root: askB as any, rows: [askB, own] as any }], [], 60)).toEqual([])
  })
})

describe("a clone binding reads only this root's statement", () => {
  // B holds two clones; the owner binds the clone of the repo B's own newest change_wanted names. A's change_wanted, which
  // named B's ask (cites wB), is newer and names the other repo.
  const clone = (id: string, seq: number, repo: string) =>
    ({ shape: "gitWorktree", id, seq, t, writer: "walk-test", role: "walk", call_id: `c-${id}`, cwd: `/trees/${repo}`, repo, selection_ref: "sB", input_refs: ["wB"] })
  const binding = { shape: "clone_binding", id: "cb", seq: 4, role: "owner", writer: "owner", of: "gitWorktree", by: [{ shape: "change_wanted", field: "repo" }] }
  // an earned template, shared to every root: made on another root, so it names that root, and is run here all the same
  const tmpl = { shape: "activity_template", id: "t-d", seq: 5, role: "described", writer: "described-shape-vessel", root: "wA", selection_ref: "sA", sig: { in: ["gitWorktree"], out: ["gitDiff"] },
    calls: [{ shape: "git_diff", pointer: { cwd: "{{ sig.in[0].cwd }}" } }] }
  test("[MUST-FAIL] A's newer change_wanted citing B does not choose B's clone: B's own statement does", async () => {
    const own = made("change_wanted", "cwB", 33, "wB", "sB", ["wB"], { wanted: true, repo: "super" })
    const far = made("change_wanted", "cwA", 34, "wA", "sA", ["wA", "wB"], { wanted: true, repo: "records-vessel", uses: ["wB"] })
    const rows = [askB, sel("sB", 30, "wB", "call/git_clone"), clone("gs", 31, "super"), clone("gr", 32, "records-vessel"), own, far]
    const got = await choices([...shared, binding, tmpl] as any, [{ root: askB as any, rows: rows as any, awaits: true }], now)
    const run = of(got, "wB").find((o) => o.cand.id === "run/t-d")
    expect(run?.cand.inputs?.map((r) => r?.id)).toEqual(["gs"])
  })
})

describe("what stays this root's work", () => {
  test("[GUARD] a person's follow-up that cites B (no root field) is worked on B exactly as before: its ask re-offers B's answer", async () => {
    // B was answered under a selection that kept what it was handed; a person's follow-up citing B joined after it.
    const selB = sel("sB", 30, "wB", "produce/answer/ch1")
    const ansB = made("answer", "aB", 31, "wB", "sB", ["wB"], { text: "done on B" })
    const follow = { shape: "world_changed", id: "wC", seq: 40, t, role: "person", writer: "hsv", input_refs: ["aB"] }
    const before = await choices(shared as any, [{ root: askB as any, rows: [askB, selB, ansB] as any, awaits: true }], now)
    const after = await choices(shared as any, [{ root: askB as any, rows: [askB, selB, ansB, follow] as any, awaits: true }], now)
    expect(ids(before, "wB")).not.toContain("produce/answer/ch1")
    expect(ids(after, "wB")).toContain("produce/answer/ch1")
  })
  test("[GUARD] a person's follow-up is news for B's stall count, as before", () => {
    const rule = { shape: "stall_rule", id: "sr", seq: 1, role: "owner", after_rows: 20 }
    const follow = { shape: "world_changed", id: "wC", seq: 50, t, role: "person", writer: "hsv", input_refs: ["wB"] }
    expect(stalls([rule as any], [{ root: askB as any, rows: [askB, follow] as any }], [], 60)).toEqual([])
  })
  // A gap's root moves each time its detector writes the gap again; the work done under an earlier row of the episode
  // names that row as its root.
  const gap = (id: string, seq: number, extra: Record<string, unknown> = {}) =>
    ({ shape: "gap", id, seq, t, role: "detector", writer: "pull-sync", gap_id: "failing-test-x", status: "open", repo: "super", input_refs: [], ...extra })
  const g1 = gap("g1", 10), g2 = gap("g2", 25), g3 = gap("g3", 45)
  test("[GUARD] on a gap, a request made under an earlier row of the same gap is still called", async () => {
    const s = sel("sg", 26, "g2", "produce/request/gap/ch1")
    const q = made("request", "qg", 27, "g2", "sg", ["g2"], { pointer: { type: "git_diff", cwd: "/trees/super" } })
    const got = await choices(shared as any, [{ root: g3 as any, rows: [g1, g2, s, q, g3] as any, awaits: true }], now)
    expect(ids(got, "g3")).toContain("call/git_diff")
  })
  test("[MUST-FAIL] on a gap, a row naming a detector row of ANOTHER gap is not this gap's work", async () => {
    const other = gap("h1", 12, { gap_id: "failing-test-y" })
    const s = sel("sh", 26, "h1", "produce/request/gap/ch1")
    const q = made("request", "qh", 27, "h1", "sh", ["h1", "g3"], { pointer: { type: "git_diff", cwd: "/trees/super" } })
    const got = await choices(shared as any, [{ root: g3 as any, rows: [g1, g2, other, s, q, g3] as any, awaits: true }], now)
    expect(ids(got, "g3").filter((id) => id.startsWith("call/"))).toEqual([])
  })
  test("[GUARD] on a gap, an answer made under an earlier row of the same gap holds its stall count", () => {
    const rule = { shape: "stall_rule", id: "sr", seq: 1, role: "owner", after_rows: 20 }
    const a = made("answer", "ag", 50, "g2", "sg", ["g2"])
    expect(stalls([rule as any], [{ root: g3 as any, rows: [g1, g2, g3, a] as any }], [], 65)).toEqual([])
  })
})

describe("the walk's idle wait is bounded by the roots' own deadlines", () => {
  test("[MUST-FAIL] another root's deadline in a root's rows does not bound the idle wait", async () => {
    // a gap root with nothing to do (no schema takes a gap here) sends the walk to its idle wait
    const g = { shape: "gap", id: "g1", seq: 10, t, role: "detector", writer: "pull-sync", gap_id: "failing-test-x", status: "open", input_refs: [] }
    const arm = { shape: "arm", id: "arm1", seq: 2, t, role: "owner", writer: "owner", arm: "walk-arm", vessel_id: "walk-test", as_of_seq: 0 }
    const dueA = made("due", "dA", 30, "wA", "sA", ["wA"], { within_ms: 600_000, at: now + 600_000 })
    const got = await choices(shared as any, [{ root: g as any, rows: [g, dueA] as any, awaits: true }], now, {}, arm as any)
    expect(got.map((o) => [o.root, o.cand.kind, o.cand.pointer.until])).toEqual([["arm1", "wait-for", undefined]])
  })
})

describe("the same-gap reading holds only for a gap's own detector rows", () => {
  const rule = { shape: "stall_rule", id: "sr", seq: 1, role: "owner", after_rows: 20 }
  test("[MUST-FAIL] two asks that are not gaps: a row made on the other ask, joined here, is not this ask's work", async () => {
    // A's ask is a follow-up citing B's (joined into B's rows under the person rule, no root of its own); the work done on
    // A names A. Neither ask has a gap_id, so they are never one gap.
    const askA2 = { shape: "world_changed", id: "wA2", seq: 12, t, role: "person", writer: "hsv", input_refs: ["wB"] }
    const q = made("request", "qA2", 21, "wA2", "sA2", ["wA2", "wB"], { pointer: { type: "git_diff", cwd: "/trees/a" } })
    const a = made("answer", "aA2", 50, "wA2", "sA2", ["wA2", "wB"], { text: "done on A" })
    const calls = await choices(shared as any, [{ root: askB as any, rows: [askB, askA2, q] as any, awaits: true }], now)
    expect(ids(calls, "wB").filter((id) => id.startsWith("call/"))).toEqual([])
    const grade = await choices(shared as any, [{ root: askB as any, rows: [askB, askA2, a] as any, awaits: true }], now)
    expect(ids(grade, "wB")).not.toContain("produce/outcome/ch1")
    expect(stalls([rule as any], [{ root: askB as any, rows: [askB, askA2, a] as any }], [], 60).length).toBe(1)
  })
  const gap = (id: string, seq: number, extra: Record<string, unknown> = {}) =>
    ({ shape: "gap", id, seq, t, role: "detector", writer: "pull-sync", gap_id: "failing-test-x", status: "open", repo: "super", input_refs: [], ...extra })
  const g3 = gap("g3", 45)
  test("[MUST-FAIL] on a gap, a row naming a row of ANOTHER SHAPE that carries the same gap_id is not this gap's work", async () => {
    const x = { shape: "failure", id: "fx", seq: 20, t, role: "detector", writer: "pull-sync", gap_id: "failing-test-x", input_refs: [] }
    const q = made("request", "qx", 27, "fx", "sx", ["fx", "g3"], { pointer: { type: "git_diff", cwd: "/trees/super" } })
    const got = await choices(shared as any, [{ root: g3 as any, rows: [x, q, g3] as any, awaits: true }], now)
    expect(ids(got, "g3").filter((id) => id.startsWith("call/"))).toEqual([])
  })
  test("[MUST-FAIL] on a gap, a row naming a gap row of ANOTHER ROLE that carries the same gap_id is not this gap's work", async () => {
    const x = gap("gx", 20, { role: "owner", writer: "owner" })
    const q = made("request", "qx", 27, "gx", "sx", ["gx", "g3"], { pointer: { type: "git_diff", cwd: "/trees/super" } })
    const got = await choices(shared as any, [{ root: g3 as any, rows: [x, q, g3] as any, awaits: true }], now)
    expect(ids(got, "g3").filter((id) => id.startsWith("call/"))).toEqual([])
  })
})
