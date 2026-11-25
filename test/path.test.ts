// SPDX-License-Identifier: MIT
// The route back from the call that reaches a root (the owner's credits row: a gap is reached by a landing), through each
// call's own preconditions, to what is here: the calls on it and those callable now are named on request_acts for the
// producer, so a commit made callable is the step named toward the landing, not any open call. A root whose gap sits
// under the owner's protected list has no route: its links are named, every call stays offered but marked off_path,
// and the root is drawn at the owner's weight.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const realFetch = globalThis.fetch
const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
type Cand = { id: string; kind: string; off_path?: true }
let applicable: (pool: any[], skipped?: any[], now?: number, note?: any, answers?: Record<string, string>) => Promise<Cand[]>
let choices: (shared: any[], roots: Array<{ root: any; rows: any[] }>, now?: number, answers?: Record<string, string>) => Promise<any[]>
let choose: (seed: number, options: Array<{ root: string; path?: any }>, posts: any[], w?: number) => number
let noPathWeight: (shared: any[]) => number
let actsFactRow: (pool: any[], root: string, write: (row: object) => Promise<any>, sel?: string, gated?: Record<string, string[]>, frontier?: any, path?: any) => Promise<string | undefined>
let selectionRow: (arm: string, options: any[], post: { at_seq: number; posts: any[] }, seed: number, i: number, timing: any, w?: number) => Record<string, unknown>
beforeAll(async () => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
  })
  globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
  applicable = (await import("../src/applicable")).applicable as never
  const loop = await import("../src/loop")
  choices = loop.choices as never
  choose = loop.choose as never
  noPathWeight = (loop as any).noPathWeight
  selectionRow = loop.selectionRow as never
  actsFactRow = (await import("../src/acts")).actsFactRow as never
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]
})

const ANSWERS = { git_land: "gitLand", git_diff: "gitDiff", git_commit: "gitCommitResult", fs_edit: "fileEditResult", fs_read: "fileContent",
  git_worktree: "gitWorktree", code_search: "searchResult" }
const owner = (id: string, seq: number, row: object) => ({ id, seq, writer: "owner", role: "owner", ...row })
const cwd = { "x-pointer": "cwd" }
const OUT = { "x-outside": { shape: "autonomyScope", field: "excluded_paths" } }
const SITE = "repos/x-vessel/src/index.ts"
// the protected list as the owner holds it: before the person took the gap's edit site off it, and now
const BEFORE = ["scripts/substrate/", ".claude/", SITE]
const NOW = ["scripts/substrate/", ".claude/"]
const scope = (list: string[], id = "sc", seq = -1) => owner(id, seq, { shape: "autonomyScope", excluded_paths: list })
const CREDITS = owner("cr", -2, { shape: "credits", target: "gap", by_call: "git_land" })
// the land chain as the owner's seed shapes it: a landing needs a verdict of 1 and an open gap out of the list's reach; a
// verdict is made from the gap and a diff; a diff needs a commit in the clone; a commit an edit in it; an edit a read of
// the file and a clone; a clone an open gap out of reach
const CHAIN = [
  CREDITS,
  owner("rq-land-v", 1, { shape: "requires", for: "git_land", needs: "land_verdict", where: { r: 1 }, latest_by: "tree", group: "verdict" }),
  owner("rq-land-g", 2, { shape: "requires", for: "git_land", needs: "gap", where: { status: "open", "meta.edit_site": OUT }, latest_by: "gap_id", group: "gap" }),
  owner("s-verdict", 3, { shape: "shape_schema", target: "land_verdict", inputs: ["gap", { shape: "gitDiff", where: { role: "walk" } }] }),
  owner("rq-diff", 4, { shape: "requires", for: "git_diff", needs: "gitCommitResult", where: { cwd }, latest_by: "cwd", group: "committed" }),
  owner("rq-commit", 5, { shape: "requires", for: "git_commit", needs: "fileEditResult", where: { cwd }, latest_by: "cwd", group: "uncommitted" }),
  owner("rq-edit-r", 6, { shape: "requires", for: "fs_edit", needs: "fileContent", where: { path: { "x-pointer": "path" } }, latest_by: "path", group: "read" }),
  owner("rq-edit-c", 7, { shape: "requires", for: "fs_edit", needs: "gitWorktree", group: "clone" }),
  owner("rq-tree", 8, { shape: "requires", for: "git_worktree", needs: "gap", where: { status: "open", "meta.edit_site": OUT }, latest_by: "gap_id", group: "gap" }),
  owner("s-explain", 9, { shape: "shape_schema", target: "attempt_explanation", inputs: ["gap"] }),
]
const gapRow = (meta: object = { edit_site: SITE, protected_files: ["repos/x-vessel/src/x.test.ts"] }) =>
  ({ shape: "gap", id: "g1", seq: 10, writer: "detector", role: "detector", gap_id: "failing-test-x", repo: "x-vessel", status: "open", meta })
