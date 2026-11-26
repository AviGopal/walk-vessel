// SPDX-License-Identifier: MIT
// Bounded recursive runtime sub-activity invocation (MAX_RUN_DEPTH = 4):
// - Nested activity_template steps validate recursively (leaf existence, requires, declared inputs,
//   unbound placeholders, cycle and max-depth guards) without requiring discovery to advertise
//   activity_template itself.
// - onRoute propagates through nested child calls.
// - runRunner executes nested templates recursively, chaining outputs via calls.<i>.output.*,
//   recording started/ended hops with pointer_type: "activity_template" and template_ref,
//   aborting cleanly on child failure without ended hops, and guarding runtime max_depth.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })

describe("nested activity_template applicability and execution", () => {
  const realFetch = globalThis.fetch
  const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
  const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))

  beforeAll(() => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test",
      WALK_PORT: "1",
      DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test",
      METABOB_API_KEY: "node-key-for-test",
    })
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    const { forgetDeclaredInputs } = await import("../src/calls")
    forgetDeclaredInputs()
    for (const k of keys) {
      if (was[k] === undefined) delete process.env[k]
      else process.env[k] = was[k]
    }
  })

  const SERVED = new Set(["git_worktree", "fs_read", "git_diff", "git_land", "uiView_write"])
  const DECLARED_INPUTS: Record<string, unknown> = {
    git_worktree: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
    fs_read: { type: "object", properties: { cwd: { type: "string" }, path: { type: "string" } }, required: ["cwd", "path"] },
    git_diff: { type: "object", properties: { cwd: { type: "string" } }, required: ["cwd"] },
    git_land: { type: "object", properties: { cwd: { type: "string" } }, required: ["cwd"] },
    uiView_write: { type: "object", properties: { region: { type: "string" } }, required: ["region"] },
  }

  const installMockFetch = (handlers: Record<string, (pointer: Record<string, any>) => Response | Promise<Response>> = {}) => {
    const written: Array<Record<string, any>> = []
    const called: Array<Record<string, any>> = []
    let seq = 100
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      if (pointer.type === "record_write") {
        const row = { ...pointer.row, id: `row-${++seq}`, seq }
        written.push(row)
        return Response.json(row)
      }
      if (pointer.type === "vesselCapability") {
        const shape = String(pointer.shape)
        // Crucially, activity_template is NEVER advertised on discovery!
        return Response.json({ content: { vessels: SERVED.has(shape) ? [{ vesselId: "tools" }] : [] } })
      }
      if (pointer.type === "shapeDescriptions") {
        return Response.json({
          shape_answers: { git_diff: "gitDiff", git_land: "gitLandResult", git_worktree: "gitWorktree" },
          shape_inputs: DECLARED_INPUTS,
        })
      }
      called.push(pointer)
      const fn = handlers[String(pointer.type)]
      if (fn) return fn(pointer)
      return Response.json({ ok: true })
    }) as typeof fetch
    return { written, called }
  }

  test("[MUST-FAIL] 2-level nested activity_template chains child output into parent downstream call and records template hops", async () => {
    const mock = installMockFetch({
      git_worktree: (p) => Response.json({ cwd: `/tmp/wt-${String(p.repo)}`, repo: p.repo }),
      git_diff: (p) => Response.json({ diff: `diff-of-${String(p.cwd)}`, cwd: p.cwd }),
    })
    const { applicable } = await import("../src/applicable")
    const { execute, shapeAnswers } = await import("../src/calls")
    await shapeAnswers()

    const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person", what: "check diff" }
    const child = {
      shape: "activity_template", id: "t-child", seq: 2, role: "described",
      sig: { in: [], out: ["gitWorktree"] },
      calls: [{ shape: "git_worktree", pointer: { repo: "substrate" } }],
    }
    const parent = {
      shape: "activity_template", id: "t-parent", seq: 3, role: "described",
      sig: { in: ["world_changed"], out: ["gitDiff"] },
      calls: [
        { shape: "activity_template", pointer: { template_ref: "t-child" } },
        { shape: "git_diff", pointer: { cwd: "{{ calls.0.output.cwd }}" } },
      ],
    }

    const skipped: any[] = []
    const cands = await applicable([ask, child, parent], skipped, Date.now(), { root: "w1" })
    const parentCand = cands.find((c) => c.id === "run/t-parent")
    expect(parentCand).toBeDefined()
    expect(skipped.filter((s) => s.id === "t-parent")).toEqual([])

    await execute(parentCand!, { shape: "selection", id: "sel-2lvl", seq: 50, root: "w1" }, ["w1"])

    expect(mock.called.map((p) => p.type)).toEqual(["git_worktree", "git_diff"])
    expect(mock.called[1].cwd).toBe("/tmp/wt-substrate")

    const tplHops = mock.written.filter((r) => r.shape === "hop" && r.pointer_type === "activity_template")
    expect(tplHops.length).toBe(2)
    expect(tplHops[0]).toMatchObject({ phase: "started", kind: "run", pointer_type: "activity_template", template_ref: "t-child", selection_ref: "sel-2lvl" })
    expect(tplHops[1]).toMatchObject({
      phase: "ended", kind: "run", pointer_type: "activity_template", template_ref: "t-child",
      selection_ref: "sel-2lvl", call_id: tplHops[0].call_id,
      output: { cwd: "/tmp/wt-substrate", repo: "substrate" },
    })
    expect(mock.written.filter((r) => r.shape === "failure")).toEqual([])
  })

  test("[MUST-FAIL] 3-level nested activity_template chains outputs across grandchild -> child -> parent", async () => {
    const mock = installMockFetch({
      git_worktree: () => Response.json({ cwd: "/tmp/wt-3lvl" }),
      fs_read: (p) => Response.json({ cwd: p.cwd, path: p.path, text: "hello" }),
      git_diff: (p) => Response.json({ diff: `diff:${String(p.cwd)}` }),
    })
    const { applicable } = await import("../src/applicable")
    const { execute, shapeAnswers } = await import("../src/calls")
    await shapeAnswers()

    const ask = { shape: "world_changed", id: "w3", seq: 1, role: "person", what: "3-level" }
    const leaf = {
      shape: "activity_template", id: "t-leaf", seq: 2, role: "described",
      sig: { in: [], out: ["gitWorktree"] },
      calls: [{ shape: "git_worktree", pointer: { repo: "walk" } }],
    }
    const mid = {
      shape: "activity_template", id: "t-mid", seq: 3, role: "described",
      sig: { in: [], out: ["fileContent"] },
      calls: [
        { shape: "activity_template", pointer: { template_ref: "t-leaf" } },
        { shape: "fs_read", pointer: { cwd: "{{ calls.0.output.cwd }}", path: "src/index.ts" } },
      ],
    }
    const top = {
      shape: "activity_template", id: "t-top", seq: 4, role: "described",
      sig: { in: ["world_changed"], out: ["gitDiff"] },
      calls: [
        { shape: "activity_template", pointer: { template_ref: "t-mid" } },
        { shape: "git_diff", pointer: { cwd: "{{ calls.0.output.cwd }}" } },
      ],
    }

    const skipped: any[] = []
    const cands = await applicable([ask, leaf, mid, top], skipped, Date.now(), { root: "w3" })
    const topCand = cands.find((c) => c.id === "run/t-top")
    expect(topCand).toBeDefined()

    await execute(topCand!, { shape: "selection", id: "sel-3lvl", seq: 60, root: "w3" }, ["w3"])

    expect(mock.called.map((p) => p.type)).toEqual(["git_worktree", "fs_read", "git_diff"])
    expect(mock.called[1]).toMatchObject({ cwd: "/tmp/wt-3lvl", path: "src/index.ts" })
    expect(mock.called[2]).toMatchObject({ cwd: "/tmp/wt-3lvl" })

    const tplHops = mock.written.filter((r) => r.shape === "hop" && r.pointer_type === "activity_template")
    expect(tplHops.map((h) => [h.phase, h.template_ref])).toEqual([
      ["started", "t-mid"],
      ["started", "t-leaf"],
      ["ended", "t-leaf"],
      ["ended", "t-mid"],
    ])
    expect(mock.written.filter((r) => r.shape === "failure")).toEqual([])
  })

  test("[MUST-FAIL] cycle and depth > 4 are skipped at applicability, and runtime max_depth writes failure without infinite recursion", async () => {
    const mock = installMockFetch()
    const { applicable } = await import("../src/applicable")
    const { execute, forgetDeclaredInputs } = await import("../src/calls")
    forgetDeclaredInputs()

    const ask = { shape: "world_changed", id: "wc", seq: 1, role: "person", what: "guards" }
    // Mutual cycle: t-cyc-a <-> t-cyc-b
    const cycA = {
      shape: "activity_template", id: "t-cyc-a", seq: 2, role: "described",
      sig: { in: ["world_changed"], out: ["x"] },
      calls: [{ shape: "activity_template", pointer: { template_ref: "t-cyc-b" } }],
    }
    const cycB = {
      shape: "activity_template", id: "t-cyc-b", seq: 3, role: "described",
      sig: { in: ["world_changed"], out: ["x"] },
      calls: [{ shape: "activity_template", pointer: { template_ref: "t-cyc-a" } }],
    }
    // Self cycle: t-self -> t-self
    const selfCyc = {
      shape: "activity_template", id: "t-self", seq: 4, role: "described",
      sig: { in: ["world_changed"], out: ["x"] },
      calls: [{ shape: "activity_template", pointer: { template_ref: "t-self" } }],
    }
    // Depth chain: d0 -> d1 -> d2 -> d3 -> d4 -> d5 (5 nested hops, exceeds MAX_RUN_DEPTH=4)
    // While d1 -> d2 -> d3 -> d4 -> d5 is 4 nested hops (allowed at boundary!)
    const d5 = {
      shape: "activity_template", id: "t-d5", seq: 5, role: "described",
      sig: { in: [], out: ["gitDiff"] },
      calls: [{ shape: "git_diff", pointer: { cwd: "/c" } }],
    }
    const d4 = {
      shape: "activity_template", id: "t-d4", seq: 6, role: "described",
      sig: { in: [], out: ["gitDiff"] },
      calls: [{ shape: "activity_template", pointer: { template_ref: "t-d5" } }],
    }
    const d3 = {
      shape: "activity_template", id: "t-d3", seq: 7, role: "described",
      sig: { in: [], out: ["gitDiff"] },
      calls: [{ shape: "activity_template", pointer: { template_ref: "t-d4" } }],
    }
    const d2 = {
      shape: "activity_template", id: "t-d2", seq: 8, role: "described",
      sig: { in: [], out: ["gitDiff"] },
      calls: [{ shape: "activity_template", pointer: { template_ref: "t-d3" } }],
    }
    const d1 = {
      shape: "activity_template", id: "t-d1", seq: 9, role: "described",
      sig: { in: ["world_changed"], out: ["gitDiff"] },
      calls: [{ shape: "activity_template", pointer: { template_ref: "t-d2" } }],
    }
    const d0 = {
      shape: "activity_template", id: "t-d0", seq: 10, role: "described",
      sig: { in: ["world_changed"], out: ["gitDiff"] },
      calls: [{ shape: "activity_template", pointer: { template_ref: "t-d1" } }],
    }

    const skipped: any[] = []
    const cands = await applicable([ask, cycA, cycB, selfCyc, d5, d4, d3, d2, d1, d0], skipped, Date.now(), { root: "wc" })
    const offered = new Set(cands.filter((c) => c.kind === "run").map((c) => c.id))
    expect(offered.has("run/t-cyc-a")).toBe(false)
    expect(offered.has("run/t-cyc-b")).toBe(false)
    expect(offered.has("run/t-self")).toBe(false)
    expect(offered.has("run/t-d0")).toBe(false)
    // Boundary: 4 nested template hops (d1 -> d2 -> d3 -> d4 -> d5) IS allowed
    expect(offered.has("run/t-d1")).toBe(true)

    for (const id of ["t-cyc-a", "t-cyc-b", "t-self", "t-d0"]) {
      const sk = skipped.find((s) => s.id === id)
      expect(sk).toBeDefined()
      expect(sk.unserved).toContain("activity_template (invalid, cyclic, or max-depth template_ref)")
    }

    // Runtime max_depth guard: invoke execute directly with a cyclic Cand.children bypassing applicable()
    const cyclicCand: any = {
      id: "run/t-loop",
      kind: "run",
      pointer: {},
      t: "",
      calls: [{ shape: "activity_template", pointer: { template_ref: "t-loop" } }],
      children: {
        "t-loop": { calls: [{ shape: "activity_template", pointer: { template_ref: "t-loop" } }] },
      },
    }
    await execute(cyclicCand, { shape: "selection", id: "sel-cyc", seq: 70, root: "wc" }, ["wc"])
    const maxDepthFail = mock.written.find((r) => r.shape === "failure" && r.kind === "max_depth")
    expect(maxDepthFail).toBeDefined()
    expect(maxDepthFail).toMatchObject({ kind: "max_depth", selection_ref: "sel-cyc", template_ref: "t-loop" })
    // No ended hops were written since the recursion aborted at max_depth
    expect(mock.written.filter((r) => r.shape === "hop" && r.phase === "ended")).toEqual([])
  })

  test("[MUST-FAIL] onRoute propagates through nested child calls on a routed root", async () => {
    installMockFetch()
    const { applicable } = await import("../src/applicable")
    const { forgetDeclaredInputs } = await import("../src/calls")
    forgetDeclaredInputs()

    const gap = { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "G1", status: "open" }
    const routedOwners = [
      own({ shape: "credits", id: "cr1", target: "gap", by_call: "git_land" }, -5),
      own({ shape: "requires", id: "rq1", for: "git_land", needs: "gitDiff" }, -4),
    ]
    const answers = { git_diff: "gitDiff", git_land: "gitLandResult" }

    const childOnRoute = {
      shape: "activity_template", id: "t-child-diff", seq: 2, role: "described",
      sig: { in: [], out: ["gitDiff"] },
      calls: [{ shape: "git_diff", pointer: { cwd: "/c" } }],
    }
    const parentOnRoute = {
      shape: "activity_template", id: "t-parent-diff", seq: 3, role: "described",
      sig: { in: ["gap"], out: ["gitDiff"] },
      calls: [{ shape: "activity_template", pointer: { template_ref: "t-child-diff" } }],
    }
    const childOffRoute = {
      shape: "activity_template", id: "t-child-ui", seq: 4, role: "described",
      sig: { in: [], out: ["uiViewState"] },
      calls: [{ shape: "uiView_write", pointer: { region: "landing" } }],
    }
    const parentOffRoute = {
      shape: "activity_template", id: "t-parent-ui", seq: 5, role: "described",
      sig: { in: ["gap"], out: ["uiViewState"] },
      calls: [{ shape: "activity_template", pointer: { template_ref: "t-child-ui" } }],
    }

    const note: Record<string, unknown> = { root: "g1" }
    const cands = await applicable(
      [...routedOwners, gap, childOnRoute, parentOnRoute, childOffRoute, parentOffRoute],
      [],
      Date.now(),
      note,
      answers,
    )
    expect(note.path).toEqual({ call: "git_land", calls: ["git_diff", "git_land"], next: ["git_diff"] })
    const runs = cands.filter((c) => c.kind === "run").map((c) => c.id).sort()
    expect(runs).toContain("run/t-parent-diff")
    expect(runs).not.toContain("run/t-parent-ui")
  })

  test("[MUST-FAIL] child step failure aborts parent execution without emitting ended hops or running downstream steps", async () => {
    const mock = installMockFetch({
      git_worktree: () => Response.json({ error: "clone failed" }, { status: 500 }),
      git_diff: () => Response.json({ diff: "should-not-run" }),
    })
    const { applicable } = await import("../src/applicable")
    const { execute, forgetDeclaredInputs } = await import("../src/calls")
    forgetDeclaredInputs()

    const ask = { shape: "world_changed", id: "wf", seq: 1, role: "person", what: "fail child" }
    const child = {
      shape: "activity_template", id: "t-fail-child", seq: 2, role: "described",
      sig: { in: [], out: ["gitWorktree"] },
      calls: [{ shape: "git_worktree", pointer: { repo: "broken" } }],
    }
    const parent = {
      shape: "activity_template", id: "t-fail-parent", seq: 3, role: "described",
      sig: { in: ["world_changed"], out: ["gitDiff"] },
      calls: [
        { shape: "activity_template", pointer: { template_ref: "t-fail-child" } },
        { shape: "git_diff", pointer: { cwd: "{{ calls.0.output.cwd }}" } },
      ],
    }

    const cands = await applicable([ask, child, parent], [], Date.now(), { root: "wf" })
    const parentCand = cands.find((c) => c.id === "run/t-fail-parent")
    expect(parentCand).toBeDefined()

    await execute(parentCand!, { shape: "selection", id: "sel-fail", seq: 80, root: "wf" }, ["wf"])

    // Downstream git_diff must NOT have been called
    expect(mock.called.map((p) => p.type)).toEqual(["git_worktree"])
    // Child activity_template hop started, but NO ended hop emitted
    const tplHops = mock.written.filter((r) => r.shape === "hop" && r.pointer_type === "activity_template")
    expect(tplHops.map((h) => [h.phase, h.template_ref])).toEqual([["started", "t-fail-child"]])
    expect(mock.written.filter((r) => r.shape === "hop" && r.phase === "ended")).toEqual([])
    expect(mock.written.filter((r) => r.shape === "failure").length).toBe(1)
  })

  test("[GUARD] child sig.in unbound check skips missing inputs unless parent supplies explicit pointer.inputs override", async () => {
    const mock = installMockFetch({
      git_worktree: () => Response.json({ cwd: "/tmp/wt-override" }),
      git_diff: (p) => Response.json({ diff: `ok:${String(p.cwd)}` }),
    })
    const { applicable } = await import("../src/applicable")
    const { execute, forgetDeclaredInputs } = await import("../src/calls")
    forgetDeclaredInputs()

    const ask = { shape: "world_changed", id: "wu", seq: 1, role: "person", what: "unbound check" }
    const childNeedsWt = {
      shape: "activity_template", id: "t-child-wt", seq: 2, role: "described",
      sig: { in: ["gitWorktree"], out: ["gitDiff"] },
      calls: [{ shape: "git_diff", pointer: { cwd: "{{ sig.in[0].cwd }}" } }],
    }
    const parentNoOverride = {
      shape: "activity_template", id: "t-parent-unbound", seq: 3, role: "described",
      sig: { in: ["world_changed"], out: ["gitDiff"] },
      calls: [{ shape: "activity_template", pointer: { template_ref: "t-child-wt" } }],
    }
    const parentWithOverride = {
      shape: "activity_template", id: "t-parent-override", seq: 4, role: "described",
      sig: { in: ["world_changed"], out: ["gitDiff"] },
      calls: [
        { shape: "git_worktree", pointer: { repo: "substrate" } },
        { shape: "activity_template", pointer: { template_ref: "t-child-wt", inputs: [{ id: "wt-inline", cwd: "{{ calls.0.output.cwd }}" }] } },
      ],
    }

    const skipped: any[] = []
    const cands = await applicable([ask, childNeedsWt, parentNoOverride, parentWithOverride], skipped, Date.now(), { root: "wu" })
    expect(cands.find((c) => c.id === "run/t-parent-unbound")).toBeUndefined()
    expect(skipped.find((s) => s.id === "t-parent-unbound")?.unbound).toContain("sig.in[0].cwd")

    const overrideCand = cands.find((c) => c.id === "run/t-parent-override")
    expect(overrideCand).toBeDefined()
    await execute(overrideCand!, { shape: "selection", id: "sel-ov", seq: 90, root: "wu" }, ["wu"])
    expect(mock.called.map((p) => p.type)).toEqual(["git_worktree", "git_diff"])
    expect(mock.called[1].cwd).toBe("/tmp/wt-override")
  })
})
