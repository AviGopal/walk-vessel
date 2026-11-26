// SPDX-License-Identifier: MIT
// Unscheduled templates on a routed root are offered only when their calls touch the route (scheduled rhythm templates
// stay governed by their rhythm), and once an unscheduled template run finishes cleanly without failing, sibling
// templates making the exact same bound call sequence settle until non-walk sig.in news arrives.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })

describe("unscheduled run route-gating and sameAnswered dedup", () => {
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
    globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "tools" }] } })) as typeof fetch
  })

  const evalPool = async (pool: any[], note: Record<string, unknown>, answers: Record<string, string> = {}) => {
    const { applicable } = await import("../src/applicable")
    const skipped: any[] = []
    const cands = await applicable(pool, skipped, Date.now(), note, answers)
    return {
      runs: cands.filter((c) => c.kind === "run").map((c) => c.id).sort(),
      skipped,
      path: (note as { path?: unknown }).path,
    }
  }

  // Routed gap root: credits says gap is reached by git_land, which requires gitDiff answered by git_diff.
  const gap = { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "G1", status: "open" }
  const routedOwners = [
    own({ shape: "credits", id: "cr1", target: "gap", by_call: "git_land" }, -5),
    own({ shape: "requires", id: "rq1", for: "git_land", needs: "gitDiff" }, -4),
  ]
  const answers = { git_diff: "gitDiff", git_land: "gitLandResult" }

  test("[MUST-FAIL] on a routed root, unscheduled templates off route.calls (including sig.in: []) are not offered and not pushed to skipped", async () => {
    const offEmpty = {
      shape: "activity_template", id: "t-ui-1", seq: 2, role: "described",
      sig: { in: [], out: ["uiViewState"] },
      calls: [{ shape: "uiView_write", pointer: { region: "landing", default: true } }],
    }
    const offGap = {
      shape: "activity_template", id: "t-other", seq: 3, role: "described",
      sig: { in: ["gap"], out: ["status"] },
      calls: [{ shape: "git_status", pointer: { cwd: "/c" } }],
    }
    const res = await evalPool([...routedOwners, gap, offEmpty, offGap], { root: "g1" }, answers)
    expect(res.path).toEqual({ call: "git_land", calls: ["git_diff", "git_land"], next: ["git_diff"] })
    expect(res.runs).toEqual([])
    expect(res.skipped.filter((s) => s.id === "t-ui-1" || s.id === "t-other")).toEqual([])
  })

  test("[GUARD] on a routed root, unscheduled templates whose calls intersect route.calls remain offered", async () => {
    const onRoute = {
      shape: "activity_template", id: "t-diff", seq: 2, role: "described",
      sig: { in: ["gap"], out: ["gitDiff"] },
      calls: [{ shape: "git_diff", pointer: { cwd: "/c" } }],
    }
    const offRoute = {
      shape: "activity_template", id: "t-ui-1", seq: 3, role: "described",
      sig: { in: [], out: ["uiViewState"] },
      calls: [{ shape: "uiView_write", pointer: { region: "landing", default: true } }],
    }
    const res = await evalPool([...routedOwners, gap, onRoute, offRoute], { root: "g1" }, answers)
    expect(res.runs).toEqual(["run/t-diff"])
  })

  test("[GUARD] scheduled rhythm templates stay offered even on a routed root when their call is not in route.calls", async () => {
    const det = own({
      shape: "activity_template", id: "t-det", seq: 2,
      sig: { in: [], out: ["gap"] },
      calls: [{ shape: "walk_failure_detect", pointer: {} }],
    }, 2)
    const rhythm = own({ shape: "rhythm", id: "rh1", template: "t-det", every_rows: 5 }, 3)
    const res = await evalPool([...routedOwners, gap, det, rhythm], { root: "g1", awaits: false, head: 100 }, answers)
    expect(res.path).toEqual({ call: "git_land", calls: ["git_diff", "git_land"], next: ["git_diff"] })
    expect(res.runs).toEqual(["run/t-det"])
  })

  test("[MUST-FAIL] on an unrouted root, a completed run settles duplicate sibling templates (including reordered keys) until sig.in news arrives", async () => {
    const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "show landing" }
    // Case A: sig.in: [] duplicate templates (exact shape of the live uiView_write dilution)
    const u1 = {
      shape: "activity_template", id: "t-u1", seq: 2, role: "described",
      sig: { in: [], out: ["uiViewState"] },
      calls: [{ shape: "uiView_write", pointer: { region: "landing", default: true } }],
    }
    const u2 = {
      shape: "activity_template", id: "t-u2", seq: 3, role: "described",
      sig: { in: [], out: ["uiViewState"] },
      calls: [{ shape: "uiView_write", pointer: { default: true, region: "landing" } }],
    }
    const uOther = {
      shape: "activity_template", id: "t-u3", seq: 4, role: "described",
      sig: { in: [], out: ["uiViewState"] },
      calls: [{ shape: "uiView_write", pointer: { region: "detail", default: false } }],
    }
    const sel1 = { shape: "selection", id: "s1", seq: 10, role: "walk", root: "w1", a: "run/t-u1" }
    const hs1 = { shape: "hop", id: "hs1", seq: 11, role: "walk", phase: "started", kind: "run", selection_ref: "s1", call_id: "c1", pointer_type: "uiView_write", args: { region: "landing", default: true } }
    const he1 = { shape: "hop", id: "he1", seq: 12, role: "walk", phase: "ended", kind: "run", selection_ref: "s1", call_id: "c1", output: { ok: true } }
    // An unrelated kind: "skip" failure carrying the tick's selection_ref must not mark the run as failed
    const tickSkip = { shape: "failure", id: "sk1", seq: 13, role: "walk", kind: "skip", selection_ref: "s1", template_ref: "t-unrelated", unserved: ["other"] }
    const resEmpty = await evalPool([ask, u1, u2, uOther, sel1, hs1, he1, tickSkip], { root: "w1" })
    expect(resEmpty.path).toBeUndefined()
    expect(resEmpty.runs).toEqual(["run/t-u3"])

    // Case B: templates with sig.in: ["world_changed"] settle after a sibling completes, then reopen when non-walk sig.in news arrives
    const d1 = {
      shape: "activity_template", id: "t-d1", seq: 2, role: "described",
      sig: { in: ["world_changed"], out: ["gitDiff"] },
      calls: [{ shape: "git_diff", pointer: { cwd: "/c", base: "HEAD" } }],
    }
    const d2 = {
      shape: "activity_template", id: "t-d2", seq: 3, role: "described",
      sig: { in: ["world_changed"], out: ["gitDiff"] },
      calls: [{ shape: "git_diff", pointer: { base: "HEAD", cwd: "/c" } }],
    }
    const selD = { shape: "selection", id: "sd1", seq: 20, role: "walk", root: "w1", a: "run/t-d1" }
    const hsD = { shape: "hop", id: "hsd1", seq: 21, role: "walk", phase: "started", kind: "run", selection_ref: "sd1", call_id: "cd1", pointer_type: "git_diff", args: { cwd: "/c", base: "HEAD" } }
    const heD = { shape: "hop", id: "hed1", seq: 22, role: "walk", phase: "ended", kind: "run", selection_ref: "sd1", call_id: "cd1", output: { diff: "" } }
    expect((await evalPool([ask, d1, d2, selD, hsD, heD], { root: "w1" })).runs).toEqual([])

    // Non-walk sig.in row after the run reopens both
    const ask2 = { shape: "world_changed", id: "w2", seq: 30, role: "person", what: "try again" }
    expect((await evalPool([ask, d1, d2, selD, hsD, heD, ask2], { root: "w1" })).runs).toEqual(["run/t-d1", "run/t-d2"])
  })

  test("[GUARD] while a template run is in-flight or failed with blames: callee, sibling templates remain offered", async () => {
    const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "show landing" }
    const u1 = {
      shape: "activity_template", id: "t-u1", seq: 2, role: "described",
      sig: { in: [], out: ["uiViewState"] },
      calls: [{ shape: "uiView_write", pointer: { region: "landing", default: true } }],
    }
    const u2 = {
      shape: "activity_template", id: "t-u2", seq: 3, role: "described",
      sig: { in: [], out: ["uiViewState"] },
      calls: [{ shape: "uiView_write", pointer: { region: "landing", default: true } }],
    }
    const sel1 = { shape: "selection", id: "s1", seq: 10, role: "walk", root: "w1", a: "run/t-u1" }
    const hs1 = { shape: "hop", id: "hs1", seq: 11, role: "walk", phase: "started", kind: "run", selection_ref: "s1", call_id: "c1", pointer_type: "uiView_write", args: { region: "landing", default: true } }
    // In-flight (started without ended): u1 is held by ran(u1), sibling u2 stays offered
    expect((await evalPool([ask, u1, u2, sel1, hs1], { root: "w1" })).runs).toEqual(["run/t-u2"])

    // Failed with blames: callee: neither settled by sameRefused nor sameAnswered, both stay offered
    const calleeFail = { shape: "failure", id: "f1", seq: 12, role: "walk", selection_ref: "s1", call_id: "c1", status: 503, blames: "callee" }
    expect((await evalPool([ask, u1, u2, sel1, hs1, calleeFail], { root: "w1" })).runs).toEqual(["run/t-u1", "run/t-u2"])
  })
})
