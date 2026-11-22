// SPDX-License-Identifier: MIT
// The next step takes what the root last made (the activity lattice), as an offer: the calls that take the root's newest
// made row (a tool's answer or a produce) are those whose owner requires rows need its shape and whose where it meets; a
// call outside them stays callable, its candidate and selection marked out_of_scope; a frontier nothing takes says it
// was widened. The request is judged by the frontier it was made over. The scope is shown to the producer
// (request_acts) and kept on the selection row. Read over the owner seed's own requires rows too, whose rows are
// preconditions: every step of a change stays callable over them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const realFetch = globalThis.fetch
const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
type Cand = { id: string; kind: string; out_of_scope?: true }
type Frontier = { id?: string; shape?: string; calls: string[]; widened: boolean }
let applicable: (pool: any[], skipped?: any[], now?: number, note?: any, answers?: Record<string, string>) => Promise<Cand[]>
let actsFactRow: (pool: any[], root: string, write: (row: object) => Promise<any>, sel?: string, gated?: Record<string, string[]>, frontier?: Frontier) => Promise<string | undefined>
let selectionRow: (arm: string, options: any[], post: { at_seq: number; posts: any[] }, seed: number, i: number, timing: any) => Record<string, unknown>
beforeAll(async () => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
  })
  globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
  applicable = (await import("../src/applicable")).applicable as never
  actsFactRow = (await import("../src/acts")).actsFactRow as never
  selectionRow = (await import("../src/loop")).selectionRow as never
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]
})

const ANSWERS = { fs_edit: "fileEditResult", fs_read: "fileContent", fs_list: "dirListing", git_worktree: "gitWorktree", git_commit: "gitCommitResult" }
const owner = (id: string, seq: number, row: object) => ({ id, seq, writer: "owner", role: "owner", ...row })
const OWNER_ROWS = [
  owner("rq-commit", 1, { shape: "requires", for: "git_commit", needs: "fileEditResult" }),
  owner("rq-worktree", 2, { shape: "requires", for: "git_worktree", needs: "gap" }),
  owner("rq-land", 3, { shape: "requires", for: "git_land", needs: "land_verdict", where: { r: 1 } }),
  owner("rq-edit", 4, { shape: "requires", for: "fs_edit", needs: "fileContent", where: { path: { "x-pointer": "path" } } }),
  owner("s-request", 5, { shape: "shape_schema", target: "request", inputs: ["gap"] }),
  owner("s-verdict", 6, { shape: "shape_schema", target: "land_verdict", inputs: ["gitDiff"] }),
]
const gap = { shape: "gap", id: "g1", seq: 10, writer: "detector", role: "detector", gap_id: "g1", status: "open" }
const walkRow = (shape: string, id: string, seq: number, more: object = {}) => ({ shape, id, seq, writer: "walk-test", role: "walk", input_refs: ["g1"], ...more })
const edit = walkRow("fileEditResult", "e1", 11, { path: "src/a.ts" })
const verdict = (id: string, seq: number, r: number) => ({ shape: "land_verdict", id, seq, writer: "person", role: "described", r, input_refs: ["g1"] })
const request = (id: string, seq: number, type: string) =>
  ({ shape: "request", id, seq, writer: "described", role: "described", pointer: { type, cwd: "/c" }, input_refs: ["g1"] })
const run = async (rows: any[], shared: string[] = []) => {
  const note: any = { root: "g1", shared: new Set(shared) }
  const skipped: any[] = []
  const cands = await applicable([...OWNER_ROWS, gap, ...rows].sort((a, b) => a.seq - b.seq), skipped, 1_000, note, ANSWERS)
  const calls = cands.filter((c) => c.kind === "call")
  return { frontier: note.frontier as Frontier | undefined, calls: calls.map((c) => c.id).sort(), marked: calls.filter((c) => c.out_of_scope === true).map((c) => c.id).sort(), skipped }
}

