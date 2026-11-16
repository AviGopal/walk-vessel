// SPDX-License-Identifier: MIT
// How a produce's model answer ended (stop_reason, output_tokens) is kept on the failure row, so a reader tells an
// answer cut at the model's output limit from a complete one that was wrong. Read from described-shape's own failure
// envelope on a non-200 only: a produce's 200 is the model's text, and cannot set them.
import { afterAll, describe, expect, test } from "bun:test"

describe("how a refused produce's answer ended", () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })
  const run = async (status: number, answer: unknown): Promise<Record<string, any> | undefined> => {
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
    const produce = { id: "produce/answer/ch", kind: "produce", pointer: { type: "answer", shape: "answer", via_ref: "ch" } }
    await execute({ t: "", calls: [], ...produce } as any, { shape: "selection", id: "s1", seq: 9 } as any)
    return written.find((r) => r.shape === "failure")
  }

  test("[MUST-FAIL] described's 422 for an answer cut at the output limit: stop_reason and output_tokens on the row", async () => {
    // the envelope as described-shape builds it for a cut answer
    const cut = { failure: { status: 422, body: "output cut at the model's output limit after 4096 tokens; text began: \"{\\\"text\\\": \\\"an edit\"", stop_reason: "max_tokens", output_tokens: 4096 } }
    expect(await run(422, cut)).toMatchObject({ status: 422, stop_reason: "max_tokens", output_tokens: 4096 })
    // a complete answer that was wrong says how it ended too; a schema refusal keeps its refused mark beside them
    expect(await run(422, { failure: { status: 422, body: "SyntaxError: x", stop_reason: "end_turn", output_tokens: 12 } })).toMatchObject({ stop_reason: "end_turn", output_tokens: 12 })
    expect(await run(422, { failure: { status: 422, body: "x", refused: "schema", stop_reason: "end_turn", output_tokens: 8 } })).toMatchObject({ refused: "schema", stop_reason: "end_turn", output_tokens: 8 })
  })

  test("[MUST-FAIL] a produce's 200 cannot set them, a non-number count is not kept, and an envelope without them adds none", async () => {
    const own = await run(200, { error: "x", failure: { status: 422, stop_reason: "max_tokens", output_tokens: 4096 } })
    expect([own?.stop_reason, own?.output_tokens]).toEqual([undefined, undefined])
    const odd = await run(422, { failure: { status: 422, body: "x", stop_reason: "max_tokens", output_tokens: "4096" } })
    expect([odd?.stop_reason, "output_tokens" in (odd ?? {})]).toEqual(["max_tokens", false])
    const none = await run(422, { failure: { status: 422, body: "x" } })
    expect(["stop_reason" in (none ?? {}), "output_tokens" in (none ?? {})]).toEqual([false, false])
  })
})
