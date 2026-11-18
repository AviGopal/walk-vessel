// SPDX-License-Identifier: MIT
// A produce refused only for citing values it was shown says so in described-shape's own failure envelope (context_gap:
// each value and the shown row it was seen in), and the walk keeps it on the failure row, where records reads it: such a
// refusal charges no one. Read from a non-200 envelope only: a produce's 200 is the model's text, and cannot set it.
import { afterAll, describe, expect, test } from "bun:test"

describe("a refusal's context gap, kept on the failure row", () => {
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
  const refusal = (gap: unknown) => ({ failure: { status: 422, body: "x is not a row it was shown", refused: "schema", context_gap: gap } })

  test("[MUST-FAIL] described's 422 naming a context gap: each value and the row it was seen in, on the failure row", async () => {
    const gap = [{ value: "86353", seen_in: "row-a" }, { value: "row-b", seen_in: "row-c" }]
    expect(await run(422, refusal(gap))).toMatchObject({ status: 422, refused: "schema", context_gap: gap })
  })
  test("a produce's 200 cannot set it, though it is written as a failure; an envelope without it adds none (a guard)", async () => {
    // a 200 carrying an error is written as a failure row, so the field's absence there is a reading, not a row missing
    const own = await run(200, { error: "x", failure: { status: 422, context_gap: [{ value: "86353", seen_in: "row-a" }] } })
    expect([own?.shape, "context_gap" in (own ?? {})]).toEqual(["failure", false])
    const none = await run(422, { failure: { status: 422, body: "x", refused: "schema" } })
    expect("context_gap" in (none ?? {})).toBe(false)
  })
  test("a tool's answer cannot say it: a call's 422 naming a context gap keeps no field (a guard)", async () => {
    const call = { id: "call/fs_read", kind: "call", pointer: { type: "fs_read", path: "src/a.ts" } }
    const got = await run(422, refusal([{ value: "86353", seen_in: "row-a" }]), call)
    expect([got?.shape, "context_gap" in (got ?? {})]).toEqual(["failure", false])
  })
  test("[MUST-FAIL] only well-formed entries are kept, at most 20, and none kept is no field", async () => {
    const mixed = await run(422, refusal([{ value: 86353, seen_in: "row-a" }, { value: "v", seen_in: "row-b" }, { value: "", seen_in: "row-c" }, { value: "v2", seen_in: 7 }, { value: "v3" }, { value: "v4", seen_in: "" }, "v", null]))
    expect(mixed?.context_gap).toEqual([{ value: "v", seen_in: "row-b" }])
    const many = await run(422, refusal(Array.from({ length: 25 }, (_, i) => ({ value: `v${i}`, seen_in: `row-${i}`, extra: "dropped" }))))
    expect([many?.context_gap?.length, many?.context_gap?.[0]]).toEqual([20, { value: "v0", seen_in: "row-0" }])
    const bad = await run(422, refusal("not a list"))
    expect("context_gap" in (bad ?? {})).toBe(false)
  })
  test("a context_gap that is not a list still writes the refusal's own failure row, with no field (a guard)", async () => {
    // the call's catch would write a failure of its own (status 0, the error as body), so the refusal's status is what shows
    // its row was written
    for (const gap of ["86353", { value: "v", seen_in: "r" }]) {
      const got = await run(422, refusal(gap))
      expect([JSON.stringify(gap), got?.shape, got?.status, got?.refused, "context_gap" in (got ?? {})]).toEqual([JSON.stringify(gap), "failure", 422, "schema", false])
    }
  })
})