describe("the calls that take the root's newest made row: an offer, never a refusal", () => {
  test("[MUST-FAIL] after an edit, git_commit (whose requires needs fileEditResult) takes it; git_worktree does not", async () => {
    const got = await run([edit])
    expect(got.frontier).toEqual({ id: "e1", shape: "fileEditResult", calls: ["git_commit"], widened: false })
  })

  test("[MUST-FAIL] a request naming git_worktree over the edit is still called, its candidate marked out_of_scope; git_commit's is not", async () => {
    const got = await run([edit, request("q1", 12, "git_worktree"), request("q2", 13, "git_commit")])
    expect(got.calls).toEqual(["call/git_commit", "call/git_worktree"])
    expect(got.marked).toEqual(["call/git_worktree"])
    expect(got.skipped).toEqual([])
  })

  test("[MUST-FAIL] a request is judged by the frontier it was made over, not by a row made after it", async () => {
    // a listing (fs_list's answer) after the request: nothing takes it, so the frontier now is widened, but the request
    // was made over the edit
    const got = await run([edit, request("q1", 12, "git_worktree"), walkRow("dirListing", "c1", 13)])
    expect(got.frontier?.widened).toBe(true)
    expect(got.marked).toEqual(["call/git_worktree"])
  })

  test("[MUST-FAIL] a request is never the frontier: one made after another keeps the edit's scope", async () => {
    const got = await run([edit, request("q1", 12, "git_worktree"), request("q2", 13, "git_worktree")])
    expect(got.frontier).toEqual({ id: "e1", shape: "fileEditResult", calls: ["git_commit"], widened: false })
  })

  test("[MUST-FAIL] a produced row is a frontier, whoever wrote it: after a person's land verdict at r 1, git_land takes it", async () => {
    const got = await run([edit, verdict("v1", 12, 1)])
    expect(got.frontier).toEqual({ id: "v1", shape: "land_verdict", calls: ["git_land"], widened: false })
  })

  test("[MUST-FAIL] a requires row's where is read against the row: a verdict at r 0 is taken by nothing (git_land needs r 1)", async () => {
    const got = await run([edit, verdict("v0", 12, 0)])
    expect(got.frontier).toEqual({ id: "v0", shape: "land_verdict", calls: [], widened: true })
  })

  test("[MUST-FAIL] a where field bound to the call's own pointer cannot be judged before the call, so it counts as met", async () => {
    const got = await run([walkRow("fileContent", "c1", 11, { path: "src/a.ts" })])
    expect(got.frontier).toEqual({ id: "c1", shape: "fileContent", calls: ["fs_edit"], widened: false })
  })

  test("[GUARD] a frontier nothing takes scopes nothing: any call is open and unmarked, as before", async () => {
    const got = await run([walkRow("dirListing", "c1", 11), request("q1", 12, "git_worktree")])
    expect(got.calls).toEqual(["call/git_worktree"])
    expect(got.marked).toEqual([])
  })

  test("[MUST-FAIL] that frontier is said to be widened", async () => {
    const got = await run([walkRow("dirListing", "c1", 11), request("q1", 12, "git_worktree")])
    expect(got.frontier).toEqual({ id: "c1", shape: "dirListing", calls: [], widened: true })
  })

  test("[MUST-FAIL] keyed: another root's newer row (shared, about no one root) is not this root's frontier", async () => {
    const other = { shape: "gitWorktree", id: "w9", seq: 12, writer: "walk-test", role: "walk", input_refs: ["g9"] }
    const got = await run([edit, other], ["w9"])
    expect(got.frontier).toEqual({ id: "e1", shape: "fileEditResult", calls: ["git_commit"], widened: false })
  })

  test("[MUST-FAIL] keyed: a newer row of a shape nothing makes (the walk's own bookkeeping) is not the frontier", async () => {
    const got = await run([edit, walkRow("hop", "h1", 12, { phase: "started", kind: "call", call_id: "c9", pointer_type: "fs_edit" })])
    expect(got.frontier?.id).toBe("e1")
  })
})

