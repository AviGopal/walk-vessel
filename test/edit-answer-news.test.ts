// SPDX-License-Identifier: MIT
// An edit's answer is news to the request that reads hops only when it differs from an earlier answer of the same call
// type on the root. local-tools answers a line replace with its range and counts, and every tool that writes a file with
// `after`, the sha256 of the file's bytes once written. Two replaces of one range writing different text then answer
// differently, so the next request is offered over the second; a replace that leaves the same bytes again is no news.
// Without `after`, the two answers were the same, the second read as a repeat, and the root sat with no move.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
const base: any[] = [
  { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "fix the failing check" },
  own({ shape: "channel", id: "ch1", calls: [] }, 2),
  own({ shape: "shape_schema", id: "sq", target: "request", inputs: ["world_changed"], context: ["hop", "failure"] }, 3),
]
const replace = (seq: number, after?: string) => {
  const out = { shape: "codeReplaceResult", path: "src/engine.ts", start_line: 1669, end_line: 1669, lines_removed: 1, new_total_lines: 2400, ...(after ? { after } : {}) }
  return [
    { shape: "selection", id: `sel${seq}`, seq, role: "walk", root: "w1", a: "call/code_replace_lines" },
    { shape: "hop", id: `hs${seq}`, seq: seq + 1, role: "walk", phase: "started", kind: "call", call_id: `c${seq}`, pointer_type: "code_replace_lines", selection_ref: `sel${seq}` },
    { shape: "hop", id: `he${seq}`, seq: seq + 2, role: "walk", phase: "ended", kind: "call", call_id: `c${seq}`, selection_ref: `sel${seq}`, output: out },
  ]
}
// the request made after the first edit: its selection (with the key of what it was handed), its ended hop, its row
const made = [
  { shape: "selection", id: "sel20", seq: 20, role: "walk", root: "w1", a: "produce/request/ch1", seen_key: "k-made" },
  { shape: "hop", id: "hp21", seq: 21, role: "walk", phase: "ended", kind: "produce", selection_ref: "sel20" },
  { shape: "request", id: "q22", seq: 22, role: "described", selection_ref: "sel20", input_refs: ["w1", "he10"],
    pointer: { type: "code_replace_lines", path: "src/engine.ts", start_line: 1669, end_line: 1669, text: "b" } },
]

describe("an edit's answer is news when it says the file was left otherwise", () => {
  // The stub and the env are this file's own: restored after it, or a later file in the same process is answered by it.
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
    globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
  })
  const offered = async (pool: any[]): Promise<boolean> => {
    const { applicable } = await import("../src/applicable")
    return (await applicable(pool, [], Date.now(), { root: "w1" })).map((c) => c.id).includes("produce/request/ch1")
  }

  test("[GUARD] a second replace of the same range that left other bytes (another after) offers the next request", async () => {
    expect(await offered([...base, ...replace(10, "a1"), ...made, ...replace(30, "a2")])).toBe(true)
  })
  test("[GUARD] a second replace that left the same bytes (the same after) is no news", async () => {
    expect(await offered([...base, ...replace(10, "a1"), ...made, ...replace(30, "a1")])).toBe(false)
  })
  test("[GUARD] answers naming no after cannot tell two replaces of one range apart: the second is no news", async () => {
    expect(await offered([...base, ...replace(10), ...made, ...replace(30)])).toBe(false)
  })
  test("[GUARD] with no edit since the request was made, it is not offered again", async () => {
    expect(await offered([...base, ...replace(10, "a1"), ...made])).toBe(false)
  })
})
