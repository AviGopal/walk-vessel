// SPDX-License-Identifier: MIT
// What a request has done, shown to its producers as a fact recomputed from its own rows.
import { describe, expect, test } from "bun:test"

Object.assign(process.env, {
  WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "test-node-key",
})
const { actsFactRow, actsOf } = await import("../src/acts")

const req = (tool: string, seq: number) => ({ shape: "requires", id: `rq-${tool}`, seq, role: "owner", for: tool, needs: "change_wanted", where: { wanted: true } })
const OWNER_ROWS = ["git_worktree", "fs_edit", "code_typecheck", "git_commit", "git_land"].map((t, i) => req(t, i + 1))
let seq = 100
const call = (root: string, tool: string, end: "ok" | "fail" | "notok", answer: Record<string, unknown> = {}) => {
  const sel = { shape: "selection", id: `s${++seq}`, seq, role: "walk", root }
  const id = `c${seq}`
  const rows: any[] = [sel, { shape: "hop", id: `hs${++seq}`, seq, role: "walk", phase: "started", selection_ref: sel.id, call_id: id, pointer_type: tool }]
  if (end === "fail") rows.push({ shape: "failure", id: `f${++seq}`, seq, role: "walk", selection_ref: sel.id, call_id: id, status: 422 })
  else {
    rows.push({ shape: "hop", id: `he${++seq}`, seq, role: "walk", phase: "ended", selection_ref: sel.id, call_id: id })
    rows.push({ shape: "answerShape", id: `a${++seq}`, seq, role: "walk", call_id: id, input_refs: [root], ...(end === "notok" ? { ok: false } : {}), ...answer })
  }
  return rows
}

describe("what a request has done", () => {
  test("[MUST-FAIL] what the row means (a template is a plan, never an act) is said once, in the registered description", async () => {
    const { WRITTEN } = await import("../src/written")
    expect(WRITTEN.request_acts).toContain("template (activity_template) is a plan")
    expect(WRITTEN.request_acts).toContain("reads and other calls are not listed") // scoped: not "nothing else happened"
  })

  test("[MUST-FAIL] a fact that cannot be written is said in the journal, and the produce runs without it", async () => {
    const said: string[] = []
    const real = console.error
    console.error = (m: string) => { said.push(String(m)) }
    const id = await actsFactRow([...OWNER_ROWS], "w9", async () => { throw new Error("records down") })
    console.error = real
    expect(id).toBeUndefined()
    expect(said.join(" ")).toContain("request_acts for w9 not written")
  })

  test("[MUST-FAIL] an edit and a passing typecheck with no commit: listed as done, and commit and land as never called", () => {
    seq = 100
    const pool = [...OWNER_ROWS, ...call("w1", "git_worktree", "ok", { repo: "hsv" }), ...call("w1", "fs_edit", "ok", { path: "src/limits.ts" }), ...call("w1", "code_typecheck", "ok")]
    const f = actsOf(pool, "w1")
    expect(f.acts.map((a) => [a.tool, a.ok, a.path ?? a.repo ?? null])).toEqual([["git_worktree", true, "hsv"], ["fs_edit", true, "src/limits.ts"], ["code_typecheck", true, null]])
    expect(f.not_called).toEqual(["git_commit", "git_land"])
  })

  test("[MUST-FAIL] a failed act is listed not ok, with its status; an answer saying ok: false is not ok", () => {
    seq = 100
    const f = actsOf([...OWNER_ROWS, ...call("w1", "fs_edit", "fail"), ...call("w1", "code_typecheck", "notok")], "w1")
    expect(f.acts.map((a) => [a.tool, a.ok, a.status ?? null])).toEqual([["fs_edit", false, 422], ["code_typecheck", false, null]])
  })

  test("[MUST-FAIL] another request's acts are never this request's (V8)", () => {
    seq = 100
    const f = actsOf([...OWNER_ROWS, ...call("w2", "git_land", "ok"), ...call("w2", "git_commit", "ok")], "w1")
    expect(f.acts).toEqual([])
    expect(f.not_called).toContain("git_land")
  })

  test("[MUST-FAIL] a plan ending in git_land is not a landing: with no git_land called here, the fact says so", () => {
    seq = 100
    const plan = { shape: "activity_template", id: "t-land", seq: 50, role: "described", calls: [{ shape: "git_commit", pointer: {} }, { shape: "git_land", pointer: {} }] }
    const f = actsOf([...OWNER_ROWS, plan, ...call("w1", "fs_edit", "ok")], "w1")
    expect(f.not_called).toEqual(["code_typecheck", "git_commit", "git_land", "git_worktree"])
    expect(Object.keys(f).sort()).toEqual(["acts", "not_called", "root"]) // facts only: what a row means is said once
  })

  test("[MUST-FAIL] which tools are acts is the owner's word, read as the walk reads it: a later retired row for the same gate retires it", () => {
    seq = 100
    const f = actsOf([...OWNER_ROWS, { ...req("git_land", 9), id: "rq-gone", retired: true }], "w1") // the earlier git_land row stays in the pool
    expect(f.not_called).not.toContain("git_land")
    const back = actsOf([...OWNER_ROWS, { ...req("git_land", 9), id: "rq-gone", retired: true }, { ...req("git_land", 10), id: "rq-back" }], "w1")
    expect(back.not_called).toContain("git_land") // a newer live row brings it back
  })

  test("[MUST-FAIL] a memo of the rows: the same rows give the same fact, written once; a new act writes a new one", async () => {
    seq = 100
    const written: any[] = []
    const write = async (row: any) => { const r = { ...row, id: `ra${written.length}`, seq: 900 + written.length, role: "walk" }; written.push(r); return r }
    const pool: any[] = [...OWNER_ROWS, ...call("w1", "fs_edit", "ok")]
    const id1 = await actsFactRow(pool, "w1", write)
    pool.push(written[0])
    const id2 = await actsFactRow(pool, "w1", write) // rebuilt from the same rows: the same fact, not written again
    expect([id1, id2, written.length]).toEqual(["ra0", "ra0", 1])
    expect({ acts: written[0].acts, not_called: written[0].not_called }).toEqual((({ acts, not_called }) => ({ acts, not_called }))(actsOf(pool, "w1")))
    pool.push(...call("w1", "git_commit", "ok", { sha: "abc" }))
    expect(await actsFactRow(pool, "w1", write)).toBe("ra1")
    expect(written[1].acts.at(-1)).toMatchObject({ tool: "git_commit", ok: true, sha: "abc" })
    expect(written[1].input_refs).toEqual(["w1"])
  })
})
