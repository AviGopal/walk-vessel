// SPDX-License-Identifier: MIT
// A call that changed nothing the walk can tell apart is said. A call that ended with an answer an earlier call of its type
// on the root already gave is no news, so the request that asked for it is not produced again over it; with nothing else
// new the root sat with no move, its producer never told why (0c5f). The walk holds that request for it: a reason naming
// the call type and the earlier row, written once (recordSkipped), news once to the request (the held rule), so the
// request is produced again with the reason in view. The same answer repeated again tells nothing new; another answer
// repeated is a new reason; an answer that is not a repeat says nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
const base: any[] = [
  { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "fix the failing check" },
  own({ shape: "channel", id: "ch1", calls: [] }, 2),
  own({ shape: "shape_schema", id: "sq", target: "request", inputs: ["world_changed"], context: ["hop", "failure"] }, 3),
]
const pointer = { type: "code_replace_lines", path: "src/engine.ts", start_line: 1669, end_line: 1669, text: "b" }
// a request at seq, made by a produce selection that kept what it was handed
const ask = (seq: number) => [
  { shape: "selection", id: `sel${seq}`, seq, role: "walk", root: "w1", a: "produce/request/ch1", seen_key: `k${seq}` },
  { shape: "hop", id: `hp${seq}`, seq: seq + 1, role: "walk", phase: "ended", kind: "produce", selection_ref: `sel${seq}` },
  { shape: "request", id: `q${seq + 2}`, seq: seq + 2, role: "described", selection_ref: `sel${seq}`, input_refs: ["w1"], pointer },
]
// the call for request q<from>, at seq, answering with after (its ended hop at seq + 2)
const replace = (seq: number, from: number, after: string) => [
  { shape: "selection", id: `sel${seq}`, seq, role: "walk", root: "w1", a: "call/code_replace_lines", from: `q${from}` },
  { shape: "hop", id: `hs${seq}`, seq: seq + 1, role: "walk", phase: "started", kind: "call", call_id: `c${seq}`, pointer_type: "code_replace_lines", selection_ref: `sel${seq}` },
  { shape: "hop", id: `he${seq}`, seq: seq + 2, role: "walk", phase: "ended", kind: "call", call_id: `c${seq}`, selection_ref: `sel${seq}`,
    output: { shape: "codeReplaceResult", path: "src/engine.ts", start_line: 1669, end_line: 1669, lines_removed: 1, new_total_lines: 2400, after } },
]
// the skip row the walk writes for a request, at seq
const said = (seq: number, req: string, unserved: string[]) =>
  ({ shape: "failure", kind: "skip", id: `sk${seq}`, seq, role: "walk", request_ref: req, unserved, input_refs: ["w1", req] })

describe("a call that changed nothing the walk can tell apart is said", () => {
  const realFetch = globalThis.fetch
  const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
  const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  const written: any[] = []
  afterAll(() => {
    globalThis.fetch = realFetch
    for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]
  })
  beforeAll(() => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "node-key-for-test",
    })
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const p = (() => { try { return JSON.parse(String(init?.body ?? "{}")).pointer ?? {} } catch { return {} } })()
      if (p.type === "record_write") { written.push(p.row); return Response.json({ ...p.row, id: `w${written.length}`, seq: 1000 + written.length }) }
      return Response.json({ content: { vessels: [{ vesselId: "v" }] } })
    }) as typeof fetch
  })
  const look = async (pool: any[]) => {
    const { applicable } = await import("../src/applicable")
    const skipped: any[] = []
    const ids = (await applicable(pool, skipped, Date.now(), { root: "w1" })).map((c) => c.id)
    return { offered: ids.includes("produce/request/ch1"), skipped: skipped.filter((s) => s.of === "request") }
  }

  // q5's call answered a1 (row 12); q22's call answered a1 again
  const first = [...base, ...ask(3), ...replace(10, 5, "a1"), ...ask(20), ...replace(30, 22, "a1")]
  const reason = "code_replace_lines: it answered as row 12 did, so it changed nothing the walk can tell apart; the same call again answers the same, and a different pointer is a different call"

  test("[MUST-FAIL] a repeat answer holds its request once, naming the call type and the earlier row", async () => {
    const { offered, skipped } = await look(first)
    expect(offered).toBe(false)
    expect(skipped).toEqual([{ id: "q22", of: "request", against_refs: ["he10"], unserved: [reason] }])
  })

  test("[MUST-FAIL] the walk writes that reason once: a second tick over the row it wrote writes nothing", async () => {
    const { recordSkipped } = await import("../src/calls")
    written.length = 0
    await recordSkipped(first, (await look(first)).skipped, undefined, "w1")
    expect(written.map((r) => [r.request_ref, r.unserved])).toEqual([["q22", [reason]]])
    const after = [...first, said(40, "q22", [reason])]
    await recordSkipped(after, (await look(after)).skipped, undefined, "w1")
    expect(written.length).toBe(1)
  })

  test("[GUARD] once said, the request is produced again with the reason in view", async () => {
    expect((await look([...first, said(40, "q22", [reason])])).offered).toBe(true)
  })

  test("[MUST-FAIL] the same answer repeated again, for a later request, gives a reason already told: no news", async () => {
    const again = [...first, said(40, "q22", [reason]), ...ask(50), ...replace(60, 52, "a1")]
    const { offered, skipped } = await look(again)
    expect(skipped.map((s) => s.unserved)).toEqual([[reason]])
    expect((await look([...again, said(70, "q52", [reason])])).offered).toBe(false)
    expect(offered).toBe(false)
  })

  test("[MUST-FAIL] another answer repeated is a new reason, and news", async () => {
    // a2 first answered at row 12 (q5); a1 at row 32 (q22), repeated for q42 and said; then a2 again for q72
    const r32 = reason.replace("row 12", "row 32")
    const two = [...base, ...ask(3), ...replace(10, 5, "a2"), ...ask(20), ...replace(30, 22, "a1"), ...ask(40), ...replace(50, 42, "a1"),
      said(60, "q42", [r32]), ...ask(70), ...replace(80, 72, "a2")]
    const { skipped } = await look(two)
    expect(skipped.map((s) => [s.id, s.unserved])).toEqual([["q72", [reason]]])
    expect((await look([...two, said(90, "q72", [reason])])).offered).toBe(true)
  })

  test("[MUST-FAIL] a request for another call, made earlier, does not hide it: the reason is for the request of the call that repeated", async () => {
    const read = { shape: "request", id: "q2", seq: 2.5, role: "described", input_refs: ["w1"], pointer: { type: "read_file", path: "src/engine.ts" } }
    const { skipped } = await look([...base, read, ...ask(3), ...replace(10, 5, "a1"), ...ask(20), ...replace(30, 22, "a1")])
    expect(skipped.map((s) => s.id)).toEqual(["q22"])
  })

  test("[GUARD] an answer that is not a repeat says nothing", async () => {
    expect((await look([...base, ...ask(3), ...replace(10, 5, "a1"), ...ask(20), ...replace(30, 22, "a2")])).skipped).toEqual([])
  })

  test("[GUARD] an older request's repeat says nothing once a newer request of its call type is here", async () => {
    expect((await look([...first, ...ask(50)])).skipped).toEqual([])
  })
})
