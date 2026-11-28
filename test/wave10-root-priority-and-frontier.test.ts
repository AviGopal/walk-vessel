// SPDX-License-Identifier: MIT
// Wave 10D invariants in walk-vessel (D2–D4):
//   1. `rootPriorityWeight` & `choose` favor high-posterior, high-demand, near-landing, and `person` roots over
//      0W/15L failing detector gaps while keeping all roots strictly > 0 and preserving 3/4-arg `choose` parity.
//   2. Continuity lease (`sliceHopsOf` + `nextLeaseState`) holds leased root across `slice_hops` and preempts on new person / overdue / no non-wait move.
//   3. `change_wanted { wanted: false }` on a `gap` root suppresses `git_land` route so operational tools stay off `off_path`.
//   4. Unscheduled shared templates require `sig.out` route match and suppress shared off-route / unmet-precondition skip flooding.
//   5. `projectTraceTemplate` parameterizes `/walk-trees/` `cwd` and `tree` into `{{ calls.k.output.<field> }}` on `request_acts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const NODE_KEY = "node-key-for-test"

describe("Wave 10D — root priority, lease continuity, operational gaps, sig.out routing & trace projection", () => {
  const realFetch = globalThis.fetch
  const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
  const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))

  afterAll(() => {
    globalThis.fetch = realFetch
    for (const k of keys) {
      if (was[k] === undefined) delete process.env[k]
      else process.env[k] = was[k]
    }
  })

  beforeAll(() => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test",
      WALK_PORT: "1",
      DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test",
      METABOB_API_KEY: NODE_KEY,
    })
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, unknown> }
      if (pointer.type === "vessel_capability") {
        return Response.json({ content: { vessels: [{ vesselId: "tools", endpoint: "http://tools.test" }] } })
      }
      return Response.json({ content: { vessels: [{ vesselId: "v", endpoint: "http://v.test" }] } })
    }) as typeof fetch
  })

  test("[MUST-FAIL] choose prioritizes person and fertile near-landing roots over 0W/15L failing detector gaps while preserving 4-arg parity", async () => {
    const { choose, rootPriorityWeight } = await import("../src/loop")
    const options = [
      { root: "gap-loser", cand: { id: "produce/request/gap" } },
      { root: "gap-near", cand: { id: "call/git_land" } },
      { root: "ask-person", cand: { id: "call/fs_read" } },
    ]
    const movePosts = [
      { alpha: 1, beta: 16 },
      { alpha: 8, beta: 2 },
      { alpha: 4, beta: 2 },
    ]
    // 4-arg parity untouched
    const bareShares = { loser: 0, near: 0, person: 0 }
    for (let s = 1; s <= 300; s++) {
      const idx = choose(s, options, movePosts, 1)
      if (options[idx].root === "gap-loser") bareShares.loser++
      else if (options[idx].root === "gap-near") bareShares.near++
      else bareShares.person++
    }
    expect(Math.abs(bareShares.loser - bareShares.person)).toBeLessThan(60)

    const rootPosts = new Map([
      ["gap-loser", { alpha: 1, beta: 16 }],
      ["gap-near", { alpha: 8, beta: 2 }],
      ["ask-person", { alpha: 3, beta: 1 }],
    ])
    const rootMetas = new Map([
      ["gap-loser", { role: "detector", demandCount: 0, remSteps: 4 }],
      ["gap-near", { role: "detector", demandCount: 5, remSteps: 0 }],
      ["ask-person", { role: "person", demandCount: 1, remSteps: 1 }],
    ])
    expect(rootPriorityWeight(options, movePosts, "gap-loser", 1, rootPosts, rootMetas)).toBeGreaterThan(0)

    let loserDraws = 0
    for (let s = 1; s <= 2000; s++) {
      const idx = choose(s, options, movePosts, 1, rootPosts, rootMetas)
      if (options[idx].root === "gap-loser") loserDraws++
    }
    expect(loserDraws).toBeGreaterThan(0)
    expect(loserDraws).toBeLessThan(80)
  })

  test("[MUST-FAIL] sliceHopsOf & nextLeaseState hold continuity and preempt on new person root, overdue deadline, or non-move", async () => {
    const { choose, nextLeaseState, sliceHopsOf } = await import("../src/loop")
    expect(sliceHopsOf([{ shape: "stall_rule", role: "owner", seq: 5, slice_hops: 8 } as any])).toBe(8)
    expect(sliceHopsOf([])).toBe(1)

    const now = 1_000_000
    const roots = [
      { root: { id: "g1", seq: 10, role: "detector" } as any, rows: [], dues: [now + 60_000] },
      { root: { id: "g2", seq: 11, role: "detector" } as any, rows: [], dues: [] },
    ]
    const options = [
      { root: "g1", cand: { id: "call/fs_read", kind: "call" } as any, pool: [], context: [], cell: "c1", skipped: [] },
      { root: "g2", cand: { id: "call/fs_read", kind: "call" } as any, pool: [], context: [], cell: "c2", skipped: [] },
    ]
    const posts = [{ alpha: 1, beta: 1 }, { alpha: 1, beta: 1 }]
    const hold = nextLeaseState({ root: "g1", remaining: 5, seenPersonMaxSeq: 0 }, roots, options, 8, now)
    expect(hold.activeLease).toBe("g1")
    for (let s = 1; s <= 50; s++) {
      expect(choose(s, options, posts, 1, undefined, undefined, hold.activeLease)).toBe(0)
    }

    // Preempt on new person root
    const withPerson = [...roots, { root: { id: "p1", seq: 12, role: "person" } as any, rows: [], dues: [] }]
    expect(nextLeaseState({ root: "g1", remaining: 5, seenPersonMaxSeq: 0 }, withPerson, options, 8, now).activeLease).toBeUndefined()
    // Preempt on overdue deadline
    const overdue = [{ root: { id: "g1", seq: 10, role: "detector" } as any, rows: [], dues: [now - 1] }]
    expect(nextLeaseState({ root: "g1", remaining: 5, seenPersonMaxSeq: 0 }, overdue, options, 8, now).activeLease).toBeUndefined()
  })

  test("[MUST-FAIL] wanted: false on gap root clears git_land route so operational tools are not marked off_path", async () => {
    const { applicable } = await import("../src/applicable")
    const gap = { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "wf-1", status: "open" }
    const credit = { shape: "credits", id: "cr1", seq: 2, role: "owner", target: "gap", by_call: "git_land" }
    const reqLand = { shape: "requires", id: "rq1", seq: 3, role: "owner", for: "git_land", needs: "gap", where: { status: "open" }, latest_by: "gap_id" }
    const reclaimReq = { shape: "requires", id: "rq2", seq: 4, role: "owner", for: "walk_trees_reclaim", needs: "gap", where: { status: "open" }, latest_by: "gap_id" }
    const askReclaim = { shape: "request", id: "req-op", seq: 5, role: "described", pointer: { type: "walk_trees_reclaim" } }
    const cwFalse = { shape: "change_wanted", id: "cw1", seq: 6, role: "described", wanted: false, repo: null, why: "operational cleanup", root: "g1", input_refs: ["g1"] }

    const noteBefore: any = { root: "g1", shared: new Set(["cr1", "rq1", "rq2"]) }
    const beforeCands = await applicable([gap, credit, reqLand, reclaimReq, askReclaim] as any, [], Date.now(), noteBefore)
    expect(beforeCands.find((c) => c.id === "call/walk_trees_reclaim")?.off_path).toBe(true)

    const note: any = { root: "g1", shared: new Set(["cr1", "rq1", "rq2"]) }
    const cands = await applicable([gap, credit, reqLand, reclaimReq, askReclaim, cwFalse] as any, [], Date.now(), note, { walk_trees_reclaim: "reclaimResult" })
    const reclaim = cands.find((c) => c.id === "call/walk_trees_reclaim")
    expect(reclaim).toBeDefined()
    expect(reclaim?.off_path).toBeUndefined()
    expect(note.path).toBeUndefined()
  })

  test("[MUST-FAIL] unscheduled shared templates filter by sig.out and suppress off-route / unmet-gate skip noise", async () => {
    const { applicable } = await import("../src/applicable")
    const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person" }
    const sch = { shape: "shape_schema", id: "s1", seq: 2, role: "owner", target: "answer", inputs: ["world_changed"] }
    const credit = { shape: "credits", id: "cr1", seq: 3, role: "owner", target: "world_changed", by_call: "git_land" }
    const reqLand = { shape: "requires", id: "rq1", seq: 4, role: "owner", for: "git_land", needs: "gitDiff" }
    const reqDiff = { shape: "requires", id: "rq2", seq: 5, role: "owner", for: "git_diff", needs: "world_changed" }
    const reqCommit = { shape: "requires", id: "rq3", seq: 6, role: "owner", for: "git_commit", needs: "change_wanted" }
    const offSigOutTpl = {
      shape: "activity_template", id: "t-off-sig", seq: 7, role: "described",
      sig: { in: ["world_changed"], out: ["walkFailureReport"] },
      calls: [{ shape: "git_diff", pointer: { tree: "main" } }],
    }
    const unmetGateTpl = {
      shape: "activity_template", id: "t-unmet-gate", seq: 8, role: "described",
      sig: { in: ["world_changed"], out: ["gitDiff"] },
      calls: [{ shape: "git_commit", pointer: {} }, { shape: "git_diff", pointer: { tree: "main" } }],
    }
    const matchingTpl = {
      shape: "activity_template", id: "t-good", seq: 9, role: "described",
      sig: { in: ["world_changed"], out: ["gitDiff"] },
      calls: [{ shape: "git_diff", pointer: { tree: "main" } }],
    }
    const skipped: any[] = []
    const cands = await applicable(
      [ask, sch, credit, reqLand, reqDiff, reqCommit, offSigOutTpl, unmetGateTpl, matchingTpl] as any,
      skipped,
      Date.now(),
      { root: "w1", shared: new Set(["s1", "cr1", "rq1", "rq2", "rq3", "t-off-sig", "t-unmet-gate", "t-good"]) },
      { git_diff: "gitDiff", git_commit: "gitCommitResult", git_land: "gitLandResult" },
    )
    expect(cands.map((c) => c.id)).toContain("run/t-good")
    expect(cands.map((c) => c.id)).not.toContain("run/t-off-sig")
    expect(skipped.some((s) => s.id === "t-off-sig" || s.id === "t-unmet-gate")).toBe(false)
  })

  test("[MUST-FAIL] projectTraceTemplate parameterizes real production CALL hops via sel.from request.pointer and rejects unparameterizable /walk-trees/", async () => {
    const { actsOf, projectTraceTemplate } = await import("../src/acts")
    // Production callRunner writes STARTED CALL hops WITHOUT h.args; pointer lives on sel.from -> request.pointer
    const pool = [
      { shape: "gap", id: "g1", seq: 1, role: "detector", repo: "walk-vessel" },
      { shape: "request", id: "req1", seq: 2, role: "described", pointer: { type: "git_worktree", repo: "walk-vessel" } },
      { shape: "selection", id: "s1", seq: 3, role: "walk", root: "g1", from: "req1", a: "call/git_worktree" },
      { shape: "hop", id: "h1s", seq: 4, role: "walk", phase: "started", kind: "call", call_id: "c1", selection_ref: "s1", pointer_type: "git_worktree" },
      { shape: "gitWorktree", id: "wt1", seq: 5, role: "walk", call_id: "c1", cwd: "/var/lib/substrate/walk-trees/wt-123", repo: "walk-vessel" },
      { shape: "hop", id: "h1e", seq: 6, role: "walk", phase: "ended", kind: "call", call_id: "c1", selection_ref: "s1", output: { cwd: "/var/lib/substrate/walk-trees/wt-123" } },
      { shape: "request", id: "req2", seq: 7, role: "described", pointer: { type: "fs_edit", path: "/var/lib/substrate/walk-trees/wt-123/src/loop.ts" } },
      { shape: "selection", id: "s2", seq: 8, role: "walk", root: "g1", from: "req2", a: "call/fs_edit" },
      { shape: "hop", id: "h2s", seq: 9, role: "walk", phase: "started", kind: "call", call_id: "c2", selection_ref: "s2", pointer_type: "fs_edit" },
      { shape: "fileEditResult", id: "fe1", seq: 10, role: "walk", call_id: "c2", cwd: "/var/lib/substrate/walk-trees/wt-123", path: "src/loop.ts" },
      { shape: "hop", id: "h2e", seq: 11, role: "walk", phase: "ended", kind: "call", call_id: "c2", selection_ref: "s2", output: { path: "src/loop.ts" } },
    ]
    const proj = projectTraceTemplate(pool as any, "g1")
    expect(proj).toEqual({
      sig: { in: ["gap"], out: ["gitWorktree", "fileEditResult"] },
      calls: [
        { shape: "git_worktree", pointer: { repo: "{{ sig.in[0].repo }}" } },
        { shape: "fs_edit", pointer: { path: "{{ calls.0.output.cwd }}/src/loop.ts" } },
      ],
    })
    expect(actsOf(pool as any, "g1").trace_projection).toEqual(proj)

    // Unparameterizable /walk-trees/ path from another clone refuses to project
    const badPool = [
      ...pool.slice(0, 6),
      { shape: "request", id: "req-bad", seq: 7, role: "described", pointer: { type: "fs_edit", path: "/var/lib/substrate/walk-trees/wt-OTHER/src/loop.ts" } },
      ...pool.slice(7),
    ].map((r) => (r.id === "s2" ? { ...r, from: "req-bad" } : r))
    expect(projectTraceTemplate(badPool as any, "g1")).toBeUndefined()
  })
})
