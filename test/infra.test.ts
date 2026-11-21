// SPDX-License-Identifier: MIT
// A call that gets no answer (a connection refused or reset) is an outage, never a throw (agf_v6jjy70pfiis: an ECONNRESET
// thrown out of a read the walk needed killed it, and every call in flight was cut): what the walk cannot go on without
// is asked again within READ_WAIT_MS; a tool call is recorded as unanswered (status 0); a refusal still stops the walk.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"

const realFetch = globalThis.fetch
const realExit = process.exit
let throwsLeft = 0
let refuse = false
// record_write: "reset" appends the row and then loses the answer; "refused" never connects
let writeFault: "reset" | "refused" | undefined
// answered before any other answer, each taking one: discovery's gate saying identity could not decide ("gate"), or a
// callee's own 503 ("callee"); the row is not stored by either
let answers503: Array<"gate" | "callee"> = []
const stored: Array<Record<string, any>> = []
const sent: Array<Record<string, any>> = []
let exited = 0
// Each test swaps fetch and exit in and out, and forgets the vocabulary it read, so nothing here reaches another file
// run in the same process (deployment: a vocabulary left declaring only git_diff gated other files' calls).
beforeEach(() => {
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
    const a503 = answers503.shift()
    if (a503 === "gate") return Response.json({ error: { code: "IDENTITY_UNAVAILABLE", reason: "identity_http_error" } }, { status: 503 })
    if (a503 === "callee") return Response.json({ error: { code: "UPSTREAM_DOWN" } }, { status: 503 })
    if (pointer.type === "record_write" && writeFault !== undefined) {
      const f = writeFault
      writeFault = undefined
      if (f === "reset") { stored.push(pointer.row); throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }
      throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })
    }
    if (pointer.type === "record_write") stored.push(pointer.row)
    if (refuse) return new Response("no", { status: 403 })
    if (pointer.type === "shapeDescriptions") return Response.json({ shape_answers: {}, shape_inputs: { git_diff: { type: "object", properties: { cwd: { type: "string" } } } } })
    if (pointer.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "tools", endpoint: "http://tools.test" }] } })
    if (pointer.type === "record_write") return Response.json({ ...pointer.row, id: `r${sent.length}`, seq: sent.length })
    return Response.json({ ok: true })
  }) as typeof fetch
})
afterEach(async () => {
  globalThis.fetch = realFetch
  process.exit = realExit
  ;(await import("../src/calls")).forgetDeclaredInputs()
})

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

  test("[MUST-FAIL] a write whose answer was lost after it may have landed is never written again: one row, and the walk stops (qa)", async () => {
    const { writeRow } = await import("../src/calls")
    exited = 0; stored.length = 0; writeFault = "reset"
    await writeRow({ shape: "hop", n: 1 }).catch(() => undefined)
    expect([stored.length, exited]).toEqual([1, 1])
  })

  test("[MUST-FAIL] a write whose connection was refused never reached records: asked again, one row, the walk stays up", async () => {
    const { writeRow } = await import("../src/calls")
    exited = 0; stored.length = 0; writeFault = "refused"
    const row = await writeRow({ shape: "hop", n: 2 })
    expect([stored.length, exited, (row as Record<string, unknown>).n]).toEqual([1, 0, 2])
  })

  test("[MUST-FAIL] a write discovery's gate held because identity could not decide is asked again: one row, the walk stays up", async () => {
    const { writeRow } = await import("../src/calls")
    exited = 0; stored.length = 0; answers503 = ["gate", "gate"]
    const row = await writeRow({ shape: "hop", n: 3 })
    expect([stored.length, exited, (row as Record<string, unknown>).n]).toEqual([1, 0, 3])
  })

  test("[MUST-FAIL] a read discovery's gate held because identity could not decide is asked again, and the walk stays up", async () => {
    const { loopCall } = await import("../src/calls")
    exited = 0; answers503 = ["gate", "gate", "gate"]
    const pauses: number[] = []
    const body = await loopCall("vesselCapability", { shape: "x" }, async (ms) => { pauses.push(ms) }, () => 0)
    expect([exited, pauses.length]).toEqual([0, 3])
    expect(body).toEqual({ content: { vessels: [{ vesselId: "tools", endpoint: "http://tools.test" }] } })
  })

  test("[GUARD] a 503 the callee gave is no outage on the way: a write that may have landed stops the walk, not written again", async () => {
    const { writeRow } = await import("../src/calls")
    exited = 0; stored.length = 0; answers503 = ["callee"]
    await writeRow({ shape: "hop", n: 4 }).catch(() => undefined)
    expect([stored.length, exited]).toEqual([0, 1])
    answers503 = []
  })

  test("[MUST-FAIL] a register discovery's gate held because identity could not decide is sent again, and the walk stays up", async () => {
    const paths: string[] = []
    let held = 1
    globalThis.fetch = (async (url: unknown) => {
      paths.push(new URL(String(url)).pathname)
      if (held-- > 0) return Response.json({ error: { code: "IDENTITY_UNAVAILABLE" } }, { status: 503 })
      return Response.json({ nextHeartbeatMs: 1 })
    }) as typeof fetch
    exited = 0
    const { register } = await import("../src/heartbeat")
    await register(["x"])
    expect([exited, paths.length]).toEqual([0, 2])
  })

  test("[GUARD] a register the gate holds past READ_WAIT_MS stops the walk, as an outage does", async () => {
    const { READ_WAIT_MS } = await import("../src/calls")
    globalThis.fetch = (async () => {
      setSystemTime(new Date(Date.now() + READ_WAIT_MS + 1))
      return Response.json({ error: { code: "IDENTITY_UNAVAILABLE" } }, { status: 503 })
    }) as typeof fetch
    exited = 0
    const { register } = await import("../src/heartbeat")
    await register(["x"]).catch(() => undefined)
    setSystemTime()
    // stopped: here the stub exit throws inside post's try, which counts it again; a real exit ends the process at once
    expect(exited).toBeGreaterThan(0)
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
