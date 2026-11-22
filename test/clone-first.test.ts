// SPDX-License-Identifier: MIT
// A tool that brought its clone onto a newer base before working in it answers that move as `clone`: the clone as it was
// before the tool's own work. The walk writes that row before the tool's own row (or its failure row), so the clone's
// rows read in the order things happened. Read through the walk's own writes: the rows execute() writes, stored as
// records stores them, are the pool the requirements are then asked over, with the owner's rows as the seed writes them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

type Row = Record<string, any>
const EDITS = ["fileEditResult", "fileWriteResult", "codeInsertResult", "codeReplaceResult", "codeAddImportResult"]
// the clone's newest committed tree and its newest tree, as the seed defines them
const COMMITTED_TREE = { "x-latest": { shapes: ["gitCommitResult", "gitWorktree", ...EDITS], moves: ["gitCommitResult", ...EDITS],
  at: ["gitWorktree"], same: "cwd", field: "committed_tree", continues: "gap_id" } }
const NEWEST_TREE = { "x-latest": { shapes: ["gitCommitResult", "gitWorktree", "gitDiff"], moves: ["gitCommitResult", "gitWorktree"], same: "cwd", field: "tree", continues: "gap_id" } }
const OWNER: Row[] = [
  { shape: "requires", id: "own-k", seq: 2, role: "owner", for: "git_diff", needs: "gitCommitResult", where: { committed_tree: COMMITTED_TREE }, latest_by: "cwd", group: "committed" },
  { shape: "requires", id: "own-w", seq: 3, role: "owner", for: "git_diff", needs: "gitWorktree", where: { committed_tree: COMMITTED_TREE }, latest_by: "cwd", group: "committed" },
  { shape: "requires", id: "own-v", seq: 4, role: "owner", for: "git_land", needs: "land_verdict", where: { r: 1, tree: NEWEST_TREE }, latest_by: "tree", group: "verdict" },
  // a verdict is a produce, as the seed's schema makes it, whoever writes the row
  { shape: "shape_schema", id: "own-s", seq: 5, role: "owner", target: "land_verdict", variant: "gap", inputs: ["gap", "gitDiff"] },
]
// the tools local-tools serves, with the clone's own shape; records serves verdicts
const LOCAL = new Set(["file_read", "fileContent", "file_edit", "fs_edit", "fileEditResult", "git_commit", "gitCommitResult", "git_diff", "gitDiff", "git_land", "gitWorktree"])

const CWD = "/trees/demo-1"
const ROOT: Row = { shape: "request", id: "root-1", seq: 1, role: "person", pointer: { type: "answer" } }
const T = (n: number) => String(n).repeat(40)
// the clone as handed out: clean, so its committed tree is its tree
const HANDOUT: Row = { shape: "gitWorktree", id: "wt-10", seq: 10, role: "walk", writer: "walk-test", call_id: "c10", cwd: CWD, repo: "demo", tree: T(1), committed_tree: T(1), input_refs: [ROOT.id] }
// what a refresh before the tool says: the clone moved onto a newer base, still clean (tree T0)
const moved = (tree: string, clean = true): Row => ({ shape: "gitWorktree", cwd: CWD, repo: "demo", branch: "walk/x", base: "B1", refreshed_from: "B0",
  super_base: "s", origin_url: "o", head: "H0", tree, ...(clean ? { committed_tree: tree } : {}) })

