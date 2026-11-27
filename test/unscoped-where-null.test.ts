// SPDX-License-Identifier: MIT
// In fieldMeets (and stall-news takes), where: { field: null } matches both absent (undefined) and null fields, while
// x-latest UNKNOWN (undefined boundValue) still meets nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
const ch = own({ shape: "channel", id: "ch1", calls: [] }, 1)

describe("where: { field: null } matches absent or null fields", () => {
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

  const offered = async (pool: any[], target: string, root: string): Promise<boolean> => {
    const { applicable } = await import("../src/applicable")
    return (await applicable(pool, [], Date.now(), { root })).some((c) => c.id === `produce/${target}/ch1`)
  }

  const unscopedSchema = own({
    shape: "shape_schema", id: "s-unscoped", target: "triage_note",
    inputs: [{ shape: "gap", latest_by: "gap_id", where: { status: "open", repo: null } }],
  }, 2)

  test("[MUST-FAIL] inputs where { status: open, repo: null } matches a latest gap row with omitted repo (undefined) and with repo: null", async () => {
    const gapOmitted = { shape: "gap", id: "g1", seq: 3, role: "detector", gap_id: "wf-1", category: "walk_failure", status: "open" }
    expect(await offered([ch, unscopedSchema, gapOmitted], "triage_note", "g1")).toBe(true)

    const gapNull = { shape: "gap", id: "g2", seq: 3, role: "detector", gap_id: "sc-1", category: "self_check", status: "open", repo: null }
    expect(await offered([ch, unscopedSchema, gapNull], "triage_note", "g2")).toBe(true)
  })

  test("[GUARD] not offered when latest gap row has a non-null repo or status closed (even if an older row was open without repo)", async () => {
    const gapOmitted = { shape: "gap", id: "g1", seq: 3, role: "detector", gap_id: "wf-1", status: "open" }
    const gapWithRepo = { shape: "gap", id: "g2", seq: 5, role: "detector", gap_id: "wf-1", status: "open", repo: "local-tools-vessel" }
    expect(await offered([ch, unscopedSchema, gapWithRepo], "triage_note", "g2")).toBe(false)
    expect(await offered([ch, unscopedSchema, gapOmitted, gapWithRepo], "triage_note", "g2")).toBe(false)

    const gapClosed = { shape: "gap", id: "g3", seq: 6, role: "detector", gap_id: "wf-1", status: "closed" }
    expect(await offered([ch, unscopedSchema, gapOmitted, gapClosed], "triage_note", "g3")).toBe(false)
  })

  test("[GUARD] x-latest UNKNOWN (undefined bound value) still meets nothing, even when the row field is absent", async () => {
    const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "check tree" }
    const latestSchema = own({
      shape: "shape_schema", id: "s-latest", target: "verdict_note",
      inputs: [
        "world_changed",
        {
          shape: "gitDiff",
          where: { tree: { "x-latest": { shapes: ["gitWorktree", "gitCommit"], moves: ["gitWorktree", "gitCommit"], same: "cwd", field: "tree" } } },
        },
      ],
    }, 2)
    // No gitWorktree exists on w1 -> latestValue() returns undefined (UNKNOWN).
    // Even with a gitDiff row whose tree field is absent (undefined) or null, x-latest UNKNOWN must NOT match.
    const diffUndef = { shape: "gitDiff", id: "d1", seq: 4, role: "walk", call_id: "c1", input_refs: ["w1"] }
    const diffNull = { shape: "gitDiff", id: "d2", seq: 5, role: "walk", call_id: "c2", tree: null, input_refs: ["w1"] }
    expect(await offered([ask, ch, latestSchema, diffUndef, diffNull], "verdict_note", "w1")).toBe(false)
  })

  test("[MUST-FAIL] stall-news matching (takes) with where { repo: null } admits stall rows omitting repo and excludes non-matching values", async () => {
    const root = { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "wf-2", status: "open" }
    const schema = own({
      shape: "shape_schema", id: "s-req", target: "request",
      inputs: ["gap"],
      context: [{ shape: "failure", where: { kind: "stall", repo: null } }],
    }, 2)
    // Already produced once over [root]; nothing new yet -> pending (not offered again)
    const made = [
      { shape: "selection", id: "sel10", seq: 10, role: "walk", root: "g1", a: "produce/request/ch1", seen_key: "k1" },
      { shape: "hop", id: "hp11", seq: 11, role: "walk", phase: "ended", kind: "produce", selection_ref: "sel10" },
      { shape: "request", id: "q12", seq: 12, role: "described", selection_ref: "sel10", input_refs: ["g1"], pointer: { type: "fs_read" } },
    ]
    expect(await offered([root, ch, schema, ...made], "request", "g1")).toBe(false)

    // Stall row with non-matching repo -> excluded by takes(r) -> still NOT offered
    const stallScoped = { shape: "failure", id: "st20", seq: 20, role: "walk", kind: "stall", repo: "walk-vessel", input_refs: ["g1"] }
    expect(await offered([root, ch, schema, ...made, stallScoped], "request", "g1")).toBe(false)

    // Stall row omitting repo (undefined) -> admitted by takes(r) via fieldMeets -> re-offers produce/request/ch1
    const stallOmitted = { shape: "failure", id: "st21", seq: 21, role: "walk", kind: "stall", input_refs: ["g1"] }
    expect(await offered([root, ch, schema, ...made, stallOmitted], "request", "g1")).toBe(true)

    // Stall row with explicit repo: null -> also admitted
    const stallNull = { shape: "failure", id: "st22", seq: 22, role: "walk", kind: "stall", repo: null, input_refs: ["g1"] }
    expect(await offered([root, ch, schema, ...made, stallNull], "request", "g1")).toBe(true)
  })
})
