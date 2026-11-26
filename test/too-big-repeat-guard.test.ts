// SPDX-License-Identifier: MIT
// A call whose answer hit too_big (blames: "walk", kind: "too_big") settles that exact call until news arrives, just as
// a request-blamed refusal does: asking for the same oversized read again is held with a skip naming too_big, while a
// line-range call on the same path, a read of another path, and transient walk-blamed failures remain callable.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "fix engine.ts" }
const req = (id: string, seq: number, pointer: Record<string, unknown>) =>
  ({ shape: "request", id, seq, role: "described", pointer, input_refs: ["w1"] })

describe("too_big repeat-call guard", () => {
  const realFetch = globalThis.fetch
  const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
  const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  afterAll(() => {
    globalThis.fetch = realFetch
    for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]
  })
  beforeAll(() => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "node-key-for-test",
    })
    globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "local-tools" }] } })) as typeof fetch
  })

  const run = async (pool: any[]) => {
    const { applicable } = await import("../src/applicable")
    const skipped: any[] = []
    const cands = await applicable(pool, skipped, Date.now(), { root: "w1" })
    return { ids: cands.map((c) => c.id), skipped }
  }

  // Exact row sequence written by calls.ts once() + recordAnswer() and stamped by records fold.ts (blames: "walk")
  const bigPath = "src/engine.ts"
  const cwd = "/trees/ias-executor-ts"
  const q1 = req("q1", 2, { type: "fs_read", cwd, path: bigPath })
  const sel1 = { shape: "selection", id: "sel1", seq: 3, role: "walk", root: "w1", a: "call/fs_read", from: "q1" }
  const hs1 = { shape: "hop", id: "hs1", seq: 4, role: "walk", phase: "started", kind: "call", call_id: "c1", pointer_type: "fs_read", selection_ref: "sel1" }
  const he1 = { shape: "hop", id: "he1", seq: 5, role: "walk", phase: "ended", kind: "call", call_id: "c1", selection_ref: "sel1", output: { cut: true, bytes: 113694, start: "{\"shape\":\"fileContent\"..." } }
  const tbBody = "fileContent of 113694 bytes is over what a row holds (98304), so it is not kept: what requires a fileContent row cannot be met from this call, and asking it again answers the same; read and change it in parts (a call answering a line range)"
  const tb1 = {
    shape: "failure", id: "tb1", seq: 6, role: "walk", kind: "too_big", blames: "walk",
    call_id: "c1", selection_ref: "sel1", unrecorded: "fileContent", bytes: 113694,
    body: tbBody, request_ref: "q1", unserved: [tbBody], input_refs: ["sel1"],
  }
  const afterTooBig = [ask, q1, sel1, hs1, he1, tb1]

  test("[MUST-FAIL] a repeat fs_read for the same oversized path after too_big is suppressed and recorded in skipped", async () => {
    const q2 = req("q2", 10, { type: "fs_read", cwd, path: bigPath })
    const res = await run([...afterTooBig, q2])
    expect(res.ids).not.toContain("call/fs_read")
    const skip = res.skipped.find((s) => s.id === "q2")
    expect(skip).toBeDefined()
    expect(skip.of).toBe("request")
    const reason = String(skip.unserved?.[0] ?? "")
    expect(reason).toContain("too_big")
    expect(reason).toContain("row 6")
    expect(reason).toContain("line range")
  })

  test("[MUST-FAIL] a different call for the same path (e.g. code_read_lines with a line range) is still offered", async () => {
    const qRange = req("q2", 10, { type: "code_read_lines", cwd, path: bigPath, start_line: 1, end_line: 120 })
    const res = await run([...afterTooBig, qRange])
    expect(res.ids).toContain("call/code_read_lines")
    expect(res.skipped.find((s) => s.id === "q2")).toBeUndefined()
  })

  test("[GUARD] fs_read for a different path is still offered cleanly", async () => {
    const qOther = req("q2", 10, { type: "fs_read", cwd, path: "src/small.ts" })
    const res = await run([...afterTooBig, qOther])
    expect(res.ids).toContain("call/fs_read")
    expect(res.skipped.find((s) => s.id === "q2")).toBeUndefined()
  })

  test("[GUARD] non-too_big blames: walk transient failures are still retried and not suppressed", async () => {
    const timeoutFail = {
      shape: "failure", id: "f-to", seq: 6, role: "walk", kind: "timeout", blames: "walk",
      call_id: "c1", selection_ref: "sel1", status: 0, body: "request timed out", input_refs: ["sel1"],
    }
    const netFail = {
      shape: "failure", id: "f-net", seq: 6, role: "walk", blames: "walk",
      call_id: "c1", selection_ref: "sel1", status: 0, body: "ECONNRESET", input_refs: ["sel1"],
    }
    const q2 = req("q2", 10, { type: "fs_read", cwd, path: bigPath })
    for (const fail of [timeoutFail, netFail]) {
      const res = await run([ask, q1, sel1, hs1, fail, q2])
      expect(res.ids).toContain("call/fs_read")
      expect(res.skipped.find((s) => s.id === "q2")).toBeUndefined()
    }
  })

  test("[GUARD] new information after too_big (e.g. a file edit ending) reopens the call as with other settled refusals", async () => {
    const hsEdit = { shape: "hop", id: "hs2", seq: 8, role: "walk", phase: "started", kind: "call", call_id: "c2", pointer_type: "fs_edit", selection_ref: "sel2" }
    const heEdit = { shape: "hop", id: "he2", seq: 9, role: "walk", phase: "ended", kind: "call", call_id: "c2", selection_ref: "sel2", output: { edited: bigPath } }
    const q2 = req("q2", 10, { type: "fs_read", cwd, path: bigPath })
    const res = await run([...afterTooBig, hsEdit, heEdit, q2])
    expect(res.ids).toContain("call/fs_read")
    expect(res.skipped.find((s) => s.id === "q2")).toBeUndefined()
  })
})