const walkRow = (shape: string, id: string, seq: number, more: object = {}) => ({ shape, id, seq, writer: "walk-test", role: "walk", input_refs: ["g1"], ...more })
const tree = walkRow("gitWorktree", "w1", 11, { cwd: "/trees/x", carried: "commits" })
const edit = walkRow("fileEditResult", "e1", 12, { cwd: "/trees/x", path: "/trees/x/src/index.ts", ok: true })
const why = (id: string, seq: number) => walkRow("attempt_explanation", id, seq)
const request = (id: string, seq: number, type: string) =>
  ({ shape: "request", id, seq, writer: "described", role: "described", pointer: { type, cwd: "/trees/x" }, input_refs: ["g1"] })
// a root as it stands today: a clone, an ok edit in it, then explanations of its attempts
const TODAY = [tree, edit, why("x1", 13), why("x2", 14)]
const run = async (owners: any[], rows: any[]) => {
  const note: any = { root: "g1" }
  const cands = await applicable([...owners, gapRow(), ...rows].sort((a, b) => a.seq - b.seq), [], 1_000, note, ANSWERS)
  return { path: note.path, cands, frontier: note.frontier }
}
const offPath = (cands: Cand[]) => cands.filter((c) => c.kind === "call" && c.off_path === true).map((c) => c.id).sort()