describe("the scope is shown to the producer and kept on the selection row", () => {
  const scoped: Frontier = { id: "e1", shape: "fileEditResult", calls: ["git_commit"], widened: false }
  const widened: Frontier = { id: "c1", shape: "dirListing", calls: [], widened: true }
  const factOf = async (f: Frontier, pool: any[] = []) => {
    const out: any[] = []
    await actsFactRow(pool, "g1", async (row) => { out.push(row); return { id: `f${out.length}` } }, "s1", {}, f)
    return out[0]
  }

  test("[MUST-FAIL] request_acts says the frontier and the calls that take it", async () => {
    const row = await factOf(scoped)
    expect([row.frontier, row.calls, row.frontier_widened]).toEqual([{ id: "e1", shape: "fileEditResult" }, ["git_commit"], undefined])
  })

  test("[MUST-FAIL] a widened frontier is said as widened, with no calls list", async () => {
    const row = await factOf(widened)
    expect([row.frontier, row.calls, row.frontier_widened]).toEqual([{ id: "c1", shape: "dirListing" }, undefined, true])
  })

  test("[MUST-FAIL] a new frontier is a new state of the request: the fact is written again", async () => {
    const last = { shape: "request_acts", id: "f0", seq: 20, writer: "walk-test", role: "walk", root: "g1", acts: [], not_called: [], repeats: [], gated: {},
      frontier: { id: "c1", shape: "dirListing" }, frontier_widened: true }
    expect(await factOf(widened, [last])).toBeUndefined()
    expect((await factOf(scoped, [last]))?.calls).toEqual(["git_commit"])
  })

  const opt = (f: Frontier, cand: object = { id: "produce/request/ch1", kind: "produce" }) => ({ cand, context: [], cell: "c", root: "g1", frontier: f })
  const post = { at_seq: 1, posts: [{ alpha: 1, beta: 1 }] }

  test("[MUST-FAIL] the selection row records the chosen root's frontier, its calls, and a widening", () => {
    const sel = selectionRow("treated", [opt(scoped)], post, 1, 0, {})
    expect([sel.frontier, sel.calls, sel.frontier_widened]).toEqual([{ id: "e1", shape: "fileEditResult" }, ["git_commit"], undefined])
    const w = selectionRow("treated", [opt(widened)], post, 1, 0, {})
    expect([w.frontier, w.calls, w.frontier_widened]).toEqual([{ id: "c1", shape: "dirListing" }, undefined, true])
  })

  test("[MUST-FAIL] the selection of a call outside its request's scope is marked out_of_scope; one inside is not", async () => {
    const cands = await applicable([...OWNER_ROWS, gap, edit, request("q1", 12, "git_worktree"), request("q2", 13, "git_commit")], [], 1_000,
      { root: "g1", shared: new Set() }, ANSWERS)
    const pick = (id: string) => selectionRow("treated", [opt(scoped, cands.find((c) => c.id === id)!)], post, 1, 0, {})
    expect([pick("call/git_worktree").out_of_scope, pick("call/git_commit").out_of_scope]).toEqual([true, undefined])
  })
})

