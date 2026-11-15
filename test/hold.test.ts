// SPDX-License-Identifier: MIT
// A template whose runs fail the same way over the same request state is not run again until something changes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const NODE_KEY = "test-node-key"

describe("a run failing the same way", () => {
  const realFetch = globalThis.fetch
  let applicable: (pool: any[], skipped?: any[], now?: number, note?: any) => Promise<Array<{ id: string }>>
  afterAll(() => { globalThis.fetch = realFetch })
  beforeAll(async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "tools", endpoint: "http://tools.test" }] } })) as typeof fetch
    applicable = (await import("../src/applicable")).applicable
  })
  const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person" }
  const t = { shape: "activity_template", id: "t-d", seq: 2, role: "described", sig: { in: ["world_changed"], out: ["gitDiff"] }, calls: [{ shape: "git_status", pointer: { cwd: "/x" } }] }
  const NO_COMMIT = "the clone has no commit since it was made: no change to diff"
  let seq = 10
  const run = (body: string) => {
    const sel = { shape: "selection", id: `s${++seq}`, seq, role: "walk", a: "run/t-d" }
    const f = { shape: "failure", id: `f${++seq}`, seq, role: "walk", selection_ref: sel.id, status: 422, body }
    const h = { shape: "hop", id: `h${++seq}`, seq, role: "walk", selection_ref: sel.id, phase: "started", pointer_type: "git_status" }
    return [sel, h, f]
  }
  const offered = async (rows: any[], schemaExtra: Record<string, unknown> = {}) => {
    const schema = { shape: "shape_schema", id: "sch-t", seq: 0, role: "owner", target: "activity_template", inputs: ["outcome"], ...schemaExtra }
    return (await applicable([schema, ask, t, ...rows], [], Date.now(), { root: "w1" })).map((c) => c.id).includes("run/t-d")
  }

  test("[MUST-FAIL] one failure: offered again; the same failure a second time over the same state: held", async () => {
    seq = 10
    const one = run(NO_COMMIT)
    expect(await offered(one)).toBe(true)
    expect(await offered([...one, ...run(NO_COMMIT)])).toBe(false)
  })

  test("[MUST-FAIL] a new row on the request after the repeat (a commit's result the walk recorded) offers it again", async () => {
    seq = 10
    const rows = [...run(NO_COMMIT), ...run(NO_COMMIT)]
    const commit = { shape: "gitCommitResult", id: "c1", seq: ++seq, role: "walk", writer: "walk-test", call_id: "cc", ok: true, input_refs: ["w1"] }
    expect(await offered([...rows, commit])).toBe(true)
  })

  test("[MUST-FAIL] a different body is not a repeat: offered again", async () => {
    seq = 10
    expect(await offered([...run(NO_COMMIT), ...run("old_string not found")])).toBe(true)
  })

  test("[MUST-FAIL] a producer's own rows between and after (an answer, another template) are not new state: still held", async () => {
    seq = 10
    const first = run(NO_COMMIT)
    const answer = { shape: "answer", id: "a1", seq: ++seq, role: "described", input_refs: ["w1"] }
    const second = run(NO_COMMIT)
    const tmpl = { shape: "activity_template", id: "t-z", seq: ++seq, role: "described", sig: { in: ["nothing_here"], out: [] }, calls: [] }
    expect(await offered([...first, answer, ...second, tmpl])).toBe(false)
  })

  test("[MUST-FAIL] a person's row, or a row of a shape the template takes in, between two identical failures: not a repeat", async () => {
    seq = 10
    const first = run(NO_COMMIT)
    const person = { shape: "outcome", id: "o1", seq: ++seq, role: "person", r: 0 }
    expect(await offered([...first, person, ...run(NO_COMMIT)])).toBe(true)
    seq = 10
    const f2 = run(NO_COMMIT)
    const input = { shape: "world_changed", id: "w2", seq: ++seq, role: "described" }
    expect(await offered([...f2, input, ...run(NO_COMMIT)])).toBe(true)
  })

  test("[MUST-FAIL] a 5k-row request with 40 identical failed runs is judged in well under two seconds (no scan per row)", async () => {
    seq = 10
    const runs = Array.from({ length: 40 }, () => run(NO_COMMIT)).flat()
    const noise = Array.from({ length: 5000 - runs.length }, (_, i) => ({ shape: "answer", id: `n${i}`, seq: 10_000 + i, role: "described" }))
    const t0 = performance.now()
    expect(await offered([...runs, ...noise])).toBe(false)
    expect(performance.now() - t0).toBeLessThan(2000)
  })

  test("[MUST-FAIL] the owner's retries_after_identical_failure 1 allows one more identical repeat before the hold", async () => {
    seq = 10
    const two = [...run(NO_COMMIT), ...run(NO_COMMIT)]
    expect(await offered(two, { retries_after_identical_failure: 1 })).toBe(true)
    expect(await offered([...two, ...run(NO_COMMIT)], { retries_after_identical_failure: 1 })).toBe(false)
    expect(await offered(two, { retries_after_identical_failure: 9 })).toBe(false) // out of range: as none
  })
})
