// SPDX-License-Identifier: MIT
// A tool that brought its clone onto a newer base says so (refreshed); the walk records that as a row of its own, once.
import { afterAll, describe, expect, test } from "bun:test"

describe("a tool's refreshed clone is recorded as a row", () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })
  const R = { shape: "gitWorktree", cwd: "/trees/demo-1", repo: "demo", branch: "dev", base: "B1", refreshed_from: "B0", super_base: "s", origin_url: "o" }
  const run = async (status: number, answer: unknown, step: Record<string, unknown>) => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
    })
    const written: Array<Record<string, any>> = []
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      if (pointer.type === "record_write") { written.push(pointer.row); return Response.json({ ...pointer.row, id: `r${written.length}`, seq: written.length }) }
      // which vessels serve a shape: local-tools serves the clone tools and gitWorktree; records serves verdicts
      if (pointer.type === "vesselCapability") {
        const lt = ["git_diff", "git_worktree", "gitWorktree", "gitDiff"].includes(pointer.shape)
        const other = ["web_search"].includes(pointer.shape)
        return Response.json({ content: { vessels: lt ? [{ vesselId: "local-tools" }] : other ? [{ vesselId: "search" }] : pointer.shape === "land_verdict" ? [{ vesselId: "records" }] : [] } })
      }
      return Response.json(answer, { status })
    }) as typeof fetch
    const { execute } = await import("../src/calls")
    await execute({ t: "", calls: [], ...step } as any, { shape: "selection", id: "s1", seq: 9, root: "w1" } as any)
    return written.filter((r) => r.shape === "gitWorktree")
  }
  const CALL = { id: "call/git_diff", kind: "call", pointer: { type: "git_diff", cwd: "/trees/demo-1" } }

  test("[MUST-FAIL] (i) a call whose answer says refreshed: exactly one row of its shape, citing the request, with the call", async () => {
    const rows = await run(200, { refreshed: R, shape: "gitDiff", tree: "T", diff: "d" }, CALL)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ...R, input_refs: ["w1"], selection_ref: "s1" })
    expect(typeof rows[0].call_id).toBe("string")
  })

  test("[MUST-FAIL] a refreshed row of a shape the called vessel does not serve is written by no one", async () => {
    // a verdict named by a clone tool's answer: local-tools does not serve land_verdict
    expect((await run(200, { refreshed: { ...R, shape: "land_verdict", r: 1, tree: "T" }, shape: "gitDiff" }, CALL))).toHaveLength(0)
    // a gitWorktree named by another capability's answer: it does not serve gitWorktree
    expect(await run(200, { refreshed: R, results: [] }, { id: "call/web_search", kind: "call", pointer: { type: "web_search", q: "x" } })).toHaveLength(0)
  })

  test("[MUST-FAIL] a tool that fails after moving its clone: the move is recorded all the same (a 200 error, or a 4xx)", async () => {
    expect(await run(200, { refreshed: R, error: "the typecheck failed" }, CALL)).toEqual([expect.objectContaining({ ...R, input_refs: ["w1"] })])
    expect(await run(422, { refreshed: R, error: "nothing to land" }, CALL)).toHaveLength(1)
  })

  test("[MUST-FAIL] (i) a template's call too; a refusal, a call that was not behind, or a produce's answer: none", async () => {
    expect(await run(200, { refreshed: R, shape: "gitDiff" }, { id: "run/t", kind: "run", pointer: {}, calls: [{ shape: "git_diff", pointer: { cwd: "/trees/demo-1" } }] })).toHaveLength(1)
    expect(await run(200, { error: "could not be brought onto it", conflicts: ["a.ts"] }, CALL)).toHaveLength(0) // no move: nothing
    expect(await run(200, { shape: "gitDiff", tree: "T" }, CALL)).toHaveLength(0)
    expect(await run(200, { refreshed: R, text: "a model's answer" }, { id: "produce/answer/ch1", kind: "produce", pointer: { type: "answer", shape: "answer", via_ref: "ch1" } })).toHaveLength(0)
  })
})