describe("the route back from the call that reaches the root", () => {
  test("[MUST-FAIL] an edit made in the clone, explanations on top: git_commit is the step on the route callable now", async () => {
    const { path } = await run([...CHAIN, scope(NOW)], TODAY)
    expect(path).toEqual({ call: "git_land", calls: ["git_commit", "git_diff", "git_land"], next: ["git_commit"] })
  })

  test("[MUST-FAIL] the route follows each call's own preconditions back past the call: with only the gap here, the clone and the read come first", async () => {
    const { path } = await run([...CHAIN, scope(NOW)], [])
    expect(path).toEqual({ call: "git_land", calls: ["fs_edit", "fs_read", "git_commit", "git_diff", "git_land", "git_worktree"], next: ["fs_read", "git_worktree"] })
  })

  test("[MUST-FAIL] the edit in another clone than the newest one: the commit is not callable for it, and the route runs through a new edit", async () => {
    const newer = walkRow("gitWorktree", "w2", 15, { cwd: "/trees/z", carried: "commits" })
    const { path } = await run([...CHAIN, scope(NOW)], [...TODAY, newer])
    expect(path.next).not.toContain("git_commit")
    expect(path.calls).toContain("fs_edit")
  })

  test("[MUST-FAIL] the gap's edit site under the protected list: no route, its link named with the entry covering it", async () => {
    const { path } = await run([...CHAIN, scope(BEFORE)], TODAY)
    expect(path?.call).toBe("git_land")
    expect(path?.calls).toBeUndefined()
    expect(path?.broken).toEqual([`gap for git_land: meta.edit_site: "${SITE}" is under autonomyScope's "${SITE}"`])
  })

  test("[MUST-FAIL] the newest list row decides: an older one protecting the site is replaced", async () => {
    const { path } = await run([...CHAIN, scope(BEFORE, "sc0", -3), scope(NOW, "sc1", -1)], TODAY)
    expect(path?.next).toEqual(["git_commit"])
    const back = await run([...CHAIN, scope(NOW, "sc0", -3), scope(BEFORE, "sc1", -1)], TODAY)
    expect(back.path?.broken?.length).toBe(1)
  })

  test("[MUST-FAIL] a directory entry covers the tree under it, never a sibling; a file entry covers only itself", async () => {
    expect((await run([...CHAIN, scope(["repos/x-vessel/"])], TODAY)).path?.broken?.length).toBe(1)
    expect((await run([...CHAIN, scope(["repos/x-vessel/src/"])], TODAY)).path?.broken?.length).toBe(1)
    expect((await run([...CHAIN, scope(["repos/x-vess/", "repos/x-vessel2/"])], TODAY)).path?.next).toEqual(["git_commit"])
    expect((await run([...CHAIN, scope(["repos/x-vessel/src"])], TODAY)).path?.next).toEqual(["git_commit"])
  })

  test("[MUST-FAIL] a gap with no edit site yet (not localized) is not out of reach: the route stands", async () => {
    const note: any = { root: "g1" }
    await applicable([...CHAIN, scope(BEFORE), gapRow({ protected_files: ["repos/x-vessel/src/x.test.ts"] }), ...TODAY].sort((a, b) => a.seq - b.seq), [], 1_000, note, ANSWERS)
    expect(note.path?.next).toEqual(["git_commit"])
  })

  test("[MUST-FAIL] with no list row the site is not judged: the route stands", async () => {
    expect((await run(CHAIN, TODAY)).path?.next).toEqual(["git_commit"])
  })

  test("[MUST-FAIL] the call reaching the root is the credits row's, not a fixed one", async () => {
    const other = CHAIN.map((r) => r.id === "cr" ? owner("cr", -2, { shape: "credits", target: "gap", by_call: "git_diff" }) : r)
    expect((await run([...other, scope(NOW)], TODAY)).path).toEqual({ call: "git_diff", calls: ["git_commit", "git_diff"], next: ["git_commit"] })
  })

  test("[GUARD] a root kind with no credits row has no route named and no call marked", async () => {
    const { path, cands } = await run([...CHAIN.filter((r) => r.id !== "cr"), scope(BEFORE)], [...TODAY, request("q1", 20, "code_search")])
    expect(path).toBeUndefined()
    expect(offPath(cands)).toEqual([])
  })

  test("[MUST-FAIL] a list in a schema's input entry is read there too: the verdict's gap input out of reach leaves no route", async () => {
    const viaInput = [...CHAIN.filter((r) => r.id !== "rq-land-g" && r.id !== "s-verdict"),
      owner("s-verdict", 3, { shape: "shape_schema", target: "land_verdict", inputs: [{ shape: "gap", where: { "meta.edit_site": OUT } }, { shape: "gitDiff", where: { role: "walk" } }] })]
    expect((await run([...viaInput, scope(NOW)], TODAY)).path?.next).toEqual(["git_commit"])
    const none = (await run([...viaInput, scope(BEFORE)], TODAY)).path
    expect(none?.broken).toEqual(["gap for land_verdict"])
  })

  test("[MUST-FAIL] a list in a requires row's where is read where the frontier's takers are named", async () => {
    const takes = owner("rq-search", 30, { shape: "requires", for: "code_search", needs: "attempt_explanation", where: { repo_path: OUT } })
    const at = (p: string) => walkRow("attempt_explanation", "x3", 16, { repo_path: p })
    expect((await run([...CHAIN, scope(NOW), takes], [...TODAY, at("repos/y-vessel/src/a.ts")])).frontier?.calls).toEqual(["code_search"])
    expect((await run([...CHAIN, scope(["repos/y-vessel/"]), takes], [...TODAY, at("repos/y-vessel/src/a.ts")])).frontier?.calls).toEqual([])
  })
})

describe("calls on no route are offered, marked", () => {
  test("[MUST-FAIL] with a route, a call off it is marked off_path and the commit on it is not", async () => {
    const { cands } = await run([...CHAIN, scope(NOW)], [...TODAY, request("q1", 20, "code_search"), request("q2", 21, "git_commit")])
    expect(cands.filter((c) => c.kind === "call").map((c) => c.id).sort()).toEqual(["call/code_search", "call/git_commit"])
    expect(offPath(cands)).toEqual(["call/code_search"])
  })

  test("[MUST-FAIL] with no route, every call is offered and marked", async () => {
    const { cands } = await run([...CHAIN, scope(BEFORE)], [...TODAY, request("q1", 20, "code_search"), request("q2", 21, "git_commit")])
    expect(offPath(cands)).toEqual(["call/code_search", "call/git_commit"])
  })
})