// The owner seed's requires rows, as it writes them (super scripts/substrate/walk-owner-seed.ts): preconditions, not
// consume edges. A change on a gap, step by step, each step asked for by a request made over the step before.
describe("over the seed's own requires rows, every step of a change stays callable", () => {
  const SEED = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "seed-requires.json"), "utf8")) as any[]
  const SCHEMA = owner("s-lvg", 100, { shape: "shape_schema", target: "land_verdict", variant: "gap", inputs: ["gap", { shape: "gitDiff", latest_by: "shape" }] })
  const ANS = { git_worktree: "gitWorktree", fs_read: "fileContent", fs_edit: "fileEditResult", git_commit: "gitCommitResult", git_diff: "gitDiff", git_land: "gitLand" }
  const CWD = "/trees/demo-1"
  const P = `${CWD}/src/a.ts`
  const T = (n: number) => String(n).repeat(40)
  const root = { shape: "gap", id: "G", seq: 200, writer: "detector", role: "detector", gap_id: "G", status: "open", repo: "demo" }
  const made = (shape: string, seq: number, more: object) => ({ shape, id: `${shape}-${seq}`, seq, writer: "walk-test", role: "walk", call_id: `c${seq}`, input_refs: ["G"], ...more })
  const step = async (rows: any[], seq: number, pointer: Record<string, unknown>) => {
    const q = { shape: "request", id: `q${seq}`, seq, writer: "described", role: "described", pointer, input_refs: ["G"] }
    const note: any = { root: "G", shared: new Set(SEED.map((r) => r.id)) }
    const cands = await applicable([...SEED, SCHEMA, root, ...rows, q], [], 1_000, note, ANS)
    const c = cands.find((x) => x.kind === "call" && (x as any).from === q.id)
    const f = note.frontier as Frontier | undefined
    return { call: String(pointer.type), offered: c !== undefined, scope: f === undefined ? "none" : f.widened ? "widened" : f.calls.join(" ") }
  }
  const clone = made("gitWorktree", 202, { cwd: CWD, repo: "demo", tree: T(1), committed_tree: T(1) })
  const read1 = made("fileContent", 204, { cwd: CWD, path: P, content: "a" })
  const read2 = made("fileContent", 206, { cwd: CWD, path: P, content: "a" })
  const edited = made("fileEditResult", 208, { cwd: CWD, path: P, ok: true })
  const commit = made("gitCommitResult", 210, { cwd: CWD, sha: "S3", tree: T(3), committed_tree: T(3) })
  const diff = made("gitDiff", 212, { cwd: CWD, tree: T(3) })
  const judged = (r: number) => ({ shape: "land_verdict", id: `v${r}`, seq: 213, writer: "person", role: "described", r, tree: T(3), input_refs: ["G"] })

  const chain = async () => [
    await step([], 201, { type: "git_worktree", repo: "demo" }),
    await step([clone], 203, { type: "fs_read", path: P, cwd: CWD }),
    await step([clone, read1], 205, { type: "fs_read", path: P, cwd: CWD }),
    await step([clone, read1, read2], 207, { type: "fs_edit", path: P, cwd: CWD, old: "a", new: "b" }),
    await step([clone, read1, read2, edited], 209, { type: "git_commit", cwd: CWD, message: "fix" }),
    await step([clone, read1, read2, edited, commit], 211, { type: "git_diff", cwd: CWD }),
    await step([clone, read1, read2, edited, commit, diff, judged(1)], 214, { type: "git_land", cwd: CWD }),
    await step([clone, read1, read2, edited, commit, diff, judged(0)], 214, { type: "fs_edit", path: P, cwd: CWD, old: "b", new: "c" }),
  ]

  test("[GUARD] clone, read, read, edit, commit, diff, verdict, land; and a refused verdict, then an edit again: each is called", async () => {
    expect((await chain()).map((x) => [x.call, x.offered])).toEqual([["git_worktree", true], ["fs_read", true], ["fs_read", true], ["fs_edit", true],
      ["git_commit", true], ["git_diff", true], ["git_land", true], ["fs_edit", true]])
  })

  test("[MUST-FAIL] a where value not known yet meets nothing: a clone handed out with no committed tree is not taken by git_diff", async () => {
    const dirty = made("gitWorktree", 202, { cwd: CWD, repo: "demo", tree: T(1) })
    expect((await step([dirty], 203, { type: "fs_read", path: P, cwd: CWD })).scope).toBe("code_add_import code_insert_after_line code_replace_lines fs_edit fs_write")
  })

  test("[MUST-FAIL] each step's scope is what takes the row before it, read with each requires row's where", async () => {
    const WRITERS = "code_add_import code_insert_after_line code_replace_lines fs_edit fs_write git_diff"
    expect((await chain()).map((x) => x.scope)).toEqual(["widened", WRITERS, "fs_edit", "fs_edit", "widened", "git_diff", "git_land", "widened"])
  })
})
