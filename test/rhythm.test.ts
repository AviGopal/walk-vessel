// SPDX-License-Identifier: MIT
// A template the owner's rhythm names runs on its schedule: on the walk's idle root, when its rhythm is due, and never as
// part of a request's own work (the USER: "Build the schedule reader first").
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

describe("the owner's rhythm", () => {
  const served = new Set(["walk_failure_detect", "git_status", "retrospective", "answer"])
  const realFetch = globalThis.fetch
  let applicable: (pool: any[], skipped?: any[], now?: number, note?: any) => Promise<Array<{ id: string }>>
  let choices: (shared: any[], roots: any[], now?: number, answers?: any, arm?: any, head?: number) => Promise<Array<{ cand: { id: string } }>>
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
    choices = (await import("../src/loop")).choices
  })
  const arm = { shape: "arm", id: "arm1", seq: 1, role: "owner", vessel_id: "walk-test" }
  const tpl = { shape: "activity_template", id: "t-det", seq: 2, role: "owner", sig: { in: [], out: ["gap"] }, calls: [{ shape: "walk_failure_detect", pointer: {} }] }
  const rhythm = (seq: number, every: number, extra: Record<string, unknown> = {}) => ({ shape: "rhythm", id: `rh${seq}`, seq, role: "owner", template: "t-det", every_rows: every, ...extra })
  const ids = async (pool: any[], note: any) => (await applicable(pool, [], Date.now(), note)).map((c) => c.id)
  const IDLE = { root: "arm1", awaits: false, head: 1000 }

  // As the loop builds it (choices): the shared rows and the idle root's own rows only; seqs are the store's, gapped by
  // every other root's writing; the head is records' latest seq.
  const real = async (head: number | undefined, ran?: number) => {
    const shared = [tpl, rhythm(3, 5000)]
    const rows: any[] = [arm, ...(ran === undefined ? [] : [{ shape: "selection", id: "s-run", seq: ran, role: "walk", root: "arm1", a: "run/t-det" },
      { shape: "hop", id: "h-run", seq: 2000, role: "walk", phase: "ended", kind: "run", selection_ref: "s-run" }])]
    return (await choices(shared, [{ root: arm, rows, awaits: false }], Date.now(), {}, arm, head)).map((o) => o.cand.id)
  }

  test("[MUST-FAIL] counted against the store's head, not the idle pool: the run's own late rows don't make it due again", async () => {
    // (a) run at 20, its ended hop at 2000 (other roots wrote between), head 2000, every_rows 5000: not due
    expect(await real(2000, 20)).not.toContain("run/t-det")
  })

  test("[MUST-FAIL] rows written on other roots make it due though nothing new reaches the idle root", async () => {
    // (b) the same, head 9000, no new idle-root rows: due
    expect(await real(9000, 20)).toContain("run/t-det")
    // never run, head past every_rows after the rhythm row: due; no head known yet: not due
    expect(await real(6000)).toContain("run/t-det")
    expect(await real(undefined)).not.toContain("run/t-det")
  })

  test("[MUST-FAIL] a due rhythm's template is offered on the idle root; one not yet due is not", async () => {
    expect(await ids([arm, tpl, rhythm(3, 5)], { ...IDLE, head: 9 })).toContain("run/t-det")
    expect(await ids([arm, tpl, rhythm(3, 50)], { ...IDLE, head: 9 })).not.toContain("run/t-det")
  })

  test("[MUST-FAIL] after its run, it is not due again until every_rows more rows were written", async () => {
    const ran = { shape: "selection", id: "s-run", seq: 20, role: "walk", root: "arm1", a: "run/t-det" }
    expect(await ids([arm, tpl, rhythm(3, 5), ran], { ...IDLE, head: 23 })).not.toContain("run/t-det")
    expect(await ids([arm, tpl, rhythm(3, 5), ran], { ...IDLE, head: 26 })).toContain("run/t-det")
  })

  test("[MUST-FAIL] never offered to a request's own work, and a retired rhythm's template is never offered", async () => {
    const ask = { shape: "world_changed", id: "w1", seq: 3, role: "person" }
    expect(await ids([ask, tpl, rhythm(4, 1)], { root: "w1", awaits: true, head: 100 })).not.toContain("run/t-det")
    expect(await ids([arm, tpl, rhythm(3, 5), rhythm(4, 5, { retired: true })], { ...IDLE, head: 100 })).not.toContain("run/t-det")
  })

  // A produce the rhythm names (the USER, 11-16: a retrospective "on this one horizon"; "Yes, allow it").
  const ch = { shape: "channel", id: "ch", seq: 1, role: "owner", calls: [] }
  const retro = { shape: "shape_schema", id: "s-retro", seq: 2, role: "owner", target: "retrospective", inputs: ["arm"] }
  const pace = (seq: number, every: number, extra: Record<string, unknown> = {}) => ({ shape: "rhythm", id: `rp${seq}`, seq, role: "owner", target: "retrospective", every_rows: every, ...extra })
  const P = "produce/retrospective/ch"

  test("[MUST-FAIL] a produce a rhythm names is offered on the idle root when due, and not before", async () => {
    expect(await ids([arm, ch, retro, pace(3, 5)], { ...IDLE, head: 9 })).toContain(P)
    expect(await ids([arm, ch, retro, pace(3, 50)], { ...IDLE, head: 9 })).not.toContain(P)
  })

  test("[MUST-FAIL] a new rhythm row with no earlier produce counts from the row itself: not due before its seq + every_rows", async () => {
    const at = 900
    const note = (head: number) => ({ root: "arm1", awaits: false, head })
    expect(await ids([arm, ch, retro, pace(at, 50)], note(at + 49))).not.toContain(P)
    expect(await ids([arm, ch, retro, pace(at, 50)], note(at + 50))).toContain(P)
  })

  test("[MUST-FAIL] after its last produce, it is due again only every_rows later (store head, not the pool)", async () => {
    const made = { shape: "selection", id: "s-p", seq: 20, role: "walk", root: "arm1", a: P }
    expect(await ids([arm, ch, retro, pace(3, 5), made], { ...IDLE, head: 23 })).not.toContain(P)
    expect(await ids([arm, ch, retro, pace(3, 5), made], { ...IDLE, head: 26 })).toContain(P)
    // the selection gone from the pool but the row it made still there: counted from the row, never due on every tick
    const row = { shape: "retrospective", id: "r-made", seq: 21, role: "described", input_refs: ["arm1"] }
    expect(await ids([arm, ch, retro, pace(3, 5), row], { ...IDLE, head: 24 })).not.toContain(P)
    expect(await ids([arm, ch, retro, pace(3, 5), row], { ...IDLE, head: 27 })).toContain(P)
  })

  test("[MUST-FAIL] a paced produce is never offered on a request's own root, nor when its rhythm is retired, nor with no head", async () => {
    const ask = { shape: "world_changed", id: "w1", seq: 3, role: "person" }
    const onAsk = { ...retro, id: "s-retro2", inputs: ["world_changed"] }
    expect(await ids([ask, ch, onAsk, pace(4, 1)], { root: "w1", awaits: true, head: 100 })).not.toContain(P)
    expect(await ids([arm, ch, retro, pace(3, 5), pace(4, 5, { retired: true })], { ...IDLE, head: 100 })).not.toContain(P)
    expect(await ids([arm, ch, retro, pace(3, 5)], { root: "arm1", awaits: false })).not.toContain(P)
  })

  test("a produce no rhythm names is offered as before; a template rhythm still paces only its template", async () => {
    const answer = { shape: "shape_schema", id: "s-ans", seq: 2, role: "owner", target: "answer", inputs: ["arm"] }
    expect(await ids([arm, ch, answer, rhythm(3, 5000)], IDLE)).toContain("produce/answer/ch")
  })

  test("a template no rhythm names is offered as before (the schedule changes nothing else)", async () => {
    const plain = { ...tpl, id: "t-plain", calls: [{ shape: "git_status", pointer: { cwd: "/x" } }] }
    expect(await ids([arm, plain], IDLE)).toContain("run/t-plain")
  })
})
