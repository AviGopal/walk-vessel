// SPDX-License-Identifier: MIT
// Where a clone is now (`clone`), from a tool's answer, is recorded as a row of its own shape, as `refreshed` is: on a
// call that ended and on one that was refused, with the call_id and the root. Only a tool's answer; a produce's never.
import { afterAll, describe, expect, test } from "bun:test"

describe("a tool's answer saying where the clone is", () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })
  const run = async (status: number, answer: unknown, kind = "call"): Promise<Array<Record<string, any>>> => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
    })
    const written: Array<Record<string, any>> = []
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      if (pointer.type === "record_write") { written.push(pointer.row); return Response.json({ ...pointer.row, id: "r", seq: 1 }) }
      // one vessel serves the tool and the row shape it names, so the row is the tool's to say
      if (pointer.type === "vessel_capability" || pointer.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "tools", endpoint: "http://tools.test" }] } })
      return Response.json(answer, { status })
    }) as typeof fetch
    const { execute } = await import("../src/calls")
    const step = kind === "call" ? { id: "call/git_land", kind: "call", pointer: { type: "git_land", cwd: "/c" } }
      : { id: "produce/answer/ch", kind: "produce", pointer: { type: "answer", shape: "answer", via_ref: "ch" } }
    await execute({ t: "", calls: [], ...step } as any, { shape: "selection", id: "s1", seq: 9, root: "root-1" } as any)
    return written.filter((r) => r.shape === "gitWorktree")
  }
  const clone = { shape: "gitWorktree", cwd: "/c", repo: "r", branch: "dev", base: "B", head: "H3", tree: "T3" }

  test("[MUST-FAIL] a refused land's `clone` and an ended call's `clone` are each recorded as a gitWorktree row of the root", async () => {
    const refused = await run(200, { error: "no verdict approves this tree", tree: "T3", clone })
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ shape: "gitWorktree", cwd: "/c", head: "H3", tree: "T3", selection_ref: "s1", input_refs: ["root-1"] })
    expect(typeof refused[0].call_id).toBe("string")
    const ended = await run(200, { shape: "gitLand", cwd: "/c", pushed: true, clone })
    expect(ended.map((r) => r.tree)).toEqual(["T3"])
  })

  test("[MUST-FAIL] a produce's answer naming a clone writes no row", async () => {
    expect(await run(200, { text: "t", clone }, "produce")).toEqual([])
  })
})
