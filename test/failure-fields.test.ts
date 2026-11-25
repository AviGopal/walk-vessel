// SPDX-License-Identifier: MIT
// A tool's failure row says what it was about as fields: the call made and the path it named, from the pointer sent, and
// the class of failure the tool named for itself, from its answer, however the answer is wrapped or its body cut.
import { afterAll, describe, expect, test } from "bun:test"

describe("what a tool's failure was about", () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })
  const EDIT = { id: "call/fs_edit", kind: "call", pointer: { type: "fs_edit", path: "src/index.ts", old_string: "a", new_string: "b" } }
  const run = async (status: number, answer: unknown, step: Record<string, unknown> = EDIT): Promise<Record<string, any> | undefined> => {
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
  // an fs_edit miss as the tool answers it: the file's own lines first, so a long excerpt fills the kept body
  const miss = { current: "x".repeat(3000), error: "old_string not found in file. current is lines 1-40 of 400", path: "/trees/x/src/index.ts", class: "anchor_mismatch" }

  test("[MUST-FAIL] an fs_edit miss: the call, the path asked for and the tool's class are fields, though the body is cut before the error", async () => {
    const f = await run(200, miss)
    expect(f).toMatchObject({ call: "fs_edit", path: "src/index.ts", class: "anchor_mismatch" })
    expect(String(f?.body).length).toBeLessThanOrEqual(1000)
    expect(String(f?.body)).not.toContain("anchor_mismatch")
  })

  test("[MUST-FAIL] wrapped in content (a forwarded call), or refused as a 4xx: the class is on the row", async () => {
    expect((await run(200, { content: miss }))?.class).toBe("anchor_mismatch")
    expect(await run(422, { error: "no", class: "no_resemblance" })).toMatchObject({ call: "fs_edit", class: "no_resemblance" })
  })

  test("[MUST-FAIL] a template's call in a run: the call and path are the template call's own", async () => {
    const tmpl = { id: "run/t-e", kind: "run", pointer: {}, calls: [{ shape: "fs_edit", pointer: { path: "src/a.ts", old_string: "a", new_string: "b" } }] }
    expect(await run(200, miss, tmpl)).toMatchObject({ call: "fs_edit", path: "src/a.ts", class: "anchor_mismatch" })
  })

  test("[GUARD] a produce's failure carries none of them: a model's answer names no class", async () => {
    const produce = { id: "produce/answer/ch1", kind: "produce", pointer: { type: "answer", shape: "answer", via_ref: "ch1", path: "p" } }
    const f = await run(200, { error: "cannot act", class: "anchor_mismatch" }, produce)
    expect(f).toBeDefined()
    expect([f?.call, f?.path, f?.class]).toEqual([undefined, undefined, undefined])
  })

  test("[GUARD] a class that is no key (not a string, empty, or longer than 64) is not kept; a call naming no path has none", async () => {
    for (const c of [7, "", "k".repeat(65)]) expect((await run(200, { error: "no", class: c }))?.class).toBeUndefined()
    const status = { id: "call/git_status", kind: "call", pointer: { type: "git_status", cwd: "/t" } }
    expect((await run(200, { error: "no" }, status))?.path).toBeUndefined()
  })

  test("[MUST-FAIL] a class of exactly 64 is kept; a call naming no path still names its call", async () => {
    expect((await run(200, { error: "no", class: "k".repeat(64) }))?.class).toBe("k".repeat(64))
    const status = { id: "call/git_status", kind: "call", pointer: { type: "git_status", cwd: "/t" } }
    expect((await run(200, { error: "no" }, status))?.call).toBe("git_status")
  })
})
