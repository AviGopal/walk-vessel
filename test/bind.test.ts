// SPDX-License-Identifier: MIT
// A template's placeholders are filled from the run's own inputs and its earlier calls' answers (bind.ts), never sent as
// text, and a template this request cannot fill is not run, with the skip naming what is missing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { bind, inputsOf } from "../src/bind"

const NODE_KEY = "test-node-key"
const clone = (id: string, seq: number, root: string, cwd: string, writer = "walk-test") =>
  ({ shape: "gitWorktree", id, seq, writer, role: "walk", call_id: `c-${id}`, cwd, input_refs: [root] }) as any

describe("the binder", () => {
  const scope = { sig: { in: [clone("g1", 5, "w1", "/trees/r-1")] }, calls: [{ output: { cwd: "/trees/r-2", n: { k: 1 } }, call_id: "c0" }] }

  test("[MUST-FAIL] both spellings of an input's field bind, and the source row is said", () => {
    for (const v of ["{{ sig.in[0].cwd }}", "{{sig.in[0].cwd}}"]) {
      expect(bind({ cwd: v }, scope)).toEqual({ value: { cwd: "/trees/r-1" }, sources: [{ placeholder: "sig.in[0].cwd", from: "g1" }], unbound: [] })
    }
    expect(bind({ path: "{{ sig.in[0].cwd }}/src/a.ts" }, scope).value).toEqual({ path: "/trees/r-1/src/a.ts" })
  })

  test("[MUST-FAIL] an earlier call's answer binds (calls.j), and a whole placeholder keeps the value's type", () => {
    expect(bind({ cwd: "{{calls.0.output.cwd}}" }, scope)).toEqual({ value: { cwd: "/trees/r-2" }, sources: [{ placeholder: "calls.0.output.cwd", from: "c0" }], unbound: [] })
    expect(bind({ n: "{{ calls[0].output.n }}" }, scope).value).toEqual({ n: { k: 1 } })
  })

  test("[MUST-FAIL] a value with no placeholder passes as it is", () => {
    const p = { path: "src/a.ts", lines: [1, 2], nested: { x: "y" }, empty: "" }
    expect(bind(p, scope)).toEqual({ value: p, sources: [], unbound: [] })
  })

  test("[MUST-FAIL] a placeholder that does not resolve is named, and nothing else is a path: no expression, no default", () => {
    for (const p of ["sig.in[1].cwd", "sig.in[0].nope", "calls.3.output.cwd", "sig.in[0]", "sig.in[0].cwd || '/'", "sig.in[0].constructor"]) {
      expect(bind({ v: `{{ ${p} }}` }, scope).unbound).toEqual([p])
    }
  })

  test("[MUST-FAIL] any other {{ }} is text: a Go or handlebars template in an edit is sent byte-identical", () => {
    const p = { new_string: "{{ .MaxFailingTestGaps }} and {{range .Items}}{{.}}{{end}}", other: "{{ env.HOME }}", whole: "{{ repo }}" }
    expect(bind(p, scope)).toEqual({ value: p, sources: [], unbound: [] })
    expect(bind({ v: "{{ .Field }} in {{ sig.in[0].cwd }}" }, scope).value).toEqual({ v: "{{ .Field }} in /trees/r-1" })
  })
})

describe("a run's inputs", () => {
  test("[MUST-FAIL] the latest row of the shape the walk recorded for this request; never another request's, nor one the walk did not write", () => {
    const pool = [clone("g1", 5, "w1", "/a"), clone("g2", 9, "w1", "/b"), clone("g3", 12, "w2", "/other"), clone("g4", 13, "w1", "/forged", "someone-else"),
      { ...clone("g5", 14, "w1", "/no-call"), call_id: undefined }]
    expect(inputsOf(pool, "w1", ["gitWorktree"], "walk-test").map((r) => r?.id)).toEqual(["g2"])
    expect(inputsOf(pool, "w3", ["gitWorktree"], "walk-test")).toEqual([undefined])
  })
})

describe("a request with clones of two repos", () => {
  test("[MUST-FAIL] the latest is not taken by default: the template's named repo picks, and none named binds nothing", () => {
    const pool = [{ ...clone("g1", 5, "w1", "/trees/hsv"), repo: "human-surface-vessel" }, { ...clone("g2", 9, "w1", "/trees/super"), repo: "super" }]
    expect(inputsOf(pool, "w1", ["gitWorktree"], "walk-test").map((r) => r?.id)).toEqual([undefined])
    expect(inputsOf(pool, "w1", ["gitWorktree"], "walk-test", "human-surface-vessel").map((r) => r?.id)).toEqual(["g1"])
    expect(inputsOf(pool.slice(1), "w1", ["gitWorktree"], "walk-test").map((r) => r?.id)).toEqual(["g2"]) // one repo: the latest, as before
  })
})

