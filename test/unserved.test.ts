// SPDX-License-Identifier: MIT
// A call that never reached a producer is kept as a field on the failure row (unserved: the shape), so records blames
// it on the callee and debits no one. Read from fields only, and from where a model cannot write them: a producer's
// failure envelope, a non-200 answer (the router's own), or a tool's own answer. A produce's 200 cannot set it.
import { afterAll, describe, expect, test } from "bun:test"

describe("a call nothing answered", () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })
  const run = async (status: number, answer: unknown, step: Record<string, unknown>): Promise<Record<string, any> | undefined> => {
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
  const call = { id: "call/some_tool", kind: "call", pointer: { type: "some_tool" } }
  const produce = { id: "produce/answer/ch", kind: "produce", pointer: { type: "answer", shape: "answer", via_ref: "ch" } }

  test("[MUST-FAIL] the router's own 404 for a shape no one serves: unserved on the row, for a call and a produce", async () => {
    const routed = { error: "Not found", shape: "some_tool", unserved: "some_tool" }
    expect((await run(404, routed, call))?.unserved).toBe("some_tool")
    expect((await run(404, { error: "Not found", shape: "answer", unserved: "answer" }, produce))?.unserved).toBe("answer")
  })

  test("[MUST-FAIL] a producer's failure envelope saying its own call was unserved: on the row (a produce)", async () => {
    const f = await run(502, { failure: { status: 502, body: "{…}", unserved: "llm_completion" } }, produce)
    expect(f).toMatchObject({ status: 502, unserved: "llm_completion" })
  })

  test("[MUST-FAIL] a tool's own 200 refusal saying unserved: on the row (a call)", async () => {
    expect((await run(200, { resolved: false, error: "cooling", unserved: "some_shape" }, call))?.unserved).toBe("some_shape")
    expect((await run(200, { content: { error: "x", unserved: "some_shape" } }, call))?.unserved).toBe("some_shape")
  })

  test("[MUST-FAIL] a produce's 200 cannot set it, nor can any answer with no such field; a producer's own 404 stays a 404", async () => {
    expect((await run(200, { error: "x", unserved: "answer" }, produce))?.unserved).toBeUndefined()
    // a produce's 200 carrying a failure envelope of its own making cannot set it either (deployment)
    expect((await run(200, { error: "x", failure: { status: 502, unserved: "llm_completion" } }, produce))?.unserved).toBeUndefined()
    expect((await run(200, { content: { error: "x", unserved: "answer" } }, produce))?.unserved).toBeUndefined()
    expect((await run(404, { error: "no such id" }, call))?.unserved).toBeUndefined()
    expect((await run(502, { failure: { status: 502, body: "provider refused" } }, produce))?.unserved).toBeUndefined()
  })
})
