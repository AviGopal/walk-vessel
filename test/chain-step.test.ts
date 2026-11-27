// SPDX-License-Identifier: MIT
// The next step takes what the root last made: a call whose serving vessel declares it consumes the shape of the root's
// newest made row (shape_consumes, as discovery answers it: fixtures/shape-consumes-live.json) is offered from that row,
// with no request asking for it, when the route back from the landing names it; its pointer is bound from the row by the
// call's own declaration (binds), once per frontier row. The owner's requires rows are preconditions only. Read from a
// real root's rows (cut to what each leg needs) and a commit after them: commit, then the diff the landing needs.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

type Row = Record<string, any>
type Cand = { id: string; pointer: Record<string, unknown>; from?: string }
const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8").replaceAll('"writer-3"', '"walk-test"')) as { root: Row; rows: Row[]; owner?: Row[] }
const XL = { "x-latest": { shapes: ["gitCommitResult", "gitWorktree", "gitDiff"], moves: ["gitCommitResult", "gitWorktree"], same: "cwd", field: "tree" } }
const CT = { "x-latest": { shapes: ["gitCommitResult", "gitWorktree", "codeReplaceResult"], moves: ["gitCommitResult", "codeReplaceResult"], at: ["gitWorktree"], same: "cwd", field: "committed_tree" } }
// the owner's rows as the seed writes them: a gap is reached by a landing, the landing's verdict, the verdict's diff, and
// git_diff's two preconditions
const LIVE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "shape-consumes-live.json"), "utf8"))
const owner = (): Row[] => [
  { shape: "credits", id: "o-cr", seq: 90000, role: "owner", target: "gap", by_call: "git_land" },
  { shape: "requires", id: "o-land", seq: 90001, role: "owner", for: "git_land", needs: "land_verdict", where: { r: 1, tree: XL }, latest_by: "tree", group: "verdict" },
  { shape: "shape_schema", id: "o-lv", seq: 90002, role: "owner", target: "land_verdict", variant: "gap", inputs: ["gap", { shape: "gitDiff", latest_by: "shape", where: { tree: XL, role: "walk" } }] },
  { shape: "requires", id: "o-dc", seq: 90003, role: "owner", for: "git_diff", needs: "gitCommitResult", where: { committed_tree: CT }, latest_by: "cwd", group: "committed" },
  { shape: "requires", id: "o-dw", seq: 90004, role: "owner", for: "git_diff", needs: "gitWorktree", where: { committed_tree: CT }, latest_by: "cwd", group: "committed" },
]
const ANSWERS = { git_diff: "gitDiff", git_commit: "gitCommitResult", git_clone: "gitWorktree", code_replace_lines: "codeReplaceResult" }

