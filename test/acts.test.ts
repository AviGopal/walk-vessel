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

// Which walk rows records returns into a request's pool (store.ts rootRows): its root, the walk's selections citing it,
// their hops and failures, and any other walk row whose selection_ref is one of those selections.
const episodeOf = (all: any[], root: string): any[] => {
  const sels = new Set(all.filter((r) => r.shape === "selection" && r.role === "walk" && (r.root === root || [r.pool_refs].flat().includes(root))).map((r) => r.id))
  return all.filter((r) => r.id === root || r.role === "owner" || sels.has(r.id) || sels.has(String(r.selection_ref)))
}

describe("what a request has done", () => {
  test("[MUST-FAIL] through the store's real episode: a fact written on one tick is in the next tick's pool and is not written again", async () => {
    seq = 100
    const store: any[] = [{ shape: "world_changed", id: "w1", seq: 1, role: "person" }, ...OWNER_ROWS, ...call("w1", "fs_edit", "ok", { path: "a.ts" })]
    const written: any[] = []
    const write = async (row: any) => { const r = { ...row, id: `ra${written.length}`, seq: 900 + written.length, role: "walk" }; written.push(r); store.push(r); return r }
    const sel1 = { shape: "selection", id: "s-t1", seq: 500, role: "walk", root: "w1" }; store.push(sel1)
    await actsFactRow(episodeOf(store, "w1"), "w1", write, sel1.id)
    const sel2 = { shape: "selection", id: "s-t2", seq: 600, role: "walk", root: "w1" }; store.push(sel2)
    const again = await actsFactRow(episodeOf(store, "w1"), "w1", write, sel2.id)
    expect(written).toHaveLength(1)
    expect(again).toBe("ra0")
    expect(written[0].selection_ref).toBe("s-t1")
  })

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
    expect(Object.keys(f).sort()).toEqual(["acts", "not_called", "repeats", "root"]) // facts only: what a row means is said once
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

describe("what a request keeps repeating", () => {
  let n = 500
  const sel = (root: string, a: string) => ({ shape: "selection", id: `rs${++n}`, seq: n, role: "walk", root, a })
  const tmpl = { shape: "activity_template", id: "t-diff", seq: 1, role: "described", sig: { in: ["gitWorktree"] }, calls: [{ shape: "git_diff", pointer: {} }] }
  const NO_COMMIT = '{"error":"the clone has no commit since it was made: there is no change to diff"}'
  const failedRun = (root: string, cwd: string, body = NO_COMMIT) => {
    const s = sel(root, "run/t-diff")
    const h = { shape: "hop", id: `rh${++n}`, seq: n, role: "walk", phase: "started", selection_ref: s.id, call_id: `rc${n}`, pointer_type: "git_diff", args: { cwd } }
    const f = { shape: "failure", id: `rf${++n}`, seq: n, role: "walk", selection_ref: s.id, call_id: h.call_id, status: 422, body }
    return [s, h, f]
  }
  const clone = (root: string, head: string) => {
    const s = sel(root, "call/git_worktree")
    const h = { shape: "hop", id: `rh${++n}`, seq: n, role: "walk", phase: "started", selection_ref: s.id, call_id: `rc${n}`, pointer_type: "git_worktree", args: { repo: "super" } }
    const g = { shape: "gitWorktree", id: `rg${++n}`, seq: n, role: "walk", call_id: h.call_id, cwd: "/t/a", head, input_refs: [root] }
    return [s, h, g]
  }
  const read = (root: string) => {
    const s = sel(root, "call/fs_read")
    const h = { shape: "hop", id: `rh${++n}`, seq: n, role: "walk", phase: "started", selection_ref: s.id, call_id: `rc${n}`, pointer_type: "fs_read", args: { path: "/t/a/x.ts" } }
    const c = { shape: "fileContent", id: `rc${++n}`, seq: n, role: "walk", call_id: h.call_id, path: "/t/a/x.ts", content: "x", input_refs: [root] }
    return [s, h, c]
  }

  test("[MUST-FAIL] eb1768f6's shape: the same call failing the same way three times, a read of its own between, is a repeat ×3", () => {
    n = 500
    const pool = [...OWNER_ROWS, tmpl, ...clone("w1", "h1"), ...failedRun("w1", "/t/a"), ...failedRun("w1", "/t/a"), ...read("w1"), ...failedRun("w1", "/t/a")]
    expect(actsOf(pool, "w1").repeats).toEqual([expect.objectContaining({ call: "git_diff", n: 3, outcome: expect.stringContaining("no commit since") })])
  })

  test("[MUST-FAIL] 01557de8's shape: the same tree graded r 0 four times is a repeat ×4", () => {
    n = 500
    const pool: any[] = [...OWNER_ROWS]
    for (let i = 0; i < 4; i++) {
      const s = sel("w1", "produce/land_verdict/ch1")
      pool.push(s, { shape: "land_verdict", id: `lv${++n}`, seq: n, role: "described", selection_ref: s.id, tree: "0e4d7b4", r: 0 })
    }
    expect(actsOf(pool, "w1").repeats).toEqual([expect.objectContaining({ produce: "land_verdict", on: "tree 0e4d7b4", outcome: "r 0", n: 4 })])
  })

  test("[MUST-FAIL] a produce refused by its schema three times over the same rows is a repeat ×3, on: refused; over other rows it is not", () => {
    n = 500
    const refusedOn = (key: string, body = '{"error":"does not fit the schema: repo must be a string"}') => {
      const s = { ...sel("w1", "produce/change_wanted/ch1"), seen_key: key }
      const h = { shape: "hop", id: `rh${++n}`, seq: n, role: "walk", phase: "started", selection_ref: s.id, call_id: `rc${n}`, pointer_type: "change_wanted" }
      return [s, h, { shape: "failure", id: `rf${++n}`, seq: n, role: "walk", selection_ref: s.id, call_id: h.call_id, status: 422, refused: "schema", body }]
    }
    const pool: any[] = [...OWNER_ROWS, ...refusedOn("k1"), ...refusedOn("k1"), ...refusedOn("k1")]
    const reps = actsOf(pool, "w1").repeats
    expect(reps).toEqual([expect.objectContaining({ produce: "change_wanted", on: "refused", n: 3, outcome: expect.stringContaining("repo must be") })])
    expect(reps.some((r: any) => r.call !== undefined)).toBe(false) // a refusal is the produce's, never a call's repeat
    // over other rows each time: no repeat
    expect(actsOf([...OWNER_ROWS, ...refusedOn("k1"), ...refusedOn("k2"), ...refusedOn("k3")], "w1").repeats).toEqual([])
    // the owner changing the produced shape's schema between them ends the run
    const after: any[] = [...OWNER_ROWS, ...refusedOn("k1"), ...refusedOn("k1")]
    after.push({ shape: "shape_schema", id: `ss${++n}`, seq: n, role: "owner", target: "change_wanted" }, ...refusedOn("k1"))
    expect(actsOf(after, "w1").repeats).toEqual([])
  })

  test("[MUST-FAIL] owner rows that do not bear on the step (a seed run's credits and answer schema) do not end a repeat; one that does, does", () => {
    n = 500
    const pool: any[] = [...OWNER_ROWS]
    for (let i = 0; i < 5; i++) {
      if (i === 3) pool.push({ shape: "credits", id: `oc${++n}`, seq: n, role: "owner", target: "selection" }, { shape: "shape_schema", id: `os${++n}`, seq: n, role: "owner", target: "answer" })
      const s = sel("w1", "produce/land_verdict/ch1")
      pool.push(s, { shape: "land_verdict", id: `lv${++n}`, seq: n, role: "described", selection_ref: s.id, tree: "a30645e5", r: 0 })
    }
    expect(actsOf(pool, "w1").repeats).toEqual([expect.objectContaining({ produce: "land_verdict", n: 5 })])
    pool.push({ shape: "shape_schema", id: `os${++n}`, seq: n, role: "owner", target: "land_verdict" }) // the grader's own schema changed
    expect(actsOf(pool, "w1").repeats).toEqual([])
  })

  test("[MUST-FAIL] new content the run takes in (a clone with a new head), or a person's row, ends the repeat; a different outcome is not a repeat", () => {
    n = 500
    const head = [...OWNER_ROWS, tmpl, ...clone("w1", "h1"), ...failedRun("w1", "/t/a"), ...failedRun("w1", "/t/a")]
    expect(actsOf([...head, ...clone("w1", "h2")], "w1").repeats).toEqual([])
    expect(actsOf([...head, { shape: "outcome", id: "p1", seq: ++n, role: "person", r: 0 }], "w1").repeats).toEqual([])
    n = 500
    const diff = [...OWNER_ROWS, tmpl, ...failedRun("w1", "/t/a"), ...failedRun("w1", "/t/a", '{"error":"another reason"}')]
    expect(actsOf(diff, "w1").repeats).toEqual([])
  })

  test("[MUST-FAIL] a call cut by a stop (status 0) is not a repeat of the call", () => {
    n = 500
    const cut = (root: string) => failedRun(root, "/t/a", "the walk was stopped before the call ended").map((r: any) => r.shape === "failure" ? { ...r, status: 0 } : r)
    expect(actsOf([...OWNER_ROWS, tmpl, ...cut("w1"), ...cut("w1"), ...cut("w1")], "w1").repeats).toEqual([])
  })

  test("[MUST-FAIL] a 5k-row request with 40 identical failures and 20 verdicts is read in well under a second", () => {
    n = 500
    const pool: any[] = [...OWNER_ROWS, tmpl]
    for (let i = 0; i < 40; i++) pool.push(...failedRun("w1", "/t/a"))
    for (let i = 0; i < 20; i++) { const s = sel("w1", "produce/land_verdict/ch1"); pool.push(s, { shape: "land_verdict", id: `lv${++n}`, seq: n, role: "described", selection_ref: s.id, tree: "t", r: 0 }) }
    while (pool.length < 5000) pool.push({ shape: "answer", id: `an${++n}`, seq: n, role: "described", input_refs: ["w1"] })
    const t0 = performance.now()
    const r = actsOf(pool, "w1").repeats
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(r.map((x) => x.n).sort()).toEqual([20, 40])
  })

  test("[MUST-FAIL] the row is written again when a repeat grows, though acts did not change", async () => {
    n = 500
    const written: any[] = []
    const write = async (row: any) => { const r = { ...row, id: `rr${written.length}`, seq: 9000 + written.length, role: "walk" }; written.push(r); return r }
    const pool: any[] = [...OWNER_ROWS, tmpl, ...failedRun("w1", "/t/a"), ...failedRun("w1", "/t/a")]
    await actsFactRow(pool, "w1", write); pool.push(written[0])
    pool.push(...failedRun("w1", "/t/a"))
    await actsFactRow(pool, "w1", write)
    expect(written.map((w) => w.repeats[0]?.n)).toEqual([2, 3])
  })
})
