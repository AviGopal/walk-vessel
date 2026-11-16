// SPDX-License-Identifier: MIT
// A call that gets no answer (a connection refused or reset) is an outage, never a throw (agf_v6jjy70pfiis: an ECONNRESET
// thrown out of a read the walk needed killed it, and every call in flight was cut): what the walk cannot go on without
// is asked again within READ_WAIT_MS; a tool call is recorded as unanswered (status 0); a refusal still stops the walk.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const realFetch = globalThis.fetch
const realExit = process.exit
let throwsLeft = 0
let refuse = false
const sent: Array<Record<string, any>> = []
let exited = 0
beforeAll(() => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
  })
  // an exit ends the call that made it, as a real one ends the process
  process.exit = ((() => { exited++; throw new Error("exited") }) as unknown) as typeof process.exit
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
    sent.push(pointer)
    if (pointer.type === "vesselCapability" && throwsLeft > 0) {
      throwsLeft--
      throw Object.assign(new Error("socket hang up"), { name: "ECONNRESET" })
    }
    if (pointer.type === "git_diff" && throwsLeft > 0) {
      throwsLeft--
      throw Object.assign(new Error("socket hang up"), { name: "ECONNRESET" })
    }
    if (refuse) return new Response("no", { status: 403 })
    if (pointer.type === "shapeDescriptions") return Response.json({ shape_answers: {}, shape_inputs: { git_diff: { type: "object", properties: { cwd: { type: "string" } } } } })
    if (pointer.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "tools", endpoint: "http://tools.test" }] } })
    if (pointer.type === "record_write") return Response.json({ ...pointer.row, id: `r${sent.length}`, seq: sent.length })
    return Response.json({ ok: true })
  }) as typeof fetch
})
afterAll(() => { globalThis.fetch = realFetch; process.exit = realExit })

const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person" }
const request = { shape: "request", id: "q2", seq: 2, role: "described", pointer: { type: "git_diff", cwd: "/trees/x" }, input_refs: ["w1"] }

describe("a call that gets no answer", () => {
  test("[MUST-FAIL] a read that throws once inside applicable() is asked again: the walk stays up and offers the call", async () => {
    throwsLeft = 1; refuse = false; exited = 0; sent.length = 0
    const { shapeAnswers } = await import("../src/calls")
    await shapeAnswers()
    const { applicable } = await import("../src/applicable")
    const ids = (await applicable([ask, request], [], Date.now(), { root: "w1" })).map((c) => c.id)
    expect(exited).toBe(0)
    expect(ids).toContain("call/git_diff")
    expect(sent.filter((p) => p.type === "vesselCapability").length).toBeGreaterThanOrEqual(2)
  })

  test("[MUST-FAIL] an outage past READ_WAIT_MS stops the walk (its unit restarts it); a refusal stops it at once", async () => {
    const { loopCall, READ_WAIT_MS } = await import("../src/calls")
    throwsLeft = 1_000_000; refuse = false; exited = 0
    let t = 0
    const pauses: number[] = []
    await loopCall("vesselCapability", { shape: "x" }, async (ms) => { pauses.push(ms); t += ms }, () => t).catch(() => undefined)
    throwsLeft = 0
    expect(exited).toBe(1)
    expect(pauses.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(READ_WAIT_MS)
    exited = 0; refuse = true
    const pausedOnRefusal: number[] = []
    await loopCall("vesselCapability", { shape: "x" }, async (ms) => { pausedOnRefusal.push(ms) }, () => 0).catch(() => undefined)
    expect([exited, pausedOnRefusal.length]).toEqual([1, 0])
    refuse = false
  })

  test("[MUST-FAIL] a tool call that gets no answer is recorded as unanswered (status 0, blamed on no writer), never thrown", async () => {
    throwsLeft = 1; refuse = false; exited = 0; sent.length = 0
    const { execute } = await import("../src/calls")
    const sel = { shape: "selection", id: "sel-1", seq: 3, pool_refs: ["w1"] }
    await execute({ id: "call/git_diff", kind: "call", pointer: { type: "git_diff", cwd: "/trees/x" }, t: "", calls: [] } as any, sel as any)
    const failure = sent.find((p) => p.type === "record_write" && p.row?.shape === "failure")?.row
    expect([failure?.status, String(failure?.body).startsWith("no answer: ECONNRESET")]).toEqual([0, true])
    expect(exited).toBe(0)
  })
})
