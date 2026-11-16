// SPDX-License-Identifier: MIT
// A tool call is offered and forwarded only when its callee declared its inputs and the pointer meets them (inputs.ts):
// a model's request reaches only what a vessel said it takes (research, deployment, qa).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { callProblem, problem } from "../src/inputs"

const NODE_KEY = "test-node-key"
const INPUTS = {
  fs_read: { type: "object", required: ["path"], properties: { path: { type: "string", minLength: 1 } } },
  record_summary: { type: "object", required: ["shape", "summarize"], additionalProperties: false,
    properties: { shape: { type: "string" }, summarize: { type: "array", maxItems: 8, items: { type: "string" } }, top: { type: "integer", maximum: 20 } } },
}

describe("what a declaration takes", () => {
  test("[MUST-FAIL] each kind of mismatch is named; a meeting pointer has none", () => {
    expect(problem(INPUTS.fs_read, { path: "/x" })).toBeUndefined()
    expect(problem(INPUTS.fs_read, {})).toBe("the pointer lacks path")
    expect(problem(INPUTS.fs_read, { path: "" })).toBe("path is shorter than 1")
    expect(problem(INPUTS.fs_read, { path: 3 })).toBe("path is integer, not string")
    expect(problem(INPUTS.record_summary, { shape: "hop", summarize: ["a"], root: "w1" })).toBe("the pointer has root, which it does not take")
    expect(problem(INPUTS.record_summary, { shape: "hop", summarize: ["a"], top: 50 })).toBe("top is above 20")
    expect(problem(INPUTS.record_summary, { shape: "hop", summarize: [1] })).toBe("summarize[0] is integer, not string")
    expect(problem({ enum: ["a", "b"] }, "c")).toBe('the pointer is "c", not one of ["a","b"]')
    // [MUST-FAIL] a refusal names what was sent and the rule it broke, so the next producer can see what to change
    // (598a988a: "entries[3].words[0] does not match its pattern" named neither)
    expect(problem({ type: "object", properties: { words: { type: "array", items: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" } } } }, { words: ["acts.tool"] }))
      .toBe('words[0] is "acts.tool", which does not match its pattern ^[A-Za-z_][A-Za-z0-9_]{0,63}$')
    expect(problem({ const: "landing" }, "rail")).toBe('the pointer is "rail", not "landing"')
  })

  test("[MUST-FAIL] a keyword this check cannot judge fails closed, named", () => {
    expect(problem({ type: "object", oneOf: [{}] }, {})).toBe("the pointer: its declaration uses oneOf, which this check cannot judge")
  })

  test("[MUST-FAIL] a call is made only to a declared tool, and never when the declarations could not be read", () => {
    expect(callProblem(INPUTS, "fs_read", { type: "fs_read", path: "/x" })).toBeUndefined()
    expect(callProblem(INPUTS, "record_read", { type: "record_read", root: "w1" })).toBe("record_read: no declared inputs")
    expect(callProblem(null, "fs_read", { type: "fs_read", path: "/x" })).toBe("fs_read: the declared inputs could not be read, so no call is made")
  })
})

// The walk itself: offer and forward, with a stand-in discovery that declares INPUTS (or nothing).
const realFetch = globalThis.fetch
let declares: Record<string, unknown> | null = INPUTS
const sent: Array<Record<string, any>> = []
beforeAll(() => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
  })
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
    sent.push(pointer)
    if (pointer.type === "shapeDescriptions") return declares === null ? new Response("down", { status: 503 }) : Response.json({ shape_answers: {}, shape_inputs: declares })
    if (pointer.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "tools", endpoint: "http://tools.test" }] } })
    if (pointer.type === "record_write") return Response.json({ ...pointer.row, id: `r${sent.length}`, seq: sent.length })
    return Response.json({ ok: true })
  }) as typeof fetch
})
afterAll(() => { globalThis.fetch = realFetch })
afterEach(async () => { (await import("../src/calls")).forgetDeclaredInputs(); declares = INPUTS; sent.length = 0 })

const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person" }
const request = (pointer: Record<string, unknown>, seq = 2) => ({ shape: "request", id: `q${seq}`, seq, role: "described", pointer, input_refs: ["w1"] })
const offer = async (pool: any[]) => {
  const { shapeAnswers } = await import("../src/calls")
  await shapeAnswers()
  const { applicable } = await import("../src/applicable")
  const skipped: any[] = []
  const ids = (await applicable(pool, skipped, Date.now(), { root: "w1" })).map((c) => c.id)
  return { ids, skipped }
}