describe("the route on the rows a producer and a reader see", () => {
  const SHARED = [owner("ch1", -5, { shape: "channel", calls: [] }), owner("s-request", -4, { shape: "shape_schema", target: "request", inputs: ["gap"] }), ...CHAIN]
  test("[MUST-FAIL] through choices(), request_acts names the route and git_commit as the next step", async () => {
    const options = await choices([...SHARED, scope(NOW)], [{ root: gapRow(), rows: [gapRow(), ...TODAY] }], Date.now(), ANSWERS)
    const mine = options.filter((o) => o.root === "g1")
    expect(mine.length).toBeGreaterThan(0)
    const out: any[] = []
    await actsFactRow([gapRow(), ...TODAY], "g1", async (row) => { out.push(row); return { id: "f1" } }, "s1", mine[0].gated, mine[0].frontier, mine[0].path)
    expect(out[0]?.path).toEqual({ call: "git_land", calls: ["git_commit", "git_diff", "git_land"], next: ["git_commit"] })
    expect(out[0]?.no_path).toBeUndefined()
  })

  test("[MUST-FAIL] through choices(), a root with no route says so on request_acts and on its selection, with the weight drawn under", async () => {
    const options = await choices([...SHARED, scope(BEFORE)], [{ root: gapRow(), rows: [gapRow(), ...TODAY] }], Date.now(), ANSWERS)
    const i = options.findIndex((o) => o.root === "g1")
    expect(i).toBeGreaterThanOrEqual(0)
    const out: any[] = []
    await actsFactRow([gapRow(), ...TODAY], "g1", async (row) => { out.push(row); return { id: "f1" } }, "s1", options[i].gated, options[i].frontier, options[i].path)
    expect(out[0]?.no_path?.call).toBe("git_land")
    expect(out[0]?.path).toBeUndefined()
    const sel = selectionRow("arm", options, { at_seq: 1, posts: options.map(() => ({ alpha: 1, beta: 1 })) }, 7, i, {}, 0.25)
    expect(sel.no_path).toBe(true)
    expect(sel.root_weight).toBe(0.25)
  })
})

describe("a change of route alone is a change of what the request is shown", () => {
  test("[MUST-FAIL] the same acts with another route write a new request_acts row; the same route writes none", async () => {
    const out: any[] = []
    const write = async (row: object) => { const r = { ...row, id: `f${out.length}`, seq: 100 + out.length, role: "walk", root: "g1" }; out.push(r); return r }
    const pool = [gapRow(), ...TODAY]
    const first = { call: "git_land", calls: ["git_commit", "git_land"], next: ["git_commit"] }
    await actsFactRow(pool, "g1", write, "s1", {}, undefined, first)
    await actsFactRow([...pool, ...out], "g1", write, "s2", {}, undefined, first)
    expect(out.length).toBe(1)
    await actsFactRow([...pool, ...out], "g1", write, "s3", {}, undefined, { call: "git_land", broken: ["gap for git_land"] })
    expect(out.length).toBe(2)
    expect(out[1].no_path).toEqual({ call: "git_land", broken: ["gap for git_land"] })
  })
})

describe("a root with no route is drawn at the owner's weight, never held", () => {
  const ROUTE = { call: "git_land", calls: ["git_land"], next: [] }
  const NONE = { call: "git_land", broken: ["gap for git_land"] }
  const options = [{ root: "a", path: NONE }, { root: "b", path: ROUTE }]
  const posts = [{ alpha: 1, beta: 1 }, { alpha: 1, beta: 1 }]
  const share = (w: number) => Array.from({ length: 4000 }, (_, s) => choose(s, options, posts, w)).filter((i) => options[i].root === "a").length / 4000

  test("[MUST-FAIL] at w 0.1 the root with no route takes about a tenth of the draws, and some", () => {
    const a = share(0.1)
    expect(a).toBeGreaterThan(0.06)
    expect(a).toBeLessThan(0.14)
  })

  test("[GUARD] at weight 1 the draw is the uniform one", () => {
    const a = share(1)
    expect(a).toBeGreaterThan(0.45)
    expect(a).toBeLessThan(0.55)
  })

  test("[MUST-FAIL] the owner's stall_rule names the weight; none, 0, or above 1 is no weight", () => {
    const rule = (w: unknown, seq = 1) => owner(`sr${seq}`, seq, { shape: "stall_rule", after_rows: 50, no_path_weight: w })
    expect(noPathWeight([rule(0.2)])).toBe(0.2)
    expect(noPathWeight([rule(0.5, 1), rule(0.2, 2)])).toBe(0.2)
    expect(noPathWeight([])).toBe(1)
    expect(noPathWeight([rule(0)])).toBe(1)
    expect(noPathWeight([rule(-1)])).toBe(1)
    expect(noPathWeight([rule(2)])).toBe(1)
  })
})
