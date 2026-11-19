// SPDX-License-Identifier: MIT
// Which rows find the clone, apart from which move it (x-latest `at`). A diff is called only on a tree some commit
// names: an edit newer than every commit leaves the clone's tree unknown, so the step named is a commit, not a diff.
// A clone handed out before its answers named a tree still finds its clone and takes its newest commit's tree. Read
// from real rows (82ac's pool: its clone was handed out with no tree).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

type Row = Record<string, any>
const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8").replaceAll('"writer-3"', '"walk-test"')) as { root: Row; rows: Row[]; owner?: Row[] }
const EDITS = ["fileEditResult", "fileWriteResult", "codeInsertResult", "codeReplaceResult", "codeAddImportResult"]
const CB = (at = true) => ({ "x-latest": { shapes: ["gitCommitResult", "gitWorktree", ...EDITS], moves: ["gitCommitResult", ...EDITS],
  ...(at ? { at: ["gitWorktree"] } : {}), same: "cwd", field: "tree", continues: "gap_id" } })
// the two owner rows the seed writes, alternatives in one group, newer than every row in the fixture; each counts the
// newest row per clone (latest_by cwd), so another clone's newer row never hides this one's
const committedRows = (at = true): Row[] => [
  { shape: "requires", id: "cb-k", seq: 90011, role: "owner", for: "git_diff", needs: "gitCommitResult", where: { tree: CB(at) }, latest_by: "cwd", group: "committed" },
  { shape: "requires", id: "cb-w", seq: 90012, role: "owner", for: "git_diff", needs: "gitWorktree", where: { tree: CB(at) }, latest_by: "cwd", group: "committed" },
]

describe("a diff waits for a commit of the clone's newest edit", () => {
  const served = new Set(["git_diff", "git_commit"])
  const realFetch = globalThis.fetch
  let applicable: (pool: Row[], skipped?: Row[], now?: number, note?: Row, answers?: Record<string, string>) => Promise<Array<{ id: string }>>
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
  const clone = f.rows.find((r) => r.shape === "gitWorktree") as Row // 68334: handed out with no tree
  const cwd = clone.cwd as string
  const rows = f.rows.filter((r) => r.shape !== "gitDiff" && r.shape !== "land_verdict")
  const ask = { shape: "request", id: "rq-diff", seq: 69300, role: "described", pointer: { type: "git_diff", cwd }, input_refs: [root] }
  const T = (n: number) => String(n).repeat(40)
  const tool = (shape: string, seq: number, fields: Row) => ({ shape, id: `${shape}-${seq}`, seq, role: "walk", call_id: `c${seq}`, input_refs: [root], ...fields })
  const commit = (seq: number, tree?: string, at = cwd) => tool("gitCommitResult", seq, { cwd: at, ...(tree ? { tree, sha: `s${seq}` } : {}) })
  const edit = (seq: number, shape = "fileEditResult", fields: Row = { cwd, ok: true }) => tool(shape, seq, { path: `${cwd}/src/x.ts`, ...fields })
  const run = async (extra: Row[], owner: Row[] = committedRows(), base: Row[] = rows) => {
    const skipped: Row[] = []
    const cands = await applicable([f.root, ...base, ...(f.owner ?? []), ask, ...owner, ...extra], skipped, Date.now(), { root },
      { git_diff: "gitDiff", git_commit: "gitCommitResult" })
    const why = skipped.find((s) => s.id === "rq-diff")
    return { diff: cands.some((c) => c.id === "call/git_diff"), why: why === undefined ? undefined : String(why.unserved) }
  }

  test("a clone handed out with no tree finds its clone through `at` and takes its newest commit's tree", async () => {
    const r = await run([commit(68200, T(1))])
    expect([r.diff, r.why]).toEqual([true, undefined])
  })

  test("[MUST-FAIL] a clone handed out with its tree and nothing edited is diffed as before", async () => {
    const fresh = { ...clone, id: "wt-fresh", seq: 69100, call_id: "cw-fresh", tree: T(2) }
    expect((await run([fresh])).diff).toBe(true)
  })

  test("an edit newer than every commit leaves the tree unknown: no diff, and the step named is a commit", async () => {
    const r = await run([commit(68200, T(1)), edit(68400)])
    expect(r.diff).toBe(false)
    expect(r.why).toContain("gitCommitResult comes from a git_commit call")
  })

  test("a commit newer than the edit is diffed again", async () => {
    expect((await run([commit(68200, T(1)), edit(68400), commit(68500, T(3))])).diff).toBe(true)
  })

  test("a newer commit of another clone citing the root neither relocates the clone nor hides this clone's commit", async () => {
    expect((await run([commit(68200, T(1)), commit(68500, T(9), "/another-clone")])).diff).toBe(true)
  })

  test("every edit shape that changed a file blocks the diff until a commit", async () => {
    for (const shape of EDITS) expect([shape, (await run([commit(68200, T(1)), edit(68400, shape)])).diff]).toEqual([shape, false])
  })

  test("an edit that changed nothing (already in the file, an import already present) names no clone and blocks nothing", async () => {
    const same = edit(68400, "fileEditResult", { ok: true, applied: false })
    const present = edit(68410, "codeAddImportResult", { action: "already_present" })
    expect((await run([commit(68200, T(1)), same, present])).diff).toBe(true)
  })

  test("[MUST-FAIL] an edit of another clone, or a model's row naming this one, does not block this clone's diff", async () => {
    const other = edit(68400, "fileEditResult", { cwd: "/another-clone", ok: true })
    const model = { ...edit(68410), role: "described" }
    expect((await run([commit(68200, T(1)), other, model])).diff).toBe(true)
  })

  test("a commit that wrote nothing (git_commit answered an error, so no commit row) leaves an edit blocking", async () => {
    const refused = tool("failure", 68500, { status: 200, body: "nothing to commit: the clone does not differ from its base" })
    expect((await run([commit(68200, T(1)), edit(68400), refused])).diff).toBe(false)
  })

  test("a newest commit row with no tree leaves the tree unknown: no diff", async () => {
    expect((await run([commit(68200, T(1)), commit(68500)])).diff).toBe(false)
  })

  test("a clone handed out with no tree and never committed has no tree to diff", async () => {
    expect((await run([])).diff).toBe(false)
  })

  test("[MUST-FAIL] with no `at`, the clone is found only through `moves`: a handout with its tree and nothing committed finds no clone", async () => {
    const fresh = { ...clone, id: "wt-fresh", seq: 69100, call_id: "cw-fresh", tree: T(2) }
    expect((await run([fresh], committedRows(false))).diff).toBe(false)
    expect((await run([fresh], committedRows(true))).diff).toBe(true)
  })

  test("an `at` that is not a list reads as no `at`: the clone is found through `moves`, as before", async () => {
    const wrong = committedRows(false).map((r) => ({ ...r, where: { tree: { "x-latest": { ...CB(false)["x-latest"], at: "gitWorktree" } } } }))
    const r = await run([commit(68200, T(1)), edit(68400), commit(68500, T(3))], wrong)
    expect(r.diff).toBe(true)
  })

  test("with no requires row for git_diff, a diff is offered as today, edits or not", async () => {
    expect((await run([commit(68200, T(1)), edit(68400)], [])).diff).toBe(true)
  })
})