describe("a template with placeholders", () => {
  const served = new Set(["git_diff", "git_status", "fs_read"])
  const realFetch = globalThis.fetch
  let applicable: (pool: any[], skipped?: any[], now?: number, note?: any) => Promise<Array<{ id: string; inputs?: any[] }>>
  afterAll(() => { globalThis.fetch = realFetch })
  beforeAll(async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, unknown> }
      return Response.json({ content: { vessels: served.has(String(pointer.shape)) ? [{ vesselId: "tools", endpoint: "http://tools.test" }] : [] } })
    }) as typeof fetch
    applicable = (await import("../src/applicable")).applicable
  })
  const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person" }
  const t = { shape: "activity_template", id: "t-d", seq: 2, role: "described", sig: { in: ["gitWorktree"], out: ["gitDiff"] },
    calls: [{ shape: "git_diff", pointer: { cwd: "{{ sig.in[0].cwd }}" } }] }

  test("[MUST-FAIL] not run until this request has the field; the skip names it; run the tick the field lands", async () => {
    const other = clone("g9", 3, "w2", "/other") // another request's clone: the shape is there, the field is not this request's
    const skipped: any[] = []
    expect((await applicable([ask, t, other], skipped, Date.now(), { root: "w1" })).map((c) => c.id)).not.toContain("run/t-d")
    expect(skipped.find((x) => x.id === "t-d")).toMatchObject({ unserved: ["unbound {{ sig.in[0].cwd }}: this request has no such field"], unbound: ["sig.in[0].cwd"] })
    const ok = (await applicable([ask, t, other, clone("g1", 4, "w1", "/trees/r")], [], Date.now(), { root: "w1" })).find((c) => c.id === "run/t-d")
    expect(ok?.inputs?.map((r) => r?.id)).toEqual(["g1"])
  })

  test("[MUST-FAIL] two repos' clones and a template naming none: not run, and the skip says which repos", async () => {
    const two = [{ ...clone("g1", 4, "w1", "/trees/hsv"), repo: "human-surface-vessel" }, { ...clone("g2", 5, "w1", "/trees/super"), repo: "super" }]
    const skipped: any[] = []
    expect((await applicable([ask, t, ...two], skipped, Date.now(), { root: "w1" })).map((c) => c.id)).not.toContain("run/t-d")
    expect(skipped.find((x) => x.id === "t-d")?.unserved).toEqual(["unbound {{ sig.in[0].cwd }}: more than one gitWorktree (human-surface-vessel, super), and the template names no repo"])
  })

  test("[MUST-FAIL] a template whose edit carries a Go template is offered, with no skip", async () => {
    const go = { ...t, id: "t-go", sig: { in: ["world_changed"], out: ["fileEditResult"] },
      calls: [{ shape: "fs_read", pointer: { path: "a.go", note: "{{ .MaxFailingTestGaps }}" } }] }
    const skipped: any[] = []
    expect((await applicable([ask, go], skipped, Date.now(), { root: "w1" })).map((c) => c.id)).toContain("run/t-go")
    expect(skipped.find((x) => x.id === "t-go")).toBeUndefined()
  })

  // The owner seed's activity_template description teaches these two examples, in exactly these strings (super,
  // scripts/substrate/walk-owner-seed.ts). Keep these equal to the seed's: this test holds the walk to them, and the
  // seed's keep-visibility test, leg (d), holds the description to them. Neither reads the other's file, so a change to
  // one side must be made on both by hand (named debt: the strings are copied, not shared).
  const SEED_SIG_IN = ["gitWorktree"]
  const SEED_INPUT_EXAMPLE = "{{ sig.in[0].cwd }}"
  const SEED_CALL_EXAMPLE = "{{ calls.0.output.cwd }}"

  test("[MUST-FAIL] the owner seed's examples bind as written: sig.in input on a 489-like request, and an earlier call's answer", async () => {
    // a request whose wanted change names another repo than the one the template was learned on, with its own clone
    const root = { shape: "change_request", id: "r489", seq: 1, role: "person" }
    const wanted = { shape: "change_wanted", id: "cw1", seq: 2, role: "described", repo: "walk-vessel", wanted: true, input_refs: ["r489"] }
    const mine = { ...clone("g1", 3, "r489", "/trees/walk-vessel"), repo: "walk-vessel" }
    const tmpl = { shape: "activity_template", id: "t-seed", seq: 4, role: "described", sig: { in: SEED_SIG_IN, out: ["gitDiff"] },
      calls: [{ shape: "git_diff", pointer: { cwd: SEED_INPUT_EXAMPLE } }] }
    const skipped: any[] = []
    const run = (await applicable([root, wanted, mine, tmpl], skipped, Date.now(), { root: "r489" })).find((c) => c.id === "run/t-seed")
    expect([run?.inputs?.map((r) => r?.id), skipped.find((x) => x.id === "t-seed")?.unbound ?? []]).toEqual([["g1"], []])
    // the same example, its field misspelt, is a field this request has not got
    const wrong = { ...tmpl, id: "t-wrong", calls: [{ shape: "git_diff", pointer: { cwd: SEED_INPUT_EXAMPLE.replace(".cwd", ".dir") } }] }
    const skipped2: any[] = []
    await applicable([root, wanted, mine, wrong], skipped2, Date.now(), { root: "r489" })
    expect(skipped2.find((x) => x.id === "t-wrong")?.unbound).toEqual(["sig.in[0].dir"])
    // the second example, filled from call 0's answer during the run
    const scope = { sig: { in: [mine] }, calls: [{ output: { cwd: "/trees/walk-vessel" }, call_id: "c0" }] }
    expect(bind({ cwd: SEED_CALL_EXAMPLE }, scope as any)).toMatchObject({ value: { cwd: "/trees/walk-vessel" }, unbound: [] })
  })

  test("a template with no placeholder is offered as before", async () => {
    const lit = { ...t, id: "t-l", calls: [{ shape: "git_status", pointer: { cwd: "/fixed" } }] }
    expect((await applicable([ask, lit, clone("g1", 4, "w1", "/x")], [], Date.now(), { root: "w1" })).map((c) => c.id)).toContain("run/t-l")
  })
})

