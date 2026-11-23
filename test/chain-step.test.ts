// SPDX-License-Identifier: MIT
// The step a gated call's chain names is offered (USER ruling 11-23, the walk offers the step a refusal's chain names).
// A landing gated on a verdict of the clone's newest tree is told "gitDiff comes from a git_diff call"; when that call
// takes the root's newest made row (a commit), it is offered with its pointer bound from that row by the owner's
// requires row (binds), once per frontier row, with no request asking for it. Read from a real root's rows (cut to
// what each leg needs) and a commit after them: commit, then the diff the landing needs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

type Row = Record<string, any>
type Cand = { id: string; pointer: Record<string, unknown>; from?: string }
const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8").replaceAll('"writer-3"', '"walk-test"')) as { root: Row; rows: Row[]; owner?: Row[] }
const XL = { "x-latest": { shapes: ["gitCommitResult", "gitWorktree", "gitDiff"], moves: ["gitCommitResult", "gitWorktree"], same: "cwd", field: "tree" } }
const CT = { "x-latest": { shapes: ["gitCommitResult", "gitWorktree", "codeReplaceResult"], moves: ["gitCommitResult", "codeReplaceResult"], at: ["gitWorktree"], same: "cwd", field: "committed_tree" } }
// the owner's rows as the seed writes them: the landing's verdict, the verdict's diff, and git_diff's two preconditions,
// the commit's naming which field of the commit row the call's pointer takes
const owner = (binds: Row | null = { cwd: "cwd" }): Row[] => [
  { shape: "requires", id: "o-land", seq: 90001, role: "owner", for: "git_land", needs: "land_verdict", where: { r: 1, tree: XL }, latest_by: "tree", group: "verdict" },
  { shape: "shape_schema", id: "o-lv", seq: 90002, role: "owner", target: "land_verdict", variant: "", inputs: ["world_changed", { shape: "gitDiff", latest_by: "shape", where: { tree: XL, role: "walk" } }] },
  { shape: "requires", id: "o-dc", seq: 90003, role: "owner", for: "git_diff", needs: "gitCommitResult", where: { committed_tree: CT }, latest_by: "cwd", group: "committed", ...(binds ? { binds } : {}) },
  { shape: "requires", id: "o-dw", seq: 90004, role: "owner", for: "git_diff", needs: "gitWorktree", where: { committed_tree: CT }, latest_by: "cwd", group: "committed" },
]
const ANSWERS = { git_diff: "gitDiff", git_commit: "gitCommitResult", git_clone: "gitWorktree", code_replace_lines: "codeReplaceResult" }

describe("the step a gated call's chain names", () => {
  const served = new Set(["git_land", "git_diff", "git_commit", "land_verdict"])
  const realFetch = globalThis.fetch
  let applicable: (pool: Row[], skipped?: Row[], now?: number, note?: Row, answers?: Record<string, string>) => Promise<Cand[]>
  beforeAll(async () => {
    Object.assign(process.env, { WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k" })
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, unknown> }
      return Response.json({ content: { vessels: served.has(String(pointer.shape)) ? [{ vesselId: "v", endpoint: "http://v.test" }] : [] } })
    }) as typeof fetch
    applicable = (await import("../src/applicable")).applicable as any
  })
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

  test("[GUARD] a clean clone with nothing committed since: no binds on the clone's row, so nothing is offered", async () => {
    const fresh = { shape: "gitWorktree", id: "w2", seq: 69600, role: "walk", call_id: "cw", cwd, tree: T(5), committed_tree: T(5), input_refs: [root] }
    expect(await run([fresh])).toEqual([])
  })

  test("[GUARD] an edit after the commit: the committed tree is not known, so git_diff is gated and not offered", async () => {
    const edit = { shape: "codeReplaceResult", id: "e1", seq: 69700, role: "walk", call_id: "ce", cwd, input_refs: [root] }
    expect(await run([commit, edit])).toEqual([])
  })

  test("[GUARD] which row leads on to which call is the owner's: with no binds on git_diff's commit row, nothing is offered", async () => {
    expect(await run([commit], owner(null))).toEqual([])
  })

  test("[GUARD] only a row the requires row takes leads on: a newer commit on a clone the root was not handed offers nothing", async () => {
    const other = { shape: "gitCommitResult", id: "k3", seq: 69700, role: "walk", call_id: "ck3", cwd: "/workspace/git/walk-trees/another", tree: T(9), committed_tree: T(9), input_refs: [root] }
    expect(await run([commit, other])).toEqual([])
  })

  test("[GUARD] a pointer field the row does not carry: binds naming a field the commit lacks offers nothing", async () => {
    expect(await run([commit], owner({ cwd: "cwd", repo: "repo" }))).toEqual([])
  })

  test("[GUARD] only a gated call's chain names it: with a verdict of the commit's tree here, the landing is not gated and no diff is offered", async () => {
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

  test("[GUARD] not while git_diff waits on a person, and not over a decline", async () => {
    const hop = { shape: "hop", id: "h1", seq: 69610, role: "walk", phase: "started", kind: "call", call_id: "cx", pointer_type: "git_diff", selection_ref: "sx" }
    const waits = { shape: "failure", id: "fx", seq: 69620, role: "walk", call_id: "cx", waits_for: "person", input_refs: [root] }
    expect(await run([commit, hop, waits])).toEqual([])
    const decline = { shape: "request", id: "rq-no", seq: 69650, role: "described", input_refs: [root] }
    expect(await run([commit, decline])).toEqual([])
  })

  test("[MUST-FAIL] a refusal of the offered call has no request pointer to key: it settles no request asking for git_diff", async () => {
    const refused = { shape: "failure", id: "fr", seq: 69660, role: "walk", call_id: "cr", selection_ref: "s69650", blames: "request", status: 400, input_refs: [root] }
    const asked = { shape: "request", id: "rq-bare", seq: 69670, role: "described", pointer: { type: "git_diff" }, input_refs: [root] }
    const diffs = await run([commit, chose(69650, "k1"), refused, asked])
    expect(diffs.map((c) => c.from ?? "none")).toEqual(["rq-bare"])
  })

  test("[GUARD] a request already asking for git_diff is called as asked: one candidate, the request's", async () => {
    const asked = { shape: "request", id: "rq-diff", seq: 69650, role: "described", pointer: { type: "git_diff", cwd }, input_refs: [root] }
    const diffs = await run([commit, asked])
    expect(diffs.map((c) => c.from ?? "none")).toEqual(["rq-diff"])
  })
})
