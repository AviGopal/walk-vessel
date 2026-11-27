// SPDX-License-Identifier: MIT
// A call the root's newest made row meets in part is asked of a producer: when the row binds what the call's declaration
// binds (shape_consumes, as discovery answers it: fixtures/shape-consumes-live.json) but the call requires fields the
// row does not fill, a request is asked for scoped to that call, its bound fields set from the row. A scoped request
// that declines declines that call over that row only, never the root's other calls. Read from a real root's rows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

type Row = Record<string, any>
type Cand = { id: string; kind: string; pointer: Record<string, any>; from?: string }
const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8").replaceAll('"writer-3"', '"walk-test"')) as { root: Row; rows: Row[] }
const LIVE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "shape-consumes-live.json"), "utf8"))
// the owner's rows: a request made from the gap through one channel; nothing names what reaches a gap, so the root has
// no route and every declared call is offered
const owner = (): Row[] => [
  { shape: "channel", id: "ch1", seq: 89990, role: "owner", calls: [{ pointer: { type: "llm_completion", model: "m" }, input_field: "prompt", output_field: "content" }] },
  { shape: "shape_schema", id: "o-rq", seq: 89991, role: "owner", target: "request", variant: "gap", inputs: ["gap"], context: ["hop", "fileEditResult", "fileContent", "codeReadResult", "gitCommitResult"] },
]
const ANSWERS = { git_diff: "gitDiff", git_commit: "gitCommitResult", git_clone: "gitWorktree", fs_edit: "fileEditResult", fs_read: "fileContent", code_read_lines: "codeReadResult" }