describe("the next step a call is declared to take from the root's newest made row", () => {
  const served = new Set(["git_land", "git_diff", "git_commit", "land_verdict"])
  const realFetch = globalThis.fetch
  let applicable: (pool: Row[], skipped?: Row[], now?: number, note?: Row, answers?: Record<string, string>) => Promise<Cand[]>
  let calls: { shapeAnswers: () => Promise<unknown>; forgetDeclaredInputs: () => void }
  let declares: Record<string, unknown> | undefined
  // what discovery declares each call consumes; undefined: an answer with no shape_consumes
  let consumes: Record<string, unknown> | undefined = LIVE.content.shape_consumes
  beforeAll(async () => {
    Object.assign(process.env, { WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k" })
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, unknown> }
      if (pointer.type === "shapeDescriptions") {
        const { shape_consumes: _c, ...rest } = LIVE.content
        return Response.json({ content: { ...rest, shape_inputs: declares ?? LIVE.content.shape_inputs, ...(consumes ? { shape_consumes: consumes } : {}) } })
      }
      return Response.json({ content: { vessels: served.has(String(pointer.shape)) ? [{ vesselId: "v", endpoint: "http://v.test" }] : [] } })
    }) as typeof fetch
    applicable = (await import("../src/applicable")).applicable as any
    calls = (await import("../src/calls")) as any
  })
  beforeEach(async () => { await calls.shapeAnswers() })
  afterEach(() => { calls.forgetDeclaredInputs(); declares = undefined; consumes = LIVE.content.shape_consumes })
  // reads git_diff's declaration as given, the other calls' as discovery answers them
  const diffTakes = async (binds: Row | undefined, shape = "gitCommitResult") => {
    consumes = { ...LIVE.content.shape_consumes, git_diff: [{ shape, ...(binds ? { binds } : {}) }] }
    await calls.shapeAnswers()
  }
  afterAll(() => { globalThis.fetch = realFetch })

  const f = fx("latest-82ac.json")
  const root = f.root.id as string
  const cwd = (f.rows.find((r) => r.shape === "gitWorktree") as Row).cwd as string
  const T = (n: number) => String(n).repeat(40)
  const ask = { shape: "request", id: "rq-land", seq: 69300, role: "described", pointer: { type: "git_land", cwd }, input_refs: [root] }
  const commit = { shape: "gitCommitResult", id: "k1", seq: 69600, role: "walk", call_id: "ck", cwd, tree: T(2), committed_tree: T(2), input_refs: [root] }
  const chose = (seq: number, frontier: string) => ({ shape: "selection", id: `s${seq}`, seq, role: "walk", a: "call/git_diff", frontier: { id: frontier, shape: "gitCommitResult" }, root })
  const run = async (extra: Row[], rows: Row[] = owner()) =>
    (await applicable([f.root, ...f.rows, ask, ...rows, ...extra], [], Date.now(), { root }, ANSWERS)).filter((c) => c.id === "call/git_diff")

  test("[MUST-FAIL] a commit with the landing gated on its diff: git_diff is offered, on the commit's clone, with no request", async () => {
    const diffs = await run([commit])
    expect(diffs.map((c) => [c.pointer, c.from ?? "none"])).toEqual([[{ type: "git_diff", cwd }, "none"]])
    // what it reads is the frontier row's shape: the cell its grade lands on
    expect(diffs.map((c) => (c as Cand & { reads?: unknown }).reads)).toEqual([["gitCommitResult"]])
  })

  test("[MUST-FAIL] a root with no route (its verdict made from a shape nothing here makes) still has git_diff chained, marked off_path", async () => {
    const broken = owner().map((r) => (r.id === "o-lv" ? { ...r, variant: "", inputs: ["world_changed", ...r.inputs.slice(1)] } : r))
    const diffs = await run([commit], broken)
    expect(diffs.map((c) => [c.pointer, (c as Cand & { off_path?: true }).off_path])).toEqual([[{ type: "git_diff", cwd }, true]])
  })

  test("[MUST-FAIL] each pointer field is the row field binds names for it, not the row's field of the same name", async () => {
    const named = { ...commit, repo_name: "demo" }
    await diffTakes({ cwd: "cwd", repo: "repo_name" })
    const diffs = await run([named])
    expect(diffs.map((c) => c.pointer)).toEqual([{ type: "git_diff", cwd, repo: "demo" }])
  })

  test("[MUST-FAIL] a binds naming type does not change the call", async () => {
    await diffTakes({ cwd: "cwd", type: "call_id" })
    expect((await run([commit])).map((c) => c.pointer)).toEqual([{ type: "git_diff", cwd }])
  })

  test("[MUST-FAIL] only a selection of this call settles it: another move over the same commit, another call over it, or a row of another shape naming the call, does not", async () => {
    const produce = { shape: "selection", id: "s69650", seq: 69650, role: "walk", a: "produce/gitDiff/t1", frontier: { id: "k1", shape: "gitCommitResult" }, root }
    expect((await run([commit, produce])).length).toBe(1)
    const status = { shape: "selection", id: "s69660", seq: 69660, role: "walk", a: "call/git_status", frontier: { id: "k1", shape: "gitCommitResult" }, root }
    expect((await run([commit, status])).map((c) => c.pointer.type)).toEqual(["git_diff"])
    const other = { shape: "stall", id: "st1", seq: 69590, role: "walk", a: "call/git_diff", frontier: { id: "k1", shape: "gitCommitResult" }, root }
    expect((await run([commit, other])).length).toBe(1)
  })

  test("[GUARD] binds that name no field, or are not an object, offer nothing", async () => {
    await diffTakes({})
    expect(await run([commit])).toEqual([])
    await diffTakes(undefined)
    expect(await run([commit])).toEqual([])
    consumes = { ...LIVE.content.shape_consumes, git_diff: [{ shape: "gitCommitResult", binds: ["cwd"] }] }
    await calls.shapeAnswers()
    expect(await run([commit])).toEqual([])
  })

  test("[GUARD] only the offered call's own declaration binds it: another call declared to consume the commit does not", async () => {
    const { git_diff: _d, ...rest } = LIVE.content.shape_consumes
    consumes = { ...rest, git_push: [{ shape: "gitCommitResult", binds: { cwd: "cwd" } }] }
    await calls.shapeAnswers()
    expect(await run([commit])).toEqual([])
  })

  test("[GUARD] fail closed: an answer declaring no consumes, or none at all, chains nothing; the owner's requires rows never take its place", async () => {
    consumes = undefined
    await calls.shapeAnswers()
    expect(await run([commit])).toEqual([])
    // with binds on git_diff's requires row, as the seed writes them until the walk installs
    const bound = owner().map((r) => (r.id === "o-dc" ? { ...r, binds: { cwd: "cwd" } } : r))
    expect(await run([commit], bound)).toEqual([])
    served.delete("shapeDescriptions")
    calls.forgetDeclaredInputs()
    expect(await run([commit], bound)).toEqual([])
  })

  test("[MUST-FAIL] the offered call's own pointer-bound gate is judged on its pointer: met for this clone, it is offered; unmet, it is not", async () => {
    const read = { shape: "requires", id: "o-dr", seq: 90008, role: "owner", for: "git_diff", needs: "fileContent", where: { cwd: { "x-pointer": "cwd" } }, group: "read" }
    expect(await run([commit], [...owner(), read])).toEqual([])
    // written before the commit, so the commit is still the newest made row
    const content = { shape: "fileContent", id: "fc1", seq: 69550, role: "walk", call_id: "cf", cwd, input_refs: [root] }
    expect((await run([content, commit], [...owner(), read])).map((c) => c.pointer)).toEqual([{ type: "git_diff", cwd }])
  })

  test("[MUST-FAIL] offered only when its callee's declared inputs take the pointer", async () => {
    declares = { git_diff: { type: "object", required: ["repo"], properties: { repo: { type: "string" } } } }
    await calls.shapeAnswers()
    expect(await run([commit])).toEqual([])
    declares = { git_diff: { type: "object", required: ["cwd"], properties: { cwd: { type: "string" } } } }
    await calls.shapeAnswers()
    expect((await run([commit])).length).toBe(1)
  })

  test("[MUST-FAIL] the pointer is the commit row's own field: a later checkout handed out elsewhere does not move it", async () => {
    const elsewhere = { shape: "gitWorktree", id: "w9", seq: 69500, role: "walk", call_id: "cw9", cwd: "/workspace/git/walk-trees/another", input_refs: ["another-root"] }
    const diffs = await run([elsewhere, commit])
    expect(diffs.map((c) => c.pointer.cwd)).toEqual([cwd])
  })

  test("[MUST-FAIL] once per frontier row: chosen over this commit, it is not offered again; chosen over an earlier row, it is", async () => {
    expect(await run([commit, chose(69650, "k1")])).toEqual([])
    expect((await run([commit, chose(69650, "k0")])).length).toBe(1)
  })

  test("[GUARD] once the diff is here, it is no longer offered: the diff is the newest made row, and git_diff does not take it", async () => {
    const diff = { shape: "gitDiff", id: "d1", seq: 69700, role: "walk", call_id: "cd", cwd, tree: T(2), head: "h1", input_refs: [root] }
    expect(await run([commit, diff])).toEqual([])
  })

  test("[GUARD] a clean clone with nothing committed since: git_diff is not declared to consume a clone, so it is not offered", async () => {
    const fresh = { shape: "gitWorktree", id: "w2", seq: 69600, role: "walk", call_id: "cw", cwd, tree: T(5), committed_tree: T(5), input_refs: [root] }
    expect(await run([fresh])).toEqual([])
  })

  test("[GUARD] an edit after the commit: the committed tree is not known, so git_diff is gated and not offered", async () => {
    const edit = { shape: "codeReplaceResult", id: "e1", seq: 69700, role: "walk", call_id: "ce", cwd, input_refs: [root] }
    expect(await run([commit, edit])).toEqual([])
  })

  test("[GUARD] which row leads on to which call is the call's declaration: git_diff declared to consume a diff takes no commit", async () => {
    await diffTakes({ cwd: "cwd" }, "gitDiff")
    expect(await run([commit])).toEqual([])
  })

  test("[MUST-FAIL] what takes the row is the declaration, not a requires row's where: a newer commit in another clone is taken, bound to that clone", async () => {
    const other = { shape: "gitCommitResult", id: "k3", seq: 69700, role: "walk", call_id: "ck3", cwd: "/workspace/git/walk-trees/another", tree: T(9), committed_tree: T(9), input_refs: [root] }
    expect((await run([commit, other])).map((c) => c.pointer)).toEqual([{ type: "git_diff", cwd: "/workspace/git/walk-trees/another" }])
  })

  test("[GUARD] a pointer field the row does not carry: binds naming a field the commit lacks offers nothing", async () => {
    await diffTakes({ cwd: "cwd", repo: "repo" })
    expect(await run([commit])).toEqual([])
  })

  test("[GUARD] chained backward to the root's target: with a verdict of the commit's tree here, the landing is not gated, git_diff is on no route back from it, and no diff is offered", async () => {
    // written before the commit, so the commit is still the newest made row and only the landing's verdict decides
    const verdict = { shape: "land_verdict", id: "v1", seq: 69550, role: "described", r: 1, tree: T(2), input_refs: [root] }
    expect(await run([commit, verdict])).toEqual([])
  })

  test("[GUARD] offered as any call is: not with another of its preconditions unmet, not when nothing serves it", async () => {
    const more = { shape: "requires", id: "o-dg", seq: 90005, role: "owner", for: "git_diff", needs: "gap", where: { localized: true }, group: "gap" }
    expect(await run([commit], [...owner(), more])).toEqual([])
    served.delete("git_diff")
    try { expect(await run([commit])).toEqual([]) } finally { served.add("git_diff") }
  })

  test("[GUARD] not over a decline", async () => {
    const decline = { shape: "request", id: "rq-no", seq: 69650, role: "described", input_refs: [root] }
    expect(await run([commit, decline])).toEqual([])
  })

  test("[MUST-FAIL] a refusal of the offered call has no request pointer to key: it settles no request asking for git_diff", async () => {
    const refused = { shape: "failure", id: "fr", seq: 69660, role: "walk", call_id: "cr", selection_ref: "s69650", blames: "request", status: 400, input_refs: [root] }
    const asked = { shape: "request", id: "rq-bare", seq: 69670, role: "described", pointer: { type: "git_diff" }, input_refs: [root] }
    const diffs = await run([commit, chose(69650, "k1"), refused, asked])
    expect(diffs.map((c) => c.from ?? "none")).toEqual(["rq-bare"])
    // a from that is not a request's id (null, a number) is keyed by no request either
    for (const from of [null, 7]) {
      const sel = { ...chose(69650, "k1"), from }
      expect((await run([commit, sel, refused, asked])).map((c) => c.from ?? "none")).toEqual(["rq-bare"])
    }
  })

  test("[GUARD] a request already asking for git_diff is called as asked: one candidate, the request's", async () => {
    const asked = { shape: "request", id: "rq-diff", seq: 69650, role: "described", pointer: { type: "git_diff", cwd }, input_refs: [root] }
    const diffs = await run([commit, asked])
    expect(diffs.map((c) => c.from ?? "none")).toEqual(["rq-diff"])
  })
})