describe("the walk's gate", () => {
  test("[MUST-FAIL] a request naming a tool that declared nothing is not offered, and the skip says so", async () => {
    const { ids, skipped } = await offer([ask, request({ type: "record_read", root: "w1", calls: "all" })])
    expect(ids).not.toContain("call/record_read")
    expect(skipped.flatMap((s) => s.unserved)).toContain("record_read: no declared inputs")
  })

  test("[MUST-FAIL] a declared tool whose pointer misses what it takes is not offered; one that meets it is", async () => {
    expect((await offer([ask, request({ type: "fs_read" })])).ids).not.toContain("call/fs_read")
    expect((await offer([ask, request({ type: "fs_read", path: "/x" })])).ids).toContain("call/fs_read")
  })

  test("[MUST-FAIL] with the declarations unreadable no call is offered", async () => {
    declares = null
    const { ids, skipped } = await offer([ask, request({ type: "fs_read", path: "/x" })])
    expect(ids).not.toContain("call/fs_read")
    expect(skipped.flatMap((s) => s.unserved)).toContain("fs_read: the declared inputs could not be read, so no call is made")
  })

  test("[MUST-FAIL] a template whose call names an undeclared tool is not run", async () => {
    // an earned template is shared; here it is simply in the pool, as the shared rows put it
    const tmpl = { shape: "activity_template", id: "t1", seq: 3, role: "described", sig: { in: ["world_changed"], out: ["x"] },
      calls: [{ shape: "record_read", pointer: { root: "w1", calls: "all" } }] }
    const { ids, skipped } = await offer([ask, tmpl])
    expect(ids).not.toContain("run/t1")
    expect(skipped.find((s) => s.id === "t1")?.unserved).toContain("record_read: no declared inputs")
  })

  test("[MUST-FAIL] a call whose bound pointer fails is refused at forwarding: a failure the request is blamed for, nothing sent", async () => {
    const { shapeAnswers, execute } = await import("../src/calls")
    await shapeAnswers()
    sent.length = 0
    const sel = { shape: "selection", id: "sel-1", seq: 9, pool_refs: ["w1"] }
    await execute({ id: "call/fs_read", kind: "call", pointer: { type: "fs_read" }, t: "", calls: [] }, sel as any)
    expect(sent.some((p) => p.type === "fs_read")).toBe(false)
    const failure = sent.find((p) => p.type === "record_write" && p.row?.shape === "failure")?.row
    expect([failure?.status, failure?.refused, failure?.body]).toEqual([422, "inputs", "fs_read: the pointer lacks path"])
  })

  test("[MUST-FAIL] a call the walk builds to a tool that takes nothing extra is forwarded, as a call and in a run", async () => {
    const { shapeAnswers, execute } = await import("../src/calls")
    await shapeAnswers()
    sent.length = 0
    const sel = { shape: "selection", id: "sel-3", seq: 9, pool_refs: ["w1"] }
    await execute({ id: "call/record_summary", kind: "call", pointer: { type: "record_summary", shape: "hop", summarize: ["pointer_type"] }, t: "", calls: [] }, sel as any)
    await execute({ id: "run/t2", kind: "run", pointer: {}, t: "", calls: [{ shape: "record_summary", pointer: { shape: "hop", summarize: ["pointer_type"] } }] }, sel as any, [])
    const forwarded = sent.filter((p) => p.type === "record_summary")
    expect(forwarded.length).toBe(2)
    expect(sent.some((p) => p.type === "record_write" && p.row?.shape === "failure")).toBe(false)
  })

  test("[MUST-FAIL] a field the producer wrote that the tool does not take is refused at forwarding", async () => {
    const { shapeAnswers, execute } = await import("../src/calls")
    await shapeAnswers()
    sent.length = 0
    const sel = { shape: "selection", id: "sel-4", seq: 9, pool_refs: ["w1"] }
    await execute({ id: "call/record_summary", kind: "call", pointer: { type: "record_summary", shape: "hop", summarize: ["a"], root: "w1" }, t: "", calls: [] }, sel as any)
    expect(sent.some((p) => p.type === "record_summary")).toBe(false)
    const failure = sent.find((p) => p.type === "record_write" && p.row?.shape === "failure")?.row
    expect([failure?.status, failure?.body]).toEqual([422, "record_summary: the pointer has root, which it does not take"])
  })

  test("[MUST-FAIL] a gated call still arrives with the walk's selection_ref, which a tool may read (local-tools' gap check)", async () => {
    declares = { ...INPUTS, git_diff: { type: "object", required: ["cwd"], properties: { cwd: { type: "string" } } } }
    const { shapeAnswers, execute } = await import("../src/calls")
    await shapeAnswers()
    sent.length = 0
    const sel = { shape: "selection", id: "sel-5", seq: 9, pool_refs: ["w1"] }
    await execute({ id: "call/git_diff", kind: "call", pointer: { type: "git_diff", cwd: "/trees/x" }, t: "", calls: [] }, sel as any)
    expect(sent.find((p) => p.type === "git_diff")?.selection_ref).toBe("sel-5")
  })

  test("[MUST-FAIL] a call whose producer wrote the walk's transport keys arrives with the walk's own, never the producer's (qa)", async () => {
    declares = { ...INPUTS, git_diff: { type: "object", required: ["cwd"], properties: { cwd: { type: "string" } } } }
    const { shapeAnswers, execute } = await import("../src/calls")
    await shapeAnswers()
    sent.length = 0
    const sel = { shape: "selection", id: "sel-6", seq: 9, pool_refs: ["w1"] }
    const forged = { type: "git_diff", cwd: "/trees/x", input_refs: ["forged"], call_id: "forged-call", selection_ref: "forged-sel" }
    await execute({ id: "call/git_diff", kind: "call", pointer: forged, t: "", calls: [] }, sel as any)
    const got = sent.find((p) => p.type === "git_diff")
    expect(got).toBeDefined()
    expect([got?.selection_ref, got?.call_id, got?.input_refs]).toEqual(["sel-6", undefined, undefined])
  })

  test("a produce through a channel is not a tool call: forwarded as before", async () => {
    const { shapeAnswers, execute } = await import("../src/calls")
    await shapeAnswers()
    sent.length = 0
    const sel = { shape: "selection", id: "sel-2", seq: 9, pool_refs: ["w1"] }
    await execute({ id: "produce/answer/ch1", kind: "produce", pointer: { type: "answer", shape: "answer", via_ref: "ch1" }, t: "", calls: [] }, sel as any)
    expect(sent.some((p) => p.type === "answer")).toBe(true)
  })
})