describe("an answer's clone is written before the tool's own row", () => {
  const realFetch = globalThis.fetch
  let written: Row[] = []
  let answer: { status: number; body: unknown } = { status: 200, body: {} }
  let execute: (c: any, sel: any) => Promise<void>
  let applicable: (pool: Row[], skipped?: Row[], now?: number, note?: Row, answers?: Record<string, string>) => Promise<Array<{ id: string }>>
  beforeAll(async () => {
    Object.assign(process.env, { WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k" })
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      if (pointer.type === "record_write") { written.push(pointer.row); return Response.json({ ...pointer.row, id: `w${written.length}`, seq: written.length }) }
      if (pointer.type === "vesselCapability") {
        const v = LOCAL.has(pointer.shape) ? [{ vesselId: "local-tools", endpoint: "http://lt.test" }]
          : pointer.shape === "land_verdict" ? [{ vesselId: "records", endpoint: "http://r.test" }] : []
        return Response.json({ content: { vessels: v } })
      }
      return Response.json(answer.body, { status: answer.status })
    }) as typeof fetch
    execute = (await import("../src/calls")).execute as any
    applicable = (await import("../src/applicable")).applicable as any
  })
  afterAll(() => { globalThis.fetch = realFetch })

  // one call made for the root, answered with `body`; its rows as records stores them (an id, a seq after every row
  // before it, the walk's role)
  const call = async (type: string, status: number, body: unknown, from: number): Promise<Row[]> => {
    written = []
    answer = { status, body }
    await execute({ t: "", calls: [], id: `call/${type}`, kind: "call", pointer: { type, cwd: CWD } }, { shape: "selection", id: `sel-${from}`, seq: from, root: ROOT.id })
    return written.map((r, i) => ({ ...r, id: `${r.shape}-${from + 1 + i}`, seq: from + 1 + i, role: "walk", writer: "walk-test" }))
  }
  const asks = (seq: number): Row[] => ["git_diff", "git_commit", "git_land"].map((t, i) =>
    ({ shape: "request", id: `rq-${t}`, seq: seq + i, role: "described", pointer: { type: t, cwd: CWD }, input_refs: [ROOT.id] }))
  const offered = async (rows: Row[]): Promise<Set<string>> => {
    const top = Math.max(...rows.map((r) => r.seq)) + 1
    const cands = await applicable([ROOT, ...OWNER, HANDOUT, ...rows, ...asks(top)], [], Date.now(), { root: ROOT.id },
      { git_diff: "gitDiff", git_commit: "gitCommitResult", git_land: "gitLand" })
    return new Set(cands.map((c) => c.id))
  }
  const answerWith = (body: unknown) => { answer = { status: 200, body } }
  const A3CC = "a3cccd154ab400c982a7957d986688a5bfc185efdb1f86f671b344a0be2dc8e3"
  // the requests asked over the case's own rows, for its root and on its clone
  const offeredOver = async (rows: Row[]): Promise<Set<string>> => {
    const cwd = rows.find((r) => r.shape === "fileEditResult")?.cwd
    const top = Math.max(...rows.map((r) => r.seq)) + 1
    const asked = ["git_diff", "git_commit"].map((t, i) =>
      ({ shape: "request", id: `rq-${t}`, seq: top + i, role: "described", pointer: { type: t, cwd }, input_refs: [A3CC] }))
    const cands = await applicable([...rows, ...asked], [], Date.now(), { root: A3CC }, { git_diff: "gitDiff", git_commit: "gitCommitResult" })
    return new Set(cands.map((c) => c.id))
  }
  const order = (rows: Row[]) => rows.map((r) => r.shape === "hop" ? `hop:${r.phase}` : r.shape)
  // a template's run of one call, answered with `body`; the rows it writes, in the order written
  const run = async (type: string, status: number, body: unknown): Promise<string[]> => {
    written = []
    answer = { status, body }
    await execute({ t: "", id: "run/t-1", kind: "run", pointer: {}, calls: [{ shape: type, pointer: { cwd: CWD } }] },
      { shape: "selection", id: "sel-run", seq: 20, root: ROOT.id })
    return order(written)
  }

  test("[MUST-FAIL] a template run's call that refreshed first: the hop ends, then the clone, then the edit", async () => {
    expect(await run("file_edit", 200, { clone: moved(T(2)), shape: "fileEditResult", cwd: CWD, path: `${CWD}/README.md`, ok: true }))
      .toEqual(["hop:started", "hop:ended", "gitWorktree", "fileEditResult"])
  })

  test("[MUST-FAIL] a template run's call that fails after its refresh: the clone, then the failure", async () => {
    expect(await run("git_diff", 200, { clone: moved(T(2)), error: "the typecheck failed" }))
      .toEqual(["hop:started", "gitWorktree", "failure"])
  })

  test("[MUST-FAIL] an edit made right after a refresh: the hop ends, then the clone, then the edit", async () => {
    const rows = await call("file_edit", 200, { clone: moved(T(2)), shape: "fileEditResult", cwd: CWD, path: `${CWD}/README.md`, ok: true }, 20)
    expect(order(rows)).toEqual(["hop:started", "hop:ended", "gitWorktree", "fileEditResult"])
  })

  test("[MUST-FAIL] a tool that fails after its refresh: the clone, then the failure", async () => {
    const rows = await call("git_diff", 200, { clone: moved(T(2)), error: "the typecheck failed" }, 20)
    expect(order(rows)).toEqual(["hop:started", "gitWorktree", "failure"])
  })

  test("[MUST-FAIL] a refreshed edit on a clean clone: the diff waits, and the commit is the step", async () => {
    const rows = await call("file_edit", 200, { clone: moved(T(2)), shape: "fileEditResult", cwd: CWD, path: `${CWD}/README.md`, ok: true }, 20)
    const ids = await offered(rows)
    expect([ids.has("call/git_diff"), ids.has("call/git_commit")]).toEqual([false, true])
  })

  test("[GUARD] a refresh with no edit after it (a read): the clean clone is diffed", async () => {
    const rows = await call("file_read", 200, { clone: moved(T(2)), shape: "fileContent", path: `${CWD}/README.md`, content: "x" }, 20)
    expect((await offered(rows)).has("call/git_diff")).toBe(true)
  })

  // The case that showed it: an edit right after a refresh on a clean clone, stored as the walk wrote it then (the edit,
  // then the clone naming the tree before the edit as committed), and a diff ran over the edit uncommitted.
  test("[GUARD] the stored rows of the case: the clone row last, so the diff is offered", async () => {
    const fx = (await Bun.file(new URL("./fixtures/clone-first-a3cc.json", import.meta.url)).json()) as Row[]
    expect((await offeredOver(fx)).has("call/git_diff")).toBe(true)
  })

  test("[MUST-FAIL] the same edit, written again by execute(): the diff waits for a commit", async () => {
    const fx = (await Bun.file(new URL("./fixtures/clone-first-a3cc.json", import.meta.url)).json()) as Row[]
    const edit = fx.find((r) => r.shape === "fileEditResult") as Row
    const before = fx.filter((r) => r.seq < edit.seq - 2)
    const { id: _i, seq: _s, role: _r, input_refs: _in, selection_ref: sel, call_id: _c, ...answer } = edit
    written = []
    answerWith(answer)
    await execute({ t: "", calls: [], id: "call/fs_edit", kind: "call", pointer: { type: "fs_edit", cwd: edit.cwd } },
      { shape: "selection", id: sel, seq: edit.seq - 3, root: A3CC })
    const rows = written.map((r, i) => ({ ...r, id: `again-${i}`, seq: edit.seq - 2 + i, role: "walk" }))
    expect((await offeredOver([...before, ...rows])).has("call/git_diff")).toBe(false)
  })

  test("[MUST-FAIL] a refreshed commit: the clone's newest tree is the commit's, so a verdict on it lands and one on the tree before does not", async () => {
    // the clone held the edit when it was refreshed (tree T2, not clean); the commit made T3
    const rows = await call("git_commit", 200, { clone: moved(T(2), false), shape: "gitCommitResult", cwd: CWD, sha: "S3", tree: T(3), committed_tree: T(3) }, 20)
    const verdict = (tree: string): Row => ({ shape: "land_verdict", id: `v-${tree.slice(0, 1)}`, seq: 90, role: "described", r: 1, tree, input_refs: [ROOT.id] })
    const top = Math.max(...rows.map((r) => r.seq))
    const on = async (tree: string) => (await offered([...rows, { ...verdict(tree), seq: top + 1 }])).has("call/git_land")
    expect([await on(T(3)), await on(T(2))]).toEqual([true, false])
  })
})
