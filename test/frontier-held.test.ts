// SPDX-License-Identifier: MIT
// The calls that take the root's newest row are those declared to consume its shape (shape_consumes) whose owner's
// requires rows naming that shape hold on the row: the consumes say which call, the requires say when. A refused
// verdict, or one on a tree older than the clone's newest, is no landing's; a clean clone is no commit's.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

type Row = Record<string, any>
const realFetch = globalThis.fetch
const LIVE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "shape-consumes-live.json"), "utf8"))
const SEED = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "seed-requires.json"), "utf8")) as Row[]
// git_land declared to take the verdict on the diff, binding nothing from it, as local-tools declares it
const LANDS = { ...LIVE.content.shape_consumes, git_land: [...LIVE.content.shape_consumes.git_land, { shape: "land_verdict", binds: {} }] }
let consumes: unknown = LIVE.content.shape_consumes
let applicable: (pool: Row[], skipped?: Row[], now?: number, note?: Row, answers?: Record<string, string>) => Promise<Array<Row>>
let calls: { shapeAnswers: () => Promise<unknown>; forgetDeclaredInputs: () => void }

beforeAll(async () => {
  Object.assign(process.env, { WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k" })
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const { pointer } = JSON.parse(String(init?.body ?? "{}")) as { pointer?: { type?: string } }
    return Response.json(pointer?.type === "shapeDescriptions" ? { content: { ...LIVE.content, shape_consumes: consumes } } : { content: { vessels: [{ vesselId: "v" }] } })
  }) as typeof fetch
  applicable = (await import("../src/applicable")).applicable as never
  calls = (await import("../src/calls")) as never
})
afterEach(() => { calls.forgetDeclaredInputs(); consumes = LIVE.content.shape_consumes })
afterAll(() => { globalThis.fetch = realFetch })

const ANSWERS = { git_worktree: "gitWorktree", fs_read: "fileContent", code_read_lines: "codeReadResult", fs_edit: "fileEditResult", git_commit: "gitCommitResult", git_diff: "gitDiff", git_land: "gitLand" }
const owner = (id: string, seq: number, row: object) => ({ id, seq, writer: "owner", role: "owner", ...row })
// the owner seed's commit group: an edit in the clone, or a clone carrying an uncommitted change
const cwd = { "x-pointer": "cwd" }
const COMMIT = [
  owner("rq-ce", 90, { shape: "requires", for: "git_commit", needs: "fileEditResult", where: { cwd }, latest_by: "cwd", group: "uncommitted" }),
  owner("rq-cw", 91, { shape: "requires", for: "git_commit", needs: "gitWorktree", where: { carried: "uncommitted", cwd }, latest_by: "cwd", group: "uncommitted" }),
]
const VERDICT = owner("s-lv", 92, { shape: "shape_schema", target: "land_verdict", variant: "gap", inputs: ["gap", { shape: "gitDiff", latest_by: "shape" }] })
const CWD = "/trees/demo-1"
const T = (n: number) => String(n).repeat(40)
const root = { shape: "gap", id: "G", seq: 200, writer: "detector", role: "detector", gap_id: "G", status: "open", repo: "demo" }
const made = (shape: string, seq: number, more: object) => ({ shape, id: `${shape}-${seq}`, seq, writer: "walk-test", role: "walk", call_id: `c${seq}`, input_refs: ["G"], ...more })
const clone = made("gitWorktree", 202, { cwd: CWD, repo: "demo", tree: T(1), committed_tree: T(1), carried: "commits" })
const commit = made("gitCommitResult", 210, { cwd: CWD, sha: "S3", tree: T(3), committed_tree: T(3) })
const diff = made("gitDiff", 212, { cwd: CWD, tree: T(3) })
const verdict = (r: number, tree: string) => ({ shape: "land_verdict", id: `v${r}-${tree.slice(0, 1)}`, seq: 213, writer: "person", role: "described", r, tree, input_refs: ["G"] })
const at = async (rows: Row[], declared: unknown = LANDS) => {
  consumes = declared
  await calls.shapeAnswers()
  const note: Row = { root: "G", shared: new Set([...SEED, ...COMMIT, VERDICT, ...rows.filter((r) => r.role === "owner")].map((r) => r.id)) }
  const cs = await applicable([...SEED, ...COMMIT, VERDICT, root, ...rows], [], 1_000, note, ANSWERS)
  return { frontier: note.frontier, cs }
}

describe("a declared call takes the frontier only where its preconditions on the frontier's shape hold", () => {
  test("[MUST-FAIL] a refused verdict (r 0) is taken by no call, though git_land is declared to take a verdict", async () => {
    expect((await at([clone, commit, diff, verdict(0, T(3))])).frontier).toEqual({ id: "v0-3", shape: "land_verdict", calls: [], widened: true })
  })

  test("[GUARD] an approving verdict (r 1) on the clone's newest tree is taken by git_land; nothing is offered from it directly, and no request is asked scoped to it", async () => {
    const { frontier, cs } = await at([clone, commit, diff, verdict(1, T(3))])
    expect(frontier).toEqual({ id: "v1-3", shape: "land_verdict", calls: ["git_land"], widened: false })
    expect(cs.filter((c) => c.kind === "call" && c.pointer?.type === "git_land")).toEqual([])
    expect(cs.filter((c) => c.pointer?.scope !== undefined)).toEqual([])
  })

  test("[GUARD] an approving verdict on a tree older than the clone's newest is taken by no call", async () => {
    expect((await at([clone, commit, diff, verdict(1, T(1))])).frontier).toEqual({ id: "v1-1", shape: "land_verdict", calls: [], widened: true })
  })

  test("[GUARD] a precondition on the verdict bound to a field the verdict does not fill is judged when the call is made: git_land still takes it", async () => {
    const byClone = owner("rq-lvc", 93, { shape: "requires", for: "git_land", needs: "land_verdict", where: { cwd }, latest_by: "tree", group: "verdict-clone" })
    const { frontier } = await at([byClone, clone, commit, diff, verdict(1, T(3))])
    expect(frontier.calls).toEqual(["git_land"])
  })

  test("[GUARD] a diff before any verdict is taken by git_land: its precondition on a verdict is on another shape, judged when it is called", async () => {
    expect((await at([clone, commit, diff])).frontier).toEqual({ id: "gitDiff-212", shape: "gitDiff", calls: ["git_land"], widened: false })
  })

  test("[GUARD] without git_land's declaration of the verdict, an approving verdict is taken by no call", async () => {
    expect((await at([clone, commit, diff, verdict(1, T(3))], LIVE.content.shape_consumes)).frontier).toEqual({ id: "v1-3", shape: "land_verdict", calls: [], widened: true })
  })

  test("[GUARD] a clean clone is taken by no call (git_commit alone is declared to take a clone); a clone carrying an uncommitted change by git_commit; a read by fs_edit", async () => {
    expect((await at([clone])).frontier.calls).toEqual([])
    expect((await at([{ ...clone, carried: "uncommitted" }])).frontier.calls).toEqual(["git_commit"])
    expect((await at([clone, made("fileContent", 204, { cwd: CWD, path: `${CWD}/src/a.ts`, content: "a" })])).frontier.calls).toEqual(["fs_edit"])
  })
})
