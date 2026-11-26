// SPDX-License-Identifier: MIT
// The newest channel row per key (calls[0].pointer.model when non-empty, else calls) supersedes older ones, and one
// marked retired drops the channel from produce candidates; a newer active row for the same key offers it again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
const root = { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "fix the failing test" }
const schema = own({ shape: "shape_schema", id: "s1", target: "answer", inputs: ["world_changed"] }, 2)
const llm = (model: string, extra: Record<string, unknown> = {}) => [{
  pointer: { type: "llm_completion", model, ...extra },
  input_field: "prompt",
  output_field: "content",
  producer_field: "model",
}]

describe("channel retirement and latest-per-channel superseding", () => {
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

  const produceIds = async (pool: any[]): Promise<string[]> => {
    const { applicable } = await import("../src/applicable")
    return (await applicable(pool, [], Date.now(), { root: "w1" }))
      .filter((c) => c.kind === "produce")
      .map((c) => c.id)
      .sort()
  }

  test("[MUST-FAIL] a retired channel produces no candidates while non-retired sibling channels stay offered", async () => {
    const chA = own({ shape: "channel", id: "ch-a", calls: llm("model/alpha") }, 3)
    const chB = own({ shape: "channel", id: "ch-b", calls: llm("model/beta") }, 4)
    const retireA = own({ shape: "channel", id: "ch-a-ret", calls: llm("model/alpha"), retired: true }, 10)
    expect(await produceIds([root, schema, chA, chB, retireA])).toEqual(["produce/answer/ch-b"])
    // ordering in the pool array does not matter: seq decides
    expect(await produceIds([root, schema, retireA, chB, chA])).toEqual(["produce/answer/ch-b"])
  })

  test("[MUST-FAIL] a newer active channel row for the same model supersedes the older row instead of offering both", async () => {
    const chOld = own({ shape: "channel", id: "ch-a-old", calls: llm("model/alpha") }, 3)
    const chNew = own({ shape: "channel", id: "ch-a-new", calls: llm("model/alpha", { max_tokens: 16384 }) }, 8)
    const chB = own({ shape: "channel", id: "ch-b", calls: llm("model/beta") }, 4)
    expect(await produceIds([root, schema, chOld, chB, chNew])).toEqual(["produce/answer/ch-a-new", "produce/answer/ch-b"])
    expect(await produceIds([root, schema, chNew, chOld])).toEqual(["produce/answer/ch-a-new"])
  })

  test("[GUARD] a newer active row after a retired row re-enables the channel under the newest id", async () => {
    const ch1 = own({ shape: "channel", id: "ch-a-1", calls: llm("model/alpha") }, 3)
    const chRet = own({ shape: "channel", id: "ch-a-ret", calls: llm("model/alpha"), retired: true }, 6)
    const ch2 = own({ shape: "channel", id: "ch-a-2", calls: llm("model/alpha", { max_tokens: 16384 }) }, 9)
    expect(await produceIds([root, schema, ch1, chRet, ch2])).toEqual(["produce/answer/ch-a-2"])
  })

  test("[MUST-FAIL] channels without pointer.model key by calls and honour retirement", async () => {
    const callsA = [{ pointer: { type: "custom_channel", tag: "a" } }]
    const callsB = [{ pointer: { type: "custom_channel", tag: "b" } }]
    const chA = own({ shape: "channel", id: "ch-raw-a", calls: callsA }, 3)
    const chB = own({ shape: "channel", id: "ch-raw-b", calls: callsB }, 4)
    const retireA = own({ shape: "channel", id: "ch-raw-a-ret", calls: callsA, retired: true }, 7)
    expect(await produceIds([root, schema, chA, chB, retireA])).toEqual(["produce/answer/ch-raw-b"])

    // empty calls without role (legacy test shape) and empty model string both fall back cleanly to calls key
    const bare = { shape: "channel", id: "ch-bare", seq: 3, calls: [] }
    const bareRet = { shape: "channel", id: "ch-bare-ret", seq: 5, calls: [], retired: true }
    expect(await produceIds([root, schema, bare])).toEqual(["produce/answer/ch-bare"])
    expect(await produceIds([root, schema, bare, bareRet])).toEqual([])

    const emptyModelA = own({ shape: "channel", id: "ch-em-a", calls: llm("", { tag: "a" }) }, 3)
    const emptyModelB = own({ shape: "channel", id: "ch-em-b", calls: llm("", { tag: "b" }) }, 4)
    const emptyModelARet = own({ shape: "channel", id: "ch-em-a-ret", calls: llm("", { tag: "a" }), retired: true }, 6)
    expect(await produceIds([root, schema, emptyModelA, emptyModelB, emptyModelARet])).toEqual(["produce/answer/ch-em-b"])
  })
})
