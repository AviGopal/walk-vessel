// SPDX-License-Identifier: MIT
// A produce refused after described resolved a cited seq to a row's id says so in described-shape's own failure envelope
// (seq_resolved: each value's place, the seq and the id), and the walk keeps it on the failure row, so a reader can count
// the refusals of answers that went through resolution. Read from a non-200 envelope only, and only for a produce.
import { afterAll, describe, expect, test } from "bun:test"

describe("a refusal's seq resolutions, kept on the failure row", () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })
  const produce = { id: "produce/answer/ch", kind: "produce", pointer: { type: "answer", shape: "answer", via_ref: "ch" } }
  const run = async (status: number, answer: unknown, step: Record<string, unknown> = produce): Promise<Record<string, any> | undefined> => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
    })
    const written: Array<Record<string, any>> = []
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      if (pointer.type === "record_write") { written.push(pointer.row); return Response.json({ ...pointer.row, id: "r", seq: 1 }) }
      if (pointer.type === "vessel_capability") return Response.json({ content: { vessels: [] } })
      return Response.json(answer, { status })
    }) as typeof fetch
    const { execute } = await import("../src/calls")
    await execute({ t: "", calls: [], ...step } as any, { shape: "selection", id: "s1", seq: 9 } as any)
    return written.find((r) => r.shape === "failure")
  }
  const refusal = (resolved: unknown) => ({ failure: { status: 422, body: "zz is not a row it was shown", refused: "schema", seq_resolved: resolved } })
  const ONE = [{ at: "/evidence_refs/0", seq: "4242", id: "row-a" }]

  test("[MUST-FAIL] described's 422 naming the seqs it resolved: each place, seq and id, on the failure row", async () => {
    expect(await run(422, refusal(ONE))).toMatchObject({ status: 422, refused: "schema", seq_resolved: ONE })
  })
  test("a produce's 200 cannot set it, though it is written as a failure; a call's 422 keeps none (a guard)", async () => {
    const own = await run(200, { error: "x", failure: { status: 422, seq_resolved: ONE } })
    const call = await run(422, refusal(ONE), { id: "call/fs_read", kind: "call", pointer: { type: "fs_read", path: "src/a.ts" } })
    expect([own?.shape, "seq_resolved" in (own ?? {}), call?.shape, "seq_resolved" in (call ?? {})]).toEqual(["failure", false, "failure", false])
  })
  test("[MUST-FAIL] only well-formed entries are kept, at most 20; a list of none, or no list, is no field and the refusal's row still written", async () => {
    const mixed = await run(422, refusal([{ at: "/a", seq: "1", id: "r1" }, { at: "/b", seq: 2, id: "r2" }, { at: "", seq: "3", id: "r3" }, { at: "/d", seq: "4" }, "x", null]))
    expect(mixed?.seq_resolved).toEqual([{ at: "/a", seq: "1", id: "r1" }])
    const many = await run(422, refusal(Array.from({ length: 25 }, (_, i) => ({ at: `/${i}`, seq: String(i), id: `r${i}`, extra: "dropped" }))))
    expect([many?.seq_resolved?.length, many?.seq_resolved?.[0]]).toEqual([20, { at: "/0", seq: "0", id: "r0" }])
    for (const bad of ["4242", { at: "/a", seq: "1", id: "r" }, []]) {
      const got = await run(422, refusal(bad))
      expect([JSON.stringify(bad), got?.status, got?.refused, "seq_resolved" in (got ?? {})]).toEqual([JSON.stringify(bad), 422, "schema", false])
    }
  })
})