describe("a request asked for one call the root's newest row meets in part", () => {
  const served = new Set(["git_land", "git_diff", "git_commit", "fs_edit", "code_replace_lines", "land_verdict", "request"])
  const realFetch = globalThis.fetch
  let applicable: (pool: Row[], skipped?: Row[], now?: number, note?: Row, answers?: Record<string, string>) => Promise<Cand[]>
  let calls: { shapeAnswers: () => Promise<unknown>; forgetDeclaredInputs: () => void }
  let declares: Record<string, unknown> | undefined
  beforeAll(async () => {
    Object.assign(process.env, { WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k" })
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, unknown> }
      if (pointer.type === "shapeDescriptions") return Response.json({ content: { ...LIVE.content, shape_inputs: declares ?? LIVE.content.shape_inputs } })
      return Response.json({ content: { vessels: served.has(String(pointer.shape)) ? [{ vesselId: "v", endpoint: "http://v.test" }] : [] } })
    }) as typeof fetch
    applicable = (await import("../src/applicable")).applicable as any
    calls = (await import("../src/calls")) as any
  })
  beforeEach(async () => { await calls.shapeAnswers() })
  afterEach(() => { calls.forgetDeclaredInputs(); declares = undefined })
  afterAll(() => { globalThis.fetch = realFetch })

  const f = fx("latest-82ac.json")
  const root = f.root.id as string
  const cwd = (f.rows.find((r) => r.shape === "gitWorktree") as Row).cwd as string
  const path = `${cwd}/src/a.ts`
  const T = (n: number) => String(n).repeat(40)
  const edit = { shape: "fileEditResult", id: "e1", seq: 69500, role: "walk", call_id: "ce", cwd, path, input_refs: [root] }
  const read = { shape: "fileContent", id: "fc1", seq: 69510, role: "walk", call_id: "cf", cwd, path, input_refs: [root] }
  const lines = { shape: "codeReadResult", id: "cr1", seq: 69520, role: "walk", call_id: "cl", cwd, path, input_refs: [root] }
  const commit = { shape: "gitCommitResult", id: "k1", seq: 69600, role: "walk", call_id: "ck", cwd, tree: T(2), committed_tree: T(2), input_refs: [root] }
  const all = async (extra: Row[]) => applicable([f.root, ...f.rows, ...owner(), ...extra], [], Date.now(), { root }, ANSWERS)
  const scoped = (cs: Cand[]) => cs.filter((c) => c.pointer.scope !== undefined)
  // the ask chosen over a row, and the request it made: a scoped decline
  const askedOver = (seq: number, frontier: Row, call: string) => ({ shape: "selection", id: `s${seq}`, seq, role: "walk", a: `produce/request/gap/ch1/scope:${call}`, frontier: { id: frontier.id, shape: frontier.shape }, root })
  const declined = (seq: number, call: string, bound: Row) => ({ shape: "request", id: `rq${seq}`, seq, role: "described", root, selection_ref: `s${seq - 1}`, none: "not one to make", scope: { call, bound } })

  test("[MUST-FAIL] from an edit, with no request row: a request scoped to git_commit, cwd set from the edit, is asked for", async () => {
    const asks = scoped(await all([edit]))
    expect(asks.map((c) => [c.id, c.kind, c.pointer])).toEqual([["produce/request/gap/ch1/scope:git_commit", "produce",
      { type: "request", shape: "request", via_ref: "ch1", variant: "gap", scope: { call: "git_commit", bound: { cwd } } }]])
  })

  test("[MUST-FAIL] from a file read, a request scoped to fs_edit; from a line read, one scoped to code_replace_lines: path set from the row", async () => {
    expect(scoped(await all([read])).map((c) => c.pointer.scope)).toEqual([{ call: "fs_edit", bound: { path } }])
    expect(scoped(await all([lines])).map((c) => c.pointer.scope)).toEqual([{ call: "code_replace_lines", bound: { path } }])
  })

  test("[GUARD] a call the row binds in full is offered as the call itself: git_diff from a commit, and no request asked for it", async () => {
    const cs = await all([commit])
    expect(cs.filter((c) => c.id === "call/git_diff").map((c) => c.pointer)).toEqual([{ type: "git_diff", cwd }])
    expect(scoped(cs)).toEqual([])
  })

  test("[GUARD] the request's own produce carries no scope key", async () => {
    const own = (await all([edit])).filter((c) => c.kind === "produce" && c.pointer.type === "request" && !c.id.includes("scope:"))
    expect(own.length).toBeGreaterThan(0)
    for (const c of own) expect("scope" in c.pointer).toBe(false)
  })

  test("[MUST-FAIL] a scoped ask made over the row is not asked again over it, whatever came of it", async () => {
    expect(scoped(await all([edit, askedOver(69550, edit, "git_commit")]))).toEqual([])
    expect(scoped(await all([edit, askedOver(69550, edit, "git_commit"), declined(69551, "git_commit", { cwd })]))).toEqual([])
    // over another row it is a new ask: an ask over an older edit does not settle this one
    const older = { ...edit, id: "e0", seq: 69400 }
    expect(scoped(await all([older, askedOver(69450, older, "git_commit"), edit])).map((c) => c.pointer.scope.call)).toEqual(["git_commit"])
  })

  test("[MUST-FAIL] a declined scoped git_commit declines that call only: git_diff from a later commit row is still offered", async () => {
    const cs = await all([edit, askedOver(69550, edit, "git_commit"), declined(69551, "git_commit", { cwd }), commit])
    expect(cs.filter((c) => c.id === "call/git_diff").map((c) => c.pointer)).toEqual([{ type: "git_diff", cwd }])
  })

  test("[GUARD] a request that declines with no scope is still the root's decline: nothing is chained", async () => {
    const none = { shape: "request", id: "rq-n", seq: 69551, role: "described", root, none: "nothing more to do" }
    const cs = await all([edit, none, commit])
    expect(cs.filter((c) => c.id === "call/git_diff")).toEqual([])
    expect(scoped(await all([none, edit]))).toEqual([])
  })

  test("[GUARD] a bound field the call does not declare it takes asks for nothing", async () => {
    declares = { ...LIVE.content.shape_inputs, git_commit: { type: "object", required: ["message"], properties: { message: { type: "string" } } } }
    await calls.shapeAnswers()
    expect(scoped(await all([edit]))).toEqual([])
  })

  // the owner's preconditions on a commit, as the seed writes them: an edit in the clone, or a clone carrying an
  // uncommitted change
  const uncommitted = (): Row[] => [
    { shape: "requires", id: "o-ce", seq: 90010, role: "owner", for: "git_commit", needs: "fileEditResult", where: { cwd: { "x-pointer": "cwd" } }, latest_by: "cwd", group: "uncommitted" },
    { shape: "requires", id: "o-cw", seq: 90011, role: "owner", for: "git_commit", needs: "gitWorktree", where: { carried: "uncommitted", cwd: { "x-pointer": "cwd" } }, latest_by: "cwd", group: "uncommitted" },
  ]

  test("[MUST-FAIL] the owner's preconditions on the call hold for its ask: a clean clone is not asked for a commit; an edit in it is", async () => {
    // the clone (the fixture's gitWorktree) is the newest made row, and nothing in it is uncommitted
    expect(scoped(await all(uncommitted())).filter((c) => c.pointer.scope.call === "git_commit")).toEqual([])
    expect(scoped(await all([...uncommitted(), edit])).map((c) => c.pointer.scope)).toEqual([{ call: "git_commit", bound: { cwd } }])
  })

  test("[GUARD] a clone carrying an uncommitted change is asked for a commit", async () => {
    const carrying = { shape: "gitWorktree", id: "w2", seq: 69700, role: "walk", call_id: "cw", cwd, carried: "uncommitted", input_refs: [root] }
    expect(scoped(await all([...uncommitted(), carrying])).map((c) => c.pointer.scope)).toEqual([{ call: "git_commit", bound: { cwd } }])
  })

  test("[GUARD] a precondition on a field the ask is for the producer to write does not hold the ask", async () => {
    // a precondition on the read the edit is asked over, so it is one the ask is judged by, bound to the text the
    // producer writes
    const onText = { shape: "requires", id: "o-et", seq: 90012, role: "owner", for: "fs_edit", needs: "fileContent", where: { content: { "x-pointer": "old_string" } }, latest_by: "path", group: "read" }
    expect(scoped(await all([onText, read])).map((c) => c.pointer.scope)).toEqual([{ call: "fs_edit", bound: { path } }])
  })

  // the owner's preconditions on every change tool, as the seed writes them: one group, met by a wanted change or an open
  // gap; neither is judged on a field of the row the ask is made over. The root is a gap: a later row of its gap_id
  // closes it.
  const wanted = (call: string): Row[] => [
    { shape: "requires", id: `q-cw-${call}`, seq: 89996, role: "owner", for: call, needs: "change_wanted", where: { wanted: true } },
    { shape: "requires", id: `q-gp-${call}`, seq: 89997, role: "owner", for: call, needs: "gap", where: { status: "open" }, latest_by: "gap_id" },
  ]
  const want = (w: boolean) => ({ shape: "change_wanted", id: `cw-${w}`, seq: 69505, role: "described", wanted: w, repo: "x", input_refs: [root] })
  const gap = (status: string) => ({ ...f.root, id: `gp-${status}`, seq: 69506, status, input_refs: [root] })

  test("[MUST-FAIL] a file read on a root that wants no change asks for no edit: no change wanted, or wanted false", async () => {
    expect(scoped(await all([...wanted("fs_edit"), gap("closed"), read])).map((c) => c.pointer.scope.call)).toEqual([])
    expect(scoped(await all([...wanted("fs_edit"), gap("closed"), want(false), read])).map((c) => c.pointer.scope.call)).toEqual([])
    expect(scoped(await all([...wanted("code_replace_lines"), gap("closed"), lines])).map((c) => c.pointer.scope.call)).toEqual([])
  })

  test("[GUARD] a file read on a root that wants a change, or holds an open gap, is asked for the edit", async () => {
    expect(scoped(await all([...wanted("fs_edit"), gap("closed"), want(true), read])).map((c) => c.pointer.scope.call)).toEqual(["fs_edit"])
    expect(scoped(await all([...wanted("fs_edit"), gap("open"), read])).map((c) => c.pointer.scope.call)).toEqual(["fs_edit"])
  })

  test("[GUARD] an edit on a root whose gap is closed asks for no commit; while it is open, it does", async () => {
    expect(scoped(await all([...wanted("git_commit"), gap("closed"), edit]))).toEqual([])
    expect(scoped(await all([...wanted("git_commit"), gap("open"), edit])).map((c) => c.pointer.scope)).toEqual([{ call: "git_commit", bound: { cwd } }])
  })

  test("[GUARD] a bound value that is not a string, number or boolean asks for nothing", async () => {
    expect(scoped(await all([{ ...edit, cwd: { at: cwd } }]))).toEqual([])
  })
})
