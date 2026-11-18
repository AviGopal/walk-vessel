// SPDX-License-Identifier: MIT
// What a produce cost and who answered it (described-shape's spend: model, fallback_from, prompt_bytes, output_tokens,
// stop_reason) is kept on the walk's failure row as one record when described refuses, read from described's non-200
// envelope only and only for a produce: a produce's 200 is the model's text, and a tool's answer is not described's.
import { afterAll, describe, expect, test } from "bun:test"

describe("a refusal's spend, kept on the failure row", () => {
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
  const refusal = (spend: unknown) => ({ failure: { status: 422, body: "x", refused: "schema", stop_reason: "end_turn", output_tokens: 77, spend } })
  const SPEND = { model: "model-served", fallback_from: "model-asked", prompt_bytes: 470123, output_tokens: 77, stop_reason: "end_turn" }

  test("[MUST-FAIL] described's 422 carrying a spend: the whole record on the failure row, beside the flat ending as before", async () => {
    const got = await run(422, refusal(SPEND))
    expect([got?.spend, got?.stop_reason, got?.output_tokens, "model" in (got ?? {})]).toEqual([SPEND, "end_turn", 77, false])
  })
  test("a produce's 200 cannot set it, though it is written as a failure; a call's 422 keeps none (a guard)", async () => {
    const own = await run(200, { error: "x", failure: { status: 422, spend: SPEND } })
    const call = await run(422, refusal(SPEND), { id: "call/fs_read", kind: "call", pointer: { type: "fs_read", path: "src/a.ts" } })
    expect([own?.shape, "spend" in (own ?? {}), call?.shape, "spend" in (call ?? {})]).toEqual(["failure", false, "failure", false])
  })
  test("[MUST-FAIL] each field kept only with its type: a non-empty string model, fallback and ending, a number of bytes and tokens", async () => {
    const odd = await run(422, refusal({ model: 5, fallback_from: "", prompt_bytes: "470123", output_tokens: "77", stop_reason: 3, extra: "dropped" }))
    expect([odd?.status, odd?.refused, "spend" in (odd ?? {})]).toEqual([422, "schema", false])
    for (const [k, bad] of [["model", 5], ["fallback_from", ""], ["prompt_bytes", "470123"], ["output_tokens", "77"], ["stop_reason", 3]] as const) {
      const got = await run(422, refusal({ ...SPEND, [k]: bad }))
      const { [k]: _gone, ...rest } = SPEND
      expect([k, got?.spend]).toEqual([k, rest])
    }
    expect((await run(422, refusal({ model: "m", extra: "dropped" })))?.spend).toEqual({ model: "m" })
  })
  test("a spend that is not an object, or none, is no field and the refusal's row still written (a guard)", async () => {
    for (const bad of ["model-served", 470123, null, undefined]) {
      const got = await run(422, refusal(bad))
      expect([String(bad), got?.status, got?.refused, "spend" in (got ?? {})]).toEqual([String(bad), 422, "schema", false])
    }
  })
})
