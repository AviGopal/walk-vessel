// SPDX-License-Identifier: MIT
// The next step takes what the root last made (the activity lattice): the calls a request may name are those whose owner
// requires rows need the shape of the root's newest made row (a tool's answer or a produce), a request naming another
// is not called and the skip says why, and a frontier no requires row names scopes nothing and says it was widened. The
// request is judged by the frontier it was made over. The scope is shown to the producer (request_acts) and kept on the
// selection row.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const realFetch = globalThis.fetch
const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
type Cand = { id: string; kind: string }
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

const ANSWERS = { fs_edit: "fileEditResult", fs_read: "fileContent", git_worktree: "gitWorktree", git_commit: "gitCommitResult" }
const owner = (id: string, seq: number, row: object) => ({ id, seq, writer: "owner", role: "owner", ...row })
const OWNER_ROWS = [
  owner("rq-commit", 1, { shape: "requires", for: "git_commit", needs: "fileEditResult" }),
  owner("rq-worktree", 2, { shape: "requires", for: "git_worktree", needs: "gap" }),
  owner("rq-land", 3, { shape: "requires", for: "git_land", needs: "land_verdict" }),
  owner("s-request", 4, { shape: "shape_schema", target: "request", inputs: ["gap"] }),
  owner("s-verdict", 5, { shape: "shape_schema", target: "land_verdict", inputs: ["gitDiff"] }),
]
const gap = { shape: "gap", id: "g1", seq: 10, writer: "detector", role: "detector", gap_id: "g1", status: "open" }
const walkRow = (shape: string, id: string, seq: number, more: object = {}) => ({ shape, id, seq, writer: "walk-test", role: "walk", input_refs: ["g1"], ...more })
const edit = walkRow("fileEditResult", "e1", 11, { path: "src/a.ts" })
const request = (id: string, seq: number, type: string) =>
  ({ shape: "request", id, seq, writer: "described", role: "described", pointer: { type, cwd: "/c" }, input_refs: ["g1"] })
const run = async (rows: any[], shared: string[] = []) => {
  const note: any = { root: "g1", shared: new Set(shared) }
  const skipped: any[] = []
  const cands = await applicable([...OWNER_ROWS, gap, ...rows].sort((a, b) => a.seq - b.seq), skipped, 1_000, note, ANSWERS)
  const calls = cands.filter((c) => c.kind === "call").map((c) => c.id).sort()
  const refused = skipped.flatMap((s) => [s.unserved].flat().map(String)).filter((u) => u.includes("not a call that takes"))
  return { frontier: note.frontier as Frontier | undefined, calls, refused }
}

describe("the calls a request may name are those that take the root's newest made row", () => {
  test("[MUST-FAIL] after an edit, git_commit (whose requires needs fileEditResult) is the only call allowed: git_worktree is not", async () => {
    const got = await run([edit])
    expect(got.frontier).toEqual({ id: "e1", shape: "fileEditResult", calls: ["git_commit"], widened: false })
  })

  test("[MUST-FAIL] a request naming git_worktree over the edit is not called and the skip says why; one naming git_commit is called", async () => {
    const got = await run([edit, request("q1", 12, "git_worktree"), request("q2", 13, "git_commit")])
    expect(got.calls).toEqual(["call/git_commit"])
    expect(got.refused.length).toBe(1)
    expect(got.refused[0]).toContain("git_worktree: not a call that takes the newest row this request was made over (fileEditResult e1)")
    expect(got.refused[0]).toContain("the calls that take it: git_commit")
  })

  test("[MUST-FAIL] a request is judged by the frontier it was made over, not by a row made after it", async () => {
    // fileContent (fs_read's answer) after the request: no requires names it, so the frontier now is widened, but the
    // request was made over the edit
    const got = await run([edit, request("q1", 12, "git_worktree"), walkRow("fileContent", "c1", 13)])
    expect(got.frontier?.widened).toBe(true)
    expect(got.calls).toEqual([])
    expect(got.refused.length).toBe(1)
  })

  test("[MUST-FAIL] a refused request does not widen the next one: a request is never the frontier", async () => {
    const got = await run([edit, request("q1", 12, "git_worktree"), request("q2", 13, "git_worktree")])
    expect(got.frontier).toEqual({ id: "e1", shape: "fileEditResult", calls: ["git_commit"], widened: false })
    expect(got.calls).toEqual([])
  })

  test("[MUST-FAIL] a produced row is a frontier too, whoever wrote it: after a person's land verdict, git_land is the call that takes it", async () => {
    const got = await run([edit, { shape: "land_verdict", id: "v1", seq: 12, writer: "person", role: "described", r: 1, input_refs: ["g1"] }])
    expect(got.frontier).toEqual({ id: "v1", shape: "land_verdict", calls: ["git_land"], widened: false })
  })

  test("[GUARD] a frontier no requires row names scopes nothing: any call is open, as before", async () => {
    const got = await run([walkRow("fileContent", "c1", 11), request("q1", 12, "git_worktree")])
    expect(got.calls).toEqual(["call/git_worktree"])
    expect(got.refused).toEqual([])
  })

  test("[MUST-FAIL] that frontier is said to be widened", async () => {
    const got = await run([walkRow("fileContent", "c1", 11), request("q1", 12, "git_worktree")])
    expect(got.frontier).toEqual({ id: "c1", shape: "fileContent", calls: [], widened: true })
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
  const widened: Frontier = { id: "c1", shape: "fileContent", calls: [], widened: true }
  const factOf = async (f: Frontier, pool: any[] = []) => {
    const out: any[] = []
    await actsFactRow(pool, "g1", async (row) => { out.push(row); return { id: `f${out.length}` } }, "s1", {}, f)
    return out[0]
  }

  test("[MUST-FAIL] request_acts says the frontier and the calls a request over it may name", async () => {
    const row = await factOf(scoped)
    expect([row.frontier, row.calls, row.frontier_widened]).toEqual([{ id: "e1", shape: "fileEditResult" }, ["git_commit"], undefined])
  })

  test("[MUST-FAIL] a widened frontier is said as widened, with no calls list", async () => {
    const row = await factOf(widened)
    expect([row.frontier, row.calls, row.frontier_widened]).toEqual([{ id: "c1", shape: "fileContent" }, undefined, true])
  })

  test("[MUST-FAIL] a new frontier is a new state of the request: the fact is written again", async () => {
    const last = { shape: "request_acts", id: "f0", seq: 20, writer: "walk-test", role: "walk", root: "g1", acts: [], not_called: [], repeats: [], gated: {},
      frontier: { id: "c1", shape: "fileContent" }, frontier_widened: true }
    expect(await factOf(widened, [last])).toBeUndefined()
    expect((await factOf(scoped, [last]))?.calls).toEqual(["git_commit"])
  })

  test("[MUST-FAIL] the selection row records the chosen root's frontier, its calls, and a widening", () => {
    const opt = (f: Frontier) => ({ cand: { id: "produce/request/ch1", kind: "produce" }, context: [], cell: "c", root: "g1", frontier: f })
    const post = { at_seq: 1, posts: [{ alpha: 1, beta: 1 }] }
    const sel = selectionRow("treated", [opt(scoped)], post, 1, 0, {})
    expect([sel.frontier, sel.calls, sel.frontier_widened]).toEqual([{ id: "e1", shape: "fileEditResult" }, ["git_commit"], undefined])
    const w = selectionRow("treated", [opt(widened)], post, 1, 0, {})
    expect([w.frontier, w.calls, w.frontier_widened]).toEqual([{ id: "c1", shape: "fileContent" }, undefined, true])
  })
})