describe("a run's calls", () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })
  const setup = (answers: Record<string, unknown>) => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    const sent: Array<Record<string, any>> = []
    const written: Array<Record<string, any>> = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      if (pointer.type === "record_write") { written.push(pointer.row); return Response.json({ ...pointer.row, id: `r${written.length}`, seq: 1 }) }
      if (pointer.type === "vessel_capability") return Response.json({ content: { vessels: [] } })
      sent.push(pointer)
      return Response.json(answers[String(pointer.type)] ?? { ok: true })
    }) as typeof fetch
    return { sent, written }
  }
  const sel = { shape: "selection", id: "sel-1", seq: 20, root: "w1" } as any

  test("[MUST-FAIL] the tool gets the bound value, no '{{' reaches any tool, and the started hop says what was sent and where it came from", async () => {
    const { sent, written } = setup({ git_diff: { cwd: "/trees/r", diff: "" } })
    const { execute } = await import("../src/calls")
    await execute({ id: "run/t-d", kind: "run", pointer: {}, t: "", inputs: [clone("g1", 4, "w1", "/trees/r")],
      calls: [{ shape: "git_diff", pointer: { cwd: "{{ sig.in[0].cwd }}" } }, { shape: "fs_read", pointer: { path: "{{calls.0.output.cwd}}/src/a.ts" } }] }, sel)
    expect(sent.map((p) => [p.type, p.cwd ?? p.path])).toEqual([["git_diff", "/trees/r"], ["fs_read", "/trees/r/src/a.ts"]])
    expect(JSON.stringify(sent)).not.toContain("{{")
    const hops = written.filter((r) => r.shape === "hop" && r.phase === "started")
    expect(hops.map((h) => [h.args, h.bound])).toEqual([
      [{ cwd: "/trees/r" }, [{ placeholder: "sig.in[0].cwd", from: "g1" }]],
      [{ path: "/trees/r/src/a.ts" }, [{ placeholder: "calls.0.output.cwd", from: hops[0].call_id }]],
    ])
  })

  test("[MUST-FAIL] a placeholder unfilled at run time: the call is not made, and a failure names it for the template's writer", async () => {
    const { sent, written } = setup({ git_diff: { diff: "" } }) // the answer has no cwd
    const { execute } = await import("../src/calls")
    await execute({ id: "run/t-d", kind: "run", pointer: {}, t: "", inputs: [clone("g1", 4, "w1", "/trees/r")],
      calls: [{ shape: "git_diff", pointer: { cwd: "{{ sig.in[0].cwd }}" } }, { shape: "fs_read", pointer: { path: "{{ calls.0.output.cwd }}/a" } }] }, sel)
    expect(sent.map((p) => p.type)).toEqual(["git_diff"])
    expect(written.find((r) => r.shape === "failure")).toMatchObject({ kind: "unbound", template_ref: "t-d", unbound: ["calls.0.output.cwd"], selection_ref: "sel-1" })
  })

  test("a template with no placeholder sends its pointer as before, and its hop says what was sent", async () => {
    const { sent, written } = setup({})
    const { execute } = await import("../src/calls")
    await execute({ id: "run/t-l", kind: "run", pointer: {}, t: "", calls: [{ shape: "git_status", pointer: { cwd: "/fixed" } }] }, sel)
    expect(sent[0]).toMatchObject({ type: "git_status", cwd: "/fixed" })
    expect(written.find((r) => r.shape === "hop" && r.phase === "started")).toMatchObject({ args: { cwd: "/fixed" }, bound: [] })
  })
})
