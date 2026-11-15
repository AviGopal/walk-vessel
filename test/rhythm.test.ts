// SPDX-License-Identifier: MIT
// A template the owner's rhythm names runs on its schedule: on the walk's idle root, when its rhythm is due, and never as
// part of a request's own work (the USER: "Build the schedule reader first").
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

describe("the owner's rhythm", () => {
  const served = new Set(["walk_failure_detect", "git_status"])
  const realFetch = globalThis.fetch
  let applicable: (pool: any[], skipped?: any[], now?: number, note?: any) => Promise<Array<{ id: string }>>
  afterAll(() => { globalThis.fetch = realFetch })
  beforeAll(async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
    })
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, unknown> }
      return Response.json({ content: { vessels: served.has(String(pointer.shape)) ? [{ vesselId: "tools", endpoint: "http://tools.test" }] : [] } })
    }) as typeof fetch
    applicable = (await import("../src/applicable")).applicable
  })
  const arm = { shape: "arm", id: "arm1", seq: 1, role: "owner", vessel_id: "walk-test" }
  const tpl = { shape: "activity_template", id: "t-det", seq: 2, role: "owner", sig: { in: [], out: ["gap"] }, calls: [{ shape: "walk_failure_detect", pointer: {} }] }
  const rhythm = (seq: number, every: number, extra: Record<string, unknown> = {}) => ({ shape: "rhythm", id: `rh${seq}`, seq, role: "owner", template: "t-det", every_rows: every, ...extra })
  const filler = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ shape: "hop", id: `x${from + i}`, seq: from + i, role: "walk", phase: "ended" }))
  const ids = async (pool: any[], note: any) => (await applicable(pool, [], Date.now(), note)).map((c) => c.id)
  const IDLE = { root: "arm1", awaits: false }

  test("[MUST-FAIL] a due rhythm's template is offered on the idle root; one not yet due is not", async () => {
    expect(await ids([arm, tpl, rhythm(3, 5), ...filler(4, 6)], IDLE)).toContain("run/t-det")
    expect(await ids([arm, tpl, rhythm(3, 50), ...filler(4, 6)], IDLE)).not.toContain("run/t-det")
  })

  test("[MUST-FAIL] after its run, it is not due again until every_rows more rows were written", async () => {
    const ran = { shape: "selection", id: "s-run", seq: 20, role: "walk", root: "arm1", a: "run/t-det" }
    expect(await ids([arm, tpl, rhythm(3, 5), ...filler(4, 6), ran, ...filler(21, 3)], IDLE)).not.toContain("run/t-det")
    expect(await ids([arm, tpl, rhythm(3, 5), ...filler(4, 6), ran, ...filler(21, 6)], IDLE)).toContain("run/t-det")
  })

  test("[MUST-FAIL] never offered to a request's own work, and a retired rhythm's template is never offered", async () => {
    const ask = { shape: "world_changed", id: "w1", seq: 3, role: "person" }
    expect(await ids([ask, tpl, rhythm(4, 1), ...filler(5, 6)], { root: "w1", awaits: true })).not.toContain("run/t-det")
    expect(await ids([arm, tpl, rhythm(3, 5), rhythm(4, 5, { retired: true }), ...filler(5, 9)], IDLE)).not.toContain("run/t-det")
  })

  test("a template no rhythm names is offered as before (the schedule changes nothing else)", async () => {
    const plain = { ...tpl, id: "t-plain", calls: [{ shape: "git_status", pointer: { cwd: "/x" } }] }
    expect(await ids([arm, plain, ...filler(3, 2)], IDLE)).toContain("run/t-plain")
  })
})
