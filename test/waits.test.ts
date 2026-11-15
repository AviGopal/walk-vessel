// SPDX-License-Identifier: MIT
// A refusal that waits for a person is kept as a field on the failure row, from the answer itself, however it is wrapped
// or however long its body.
import { afterAll, describe, expect, test } from "bun:test"

describe("a refusal that waits for a person", () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })
  const run = async (status: number, answer: unknown, step: Record<string, unknown> = { id: "call/git_land", kind: "call", pointer: { type: "git_land", cwd: "/t" } }): Promise<Record<string, any> | undefined> => {
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
  const error = "the change touches what judges changes (x): only a person's verdict lands it"

  test("[MUST-FAIL] a 200 carrying the refusal: the field is on the row, even when the body is cut at 1000 chars", async () => {
    const f = await run(200, { error, needs_person: Array.from({ length: 60 }, (_, i) => `repos/x/protected/file-${i}.ts`), waits_for: "person" })
    expect(f?.waits_for).toBe("person")
    expect(String(f?.body).length).toBeLessThanOrEqual(1000)
  })

  test("[MUST-FAIL] wrapped in content (a forwarded call): the field is on the row", async () => {
    expect((await run(200, { content: { error, waits_for: "person" } }))?.waits_for).toBe("person")
  })

  test("[MUST-FAIL] a produce's answer carrying waits_for (a model wrote it) is not lifted: it cannot escape its own debit", async () => {
    const produce = { id: "produce/answer/ch1", kind: "produce", pointer: { type: "answer", shape: "answer", via_ref: "ch1" } }
    const f = await run(200, { error: "cannot act", waits_for: "person" }, produce)
    expect(f).toBeDefined()
    expect(f?.waits_for).toBeUndefined()
    expect((await run(200, { content: { error: "x", waits_for: "person" } }, produce))?.waits_for).toBeUndefined()
  })

  test("[MUST-FAIL] a template's git_land call in a run, refused for a person: the field is on the row (the tool said it)", async () => {
    const tmpl = { id: "run/t-l", kind: "run", pointer: {}, calls: [{ shape: "git_land", pointer: { cwd: "/t" } }] }
    const f = await run(200, { error, waits_for: "person" }, tmpl)
    expect(f).toBeDefined()
    expect(f?.waits_for).toBe("person")
  })

  test("a refusal as a 4xx with the field in its text: on the row; one without the field, or a grader's r 0: none", async () => {
    expect((await run(422, { error, waits_for: "person" }))?.waits_for).toBe("person")
    expect((await run(200, { error: "a grader judged this tree r 0" }))?.waits_for).toBeUndefined()
    expect((await run(422, { error: "only a person's verdict lands it" }))?.waits_for).toBeUndefined() // the words alone: nothing
  })
})
