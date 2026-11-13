// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { draw } from "../src/draw"
import { type Fake, exitsNaming, fake, freePort, healthy, run, until } from "./harness"

const NODE_KEY = "node-key-for-test"

describe("Thompson draw", () => {
  test("the same seed and posteriors give the same choice", () => {
    const posts = [{ alpha: 2, beta: 3 }, { alpha: 3, beta: 2 }, { alpha: 1, beta: 1 }]
    for (let seed = 1; seed < 50; seed++) expect(draw(seed, posts)).toBe(draw(seed, posts))
  })

  test("a posterior far ahead is chosen", () => {
    const posts = [{ alpha: 1, beta: 1000 }, { alpha: 1000, beta: 1 }]
    for (let seed = 1; seed < 50; seed++) expect(draw(seed, posts)).toBe(1)
  })
})

describe("choosing among roots", () => {
  beforeAll(() => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
  })

  test("[MUST-FAIL] a root with one weak move is drawn about as often as one with many strong moves", async () => {
    const { choose } = await import("../src/loop")
    // A: eight moves that have done well; B: a gap root's one move that has not yet been credited
    const options = [...Array.from({ length: 8 }, () => ({ root: "A" })), { root: "B" }]
    const posts = [...Array.from({ length: 8 }, () => ({ alpha: 20, beta: 5 })), { alpha: 1, beta: 30 }]
    let b = 0
    for (let seed = 1; seed <= 400; seed++) if (options[choose(seed, options, posts)].root === "B") b++
    expect(b).toBeGreaterThan(140)
    expect(b).toBeLessThan(260)
  })

  test("within a root the posterior still decides, and the same seed gives the same choice (a guard)", async () => {
    const { choose } = await import("../src/loop")
    const options = [{ root: "A" }, { root: "A" }]
    const posts = [{ alpha: 1, beta: 50 }, { alpha: 50, beta: 1 }]
    for (let seed = 1; seed < 50; seed++) {
      expect(choose(seed, options, posts)).toBe(1)
      expect(choose(seed, options, posts)).toBe(choose(seed, options, posts))
    }
  })
})

describe("candidates", () => {
  const served = new Set(["answer", "fileContent", "outcome", "due"])
  const asked: Array<Record<string, unknown>> = []
  let applicable: (pool: any[]) => Promise<Array<{ id: string; kind: string; pointer: Record<string, unknown> }>>
  const realFetch = globalThis.fetch

  afterAll(() => {
    globalThis.fetch = realFetch
  })

  beforeAll(async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, unknown> }
      asked.push(pointer)
      const vessels = served.has(String(pointer.shape)) ? [{ vesselId: "producer-x", endpoint: "http://producer.test" }] : []
      return Response.json({ content: { vessels } })
    }) as typeof fetch
    applicable = (await import("../src/applicable")).applicable
  })

  const pool = [
    { shape: "world_changed", id: "w1", seq: 1 },
    { shape: "shape_schema", id: "s1", seq: 2, target: "answer", inputs: ["world_changed"] },
    { shape: "shape_schema", id: "s2", seq: 3, target: "nobody_serves_this", inputs: ["world_changed"] },
    { shape: "channel", id: "ch1", seq: 4, calls: [] },
    { shape: "request", id: "q1", seq: 5, pointer: { type: "fileContent", path: "README.md" } },
    { shape: "request", id: "q2", seq: 6, pointer: { type: "unserved_shape" } },
  ]

  describe("a move's cell is the move in what it reads", () => {
    const now = Date.parse("2026-01-01T12:00:00Z")
    const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person", writer: "kid-p", t: "2026-01-01T11:59:30Z" }
    const sch = { shape: "shape_schema", id: "s1", seq: 2, role: "owner", writer: "owner", target: "answer", inputs: ["world_changed"], context: ["fileContent"] }
    const ch = { shape: "channel", id: "ch1", seq: 3, role: "owner", writer: "owner", calls: [] }
    const req = { shape: "request", id: "q1", seq: 4, role: "described", writer: "described-x", pointer: { type: "fileContent", path: "README.md" } }
    const cellsOf = async (rows: any[]) => {
      const { choices } = await import("../src/loop")
      return Object.fromEntries((await choices([], [{ root: ask as any, rows }], now)).map((o) => [o.cand.id, o.cell]))
    }
    test("[MUST-FAIL] a shape the move does not read (an owner's new row kind, a requires row) never changes its cell", async () => {
      const before = await cellsOf([ask, sch, ch, req])
      const repo = { shape: "repository", id: "rp1", seq: 5, role: "owner", writer: "owner", repo: "x", units: [], roles: [], retired: false }
      const needs = { shape: "requires", id: "rq1", seq: 6, role: "owner", writer: "owner", for: "fileContent", needs: "world_changed" }
      const after = await cellsOf([ask, sch, ch, req, repo, needs])
      expect(before["produce/answer/ch1"]).toBe("produce/answer/ch1|world_changed,asker:person,age:0")
      expect(before["call/fileContent"]).toBe("call/fileContent|request,asker:person,age:0")
      expect(after["produce/answer/ch1"]).toBe(before["produce/answer/ch1"])
      expect(after["call/fileContent"]).toBe(before["call/fileContent"])
    })
    test("[MUST-FAIL] the first row of a shape the move reads is a new situation: its cell changes", async () => {
      const read = { shape: "fileContent", id: "f1", seq: 5, role: "walk", writer: "local-tools-x", path: "README.md", content: "x" }
      const after = await cellsOf([ask, sch, ch, req, read])
      expect(after["produce/answer/ch1"]).toBe("produce/answer/ch1|fileContent,world_changed,asker:person,age:0")
    })
    test("[MUST-FAIL] a wait reads nothing: its cell is the asker and the age only", async () => {
      const arm = { shape: "arm", id: "arm1", seq: 7, role: "owner", writer: "owner", arm: "treated" }
      const repo = { shape: "repository", id: "rp1", seq: 8, role: "owner", writer: "owner", repo: "x" }
      // Nothing else to do on the root (no schema, no request), so the wait is the move offered.
      const cells = await cellsOf([ask, arm, repo])
      expect(cells["wait-for"]).toBe("wait-for|asker:person,age:0")
    })
  })

  test("ids name the choice by shape and channel, never by a vessel or an address", async () => {
    const ids = (await applicable(pool)).map((c) => c.id)
    expect(ids).toContain("produce/answer/ch1")
    expect(ids).toContain("call/fileContent")
    for (const id of ids) {
      expect(id).not.toContain("producer-x")
      expect(id).not.toContain("http")
    }
  })

  test("a shape with no producer gives no candidate", async () => {
    const ids = (await applicable(pool)).map((c) => c.id)
    expect(ids.some((id) => id.includes("nobody_serves_this") && id.startsWith("produce/"))).toBe(false)
    expect(ids.some((id) => id.includes("unserved_shape"))).toBe(false)
  })

  test("an idle walk can always wait, and candidates carry no address", async () => {
    const cands = await applicable([...pool, { shape: "arm", id: "arm1", seq: 7, arm: "treated" }])
    expect(cands.map((c) => c.id)).toContain("wait-for")
    expect(JSON.stringify(cands)).not.toContain("http")
  })

  test("a schema written again offers its produce once, under the newest row's rules", async () => {
    const twice = [
      ...pool,
      { shape: "shape_schema", id: "s1-again", seq: 7, target: "answer", inputs: ["world_changed"] },
    ]
    expect((await applicable(twice)).map((c) => c.id).filter((id) => id === "produce/answer/ch1")).toEqual(["produce/answer/ch1"])
    const stricter = [
      ...pool,
      { shape: "shape_schema", id: "s1-newer", seq: 8, target: "answer", inputs: ["world_changed", "not_in_pool"] },
    ]
    expect((await applicable(stricter)).map((c) => c.id)).not.toContain("produce/answer/ch1")
  })

  test("[MUST-FAIL] a request answered by a call that ENDED is not called again; one whose call failed still is", async () => {
    const first = (await applicable(pool)).find((c) => c.id === "call/fileContent") as { from?: string } | undefined
    expect(first?.from).toBe("q1")
    const failed = [...pool,
      { shape: "selection", id: "sel-bad", seq: 7, from: "q1" },
      { shape: "failure", id: "f1", seq: 8, selection_ref: "sel-bad", status: 502 },
    ]
    expect((await applicable(failed)).map((c) => c.id)).toContain("call/fileContent")
    const answered = [...failed,
      { shape: "selection", id: "sel-ok", seq: 9, from: "q1" },
      { shape: "hop", id: "h1", seq: 10, phase: "ended", kind: "call", selection_ref: "sel-ok" },
    ]
    expect((await applicable(answered)).map((c) => c.id)).not.toContain("call/fileContent")
  })

  test("[MUST-FAIL] a template that calls a shape nothing serves is not run; one calling served shapes is", async () => {
    const sig = { in: ["world_changed"], out: ["answer"] }
    const templates = [...pool,
      { shape: "activity_template", id: "t-hop", seq: 7, sig, calls: [{ shape: "hop", pointer: {} }] },
      { shape: "activity_template", id: "t-ok", seq: 8, sig, calls: [{ shape: "fileContent", pointer: { path: "a" } }, { shape: "answer", pointer: { via_ref: "ch1" } }] },
    ]
    const ids = (await applicable(templates)).map((c) => c.id)
    expect(ids).toContain("run/t-ok")
    expect(ids).not.toContain("run/t-hop")
    const skipped: Array<{ id: string; unserved: string[] }> = []
    await (applicable as any)(templates, skipped)
    expect(skipped).toEqual([{ id: "t-hop", unserved: ["hop"] }])
  })

  test("[MUST-FAIL] while a request is open, a wait ends by its FIRST deadline; once that has passed, none is offered", async () => {
    const waits = async (rows: any[]) => (await applicable(rows)).filter((c) => c.kind === "wait-for")
    const soon = Date.now() + 600_000
    const later = Date.now() + 1_200_000
    const passed = Date.now() - 60_000
    const asked = [...pool, { shape: "world_changed", id: "w9", seq: 6, role: "person" }]
    const due = (id: string, seq: number, at: number, extra: Record<string, unknown> = {}) =>
      ({ shape: "due", id, seq, at, within_ms: 60_000, role: "described", input_refs: ["w9"], ...extra })
    expect(await waits(asked)).toEqual([])
    expect(await waits([...asked, due("d0", 7, passed)])).toEqual([])
    // a later deadline ahead does not reopen waiting once the first has passed
    expect(await waits([...asked, due("d0", 7, passed), due("d2", 9, soon)])).toEqual([])
    // nor does a sooner later one shorten it: the first deadline bounds the wait
    const bounded = await waits([...asked, due("d1", 8, later), due("d2", 9, soon)])
    expect(bounded.length).toBeGreaterThan(0)
    for (const c of bounded) expect(c.pointer.until).toBe(later)
    // a due-shaped row a person wrote, or one without within_ms, is not a deadline, as records does not read it as one
    for (const odd of [due("p0", 7, passed, { role: "person" }), due("n0", 7, passed, { within_ms: undefined })]) {
      const w = await waits([...asked, odd, due("d1", 8, later)])
      expect(w.length).toBeGreaterThan(0)
      for (const c of w) expect(c.pointer.until).toBe(later)
    }
    const idle = await waits([...pool, { shape: "arm", id: "arm1", seq: 7, arm: "treated" }])
    expect(idle.length).toBeGreaterThan(0)
    for (const c of idle) expect("until" in c.pointer).toBe(false)
  })

  test("[MUST-FAIL] the only wait is for the next person or owner row; none waits for a shape only the walk's own moves write", async () => {
    const waits = (await applicable([...pool, { shape: "arm", id: "arm1", seq: 7, arm: "treated" }])).filter((c) => c.kind === "wait-for")
    expect(waits.map((c) => c.id)).toEqual(["wait-for"])
    expect(waits[0].pointer.shapes).toEqual([])
  })

  test("[MUST-FAIL] no wait blind to new rows is offered: a deadline ahead bounds a wait-for, which also ends on a new row", async () => {
    const soon = Date.now() + 600_000
    const asker = { shape: "world_changed", id: "w9", seq: 6, role: "person" }
    const due = { shape: "due", id: "d2", seq: 9, at: soon, within_ms: 60_000, role: "described", input_refs: ["w9"] }
    const kinds = (await applicable([...pool, asker, due])).map((c) => c.kind)
    expect(kinds).toContain("wait-for")
    expect(kinds).not.toContain("wait-until")
  })

  // Rows for the duplicate rule: a request, a channel, the walk's own hop, and owner schemas.
  const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person" }
  const ch = { shape: "channel", id: "ch1", seq: 2, calls: [] }
  const hop = { shape: "hop", id: "h1", seq: 3, role: "walk" }
  const sch = (target: string, context: string[]) => ({ shape: "shape_schema", id: `s-${target}`, seq: 4, target, inputs: ["world_changed"], context })
  const a1 = { shape: "answer", id: "a1", seq: 5, role: "described", input_refs: ["w1", "h1"] }
  const d1 = { shape: "due", id: "d1", seq: 6, role: "described", input_refs: ["w1"] }
  const o1 = { shape: "outcome", id: "o1", seq: 7, role: "described", input_refs: ["w1", "a1"], evidence_refs: ["a1"] }
  const ids = async (rows: any[]) => (await applicable(rows)).map((c) => c.id)

  test("[MUST-FAIL] an answer the walk graded r 1 from only what it saw is not produced again; a grade with more counts", async () => {
    const s = sch("answer", [])
    const mine = { shape: "answer", id: "a1", seq: 5, role: "described", input_refs: ["w1"] }
    const self1 = { shape: "outcome", id: "o1", seq: 6, role: "described", r: 1, input_refs: ["w1", "a1"], evidence_refs: ["a1"] }
    expect(await ids([ask, ch, s, mine, self1])).not.toContain("produce/answer/ch1")
    // an r 1 that also read something the answer never saw is a grade with information: another answer may be produced
    const extra = { shape: "fileContent", id: "fc1", seq: 6, role: "described" }
    const informed = { ...self1, input_refs: ["w1", "a1", "fc1"] }
    expect(await ids([ask, ch, s, mine, extra, informed])).toContain("produce/answer/ch1")
    // a self r 0 asks for another try, and a person's verdict always counts
    expect(await ids([ask, ch, s, mine, { ...self1, r: 0 }])).toContain("produce/answer/ch1")
    expect(await ids([ask, ch, s, mine, { ...self1, role: "person", input_refs: ["a1"] }])).toContain("produce/answer/ch1")
  })

  test("[MUST-FAIL] a row the walk recorded from a tool's answer is an input like any other: a new one offers the produce again", async () => {
    const s = { shape: "shape_schema", id: "s-v", seq: 4, target: "answer", inputs: ["world_changed", "gitDiff"] }
    const d1 = { shape: "gitDiff", id: "g1", seq: 5, role: "walk", tree: "t1" }
    const made = { shape: "answer", id: "v1", seq: 6, role: "described", input_refs: ["w1", "g1"] }
    expect(await ids([ask, ch, s, d1, made])).not.toContain("produce/answer/ch1")
    const d2 = { shape: "gitDiff", id: "g2", seq: 7, role: "walk", tree: "t2" }
    expect(await ids([ask, ch, s, d1, made, d2])).toContain("produce/answer/ch1")
  })

  test("[MUST-FAIL] a call that ended is new information: a schema reading hops is offered again, once per result", async () => {
    const s = sch("answer", ["hop"])
    const a1 = { shape: "answer", id: "a1", seq: 5, role: "described", input_refs: ["w1"] }
    const h1 = { shape: "hop", id: "h1", seq: 6, role: "walk", phase: "ended", kind: "call", selection_ref: "x" }
    expect(await ids([ask, ch, s, a1])).not.toContain("produce/answer/ch1")
    expect(await ids([ask, ch, s, a1, h1])).toContain("produce/answer/ch1")
    // no churn: once a2 is made over that result, nothing is offered until the next call ends
    const a2 = { shape: "answer", id: "a2", seq: 7, role: "described", input_refs: ["w1", "h1"] }
    expect(await ids([ask, ch, s, a1, h1, a2])).not.toContain("produce/answer/ch1")
    const h2 = { ...h1, id: "h2", seq: 8, kind: "run" }
    expect(await ids([ask, ch, s, a1, h1, a2, h2])).toContain("produce/answer/ch1")
  })

  test("a started hop, a wait, a produce or a failure brings nothing new (guards against widening)", async () => {
    const s = sch("answer", ["hop", "failure"])
    const a1 = { shape: "answer", id: "a1", seq: 5, role: "described", input_refs: ["w1"] }
    const hop = (id: string, f: Record<string, unknown>) => ({ shape: "hop", id, seq: 6, role: "walk", selection_ref: "x", ...f })
    for (const quiet of [
      hop("hs", { phase: "started", kind: "call" }), hop("hw", { phase: "ended", kind: "wait-for" }),
      hop("hp", { phase: "ended", kind: "produce" }), { shape: "failure", id: "f1", seq: 6, role: "walk", status: 422, selection_ref: "x" },
    ]) expect(await ids([ask, ch, s, a1, quiet])).not.toContain("produce/answer/ch1")
  })

  test("[MUST-FAIL] a call whose failure records stamped as blaming the request settles it; any other failure leaves it callable", async () => {
    const failed = (f: Record<string, unknown>) => [...pool,
      { shape: "selection", id: "sel-1", seq: 7, role: "walk", a: "call/fileContent", from: "q1" },
      { shape: "failure", id: "f1", seq: 8, role: "walk", selection_ref: "sel-1", body: "old_string not found. The closest real text is ...", ...f },
    ]
    const callable = async (f: Record<string, unknown>) => (await applicable(failed(f))).map((c) => c.id).includes("call/fileContent")
    expect(await callable({ status: 200, blames: "request" })).toBe(false)
    expect(await callable({ status: 422, blames: "request" })).toBe(false)
    expect(await callable({ status: 503, blames: "callee" })).toBe(true)
    // the walk decides nothing from a status: a refusal records did not stamp leaves the request callable
    for (const status of [200, 422]) expect(await callable({ status })).toBe(true)
  })

  test("[MUST-FAIL] a call whose failure blames the request is new information: a schema reading failures is offered again", async () => {
    // the producer's earlier row over the same rows (an answer here; the fake discovery serves it) makes it pending
    const s = sch("answer", ["hop", "failure"])
    const r1 = { shape: "answer", id: "r1", seq: 5, role: "described", input_refs: ["w1"] }
    const sel = { shape: "selection", id: "sel-1", seq: 6, role: "walk", a: "call/fs_edit", from: "q9" }
    const f = (blames: string) => ({ shape: "failure", id: "f1", seq: 7, role: "walk", selection_ref: "sel-1", status: 200, blames, body: "old_string not found" })
    expect(await ids([ask, ch, s, r1, sel])).not.toContain("produce/answer/ch1")
    expect(await ids([ask, ch, s, r1, sel, f("request")])).toContain("produce/answer/ch1")
    // a failure blaming the callee brings no new fact: the same request is simply called again
    expect(await ids([ask, ch, s, r1, sel, f("callee")])).not.toContain("produce/answer/ch1")
    // a produce's own refusal is not a call's answer, and stays as it was
    const psel = { ...sel, a: "produce/answer/ch1" }
    expect(await ids([ask, ch, s, r1, psel, f("request")])).not.toContain("produce/answer/ch1")
  })

  test("[MUST-FAIL] a context entry {shape, where} is read by its shape: a new ended call hop is new information, a produce hop is not", async () => {
    const s = { ...sch("answer", []), context: [{ shape: "hop", where: { phase: "ended", kind: ["call", "run"] } }] }
    const ended = (id: string, seq: number, kind: string) => ({ shape: "hop", id, seq, role: "walk", phase: "ended", kind, call_id: id, output: {} })
    const r1 = { shape: "answer", id: "r1", seq: 6, role: "described", input_refs: ["w1", "he1"] }
    expect(await ids([ask, ch, s, ended("he1", 5, "call"), r1])).not.toContain("produce/answer/ch1")
    expect(await ids([ask, ch, s, ended("he1", 5, "call"), r1, ended("he2", 7, "call")])).toContain("produce/answer/ch1")
    expect(await ids([ask, ch, s, ended("he1", 5, "call"), r1, ended("hp1", 7, "produce")])).not.toContain("produce/answer/ch1")
  })

  test("[MUST-FAIL] a produce refused as not fitting its schema is not asked again over the same rows", async () => {
    const s = sch("answer", [])
    const sel = { shape: "selection", id: "sel1", seq: 5, role: "walk", a: "produce/answer/ch1", pool_refs: ["w1", "ch1", "s-answer"] }
    const refused = { shape: "failure", id: "f1", seq: 6, role: "walk", status: 422, refused: "schema", selection_ref: "sel1" }
    expect(await ids([ask, ch, s, sel, refused])).not.toContain("produce/answer/ch1")
    // a channel that was down is not a refusal: asked again
    expect(await ids([ask, ch, s, sel, { ...refused, status: 502, refused: undefined }])).toContain("produce/answer/ch1")
    // nor is a 422 passed through from a read or a write
    expect(await ids([ask, ch, s, sel, { ...refused, refused: undefined }])).toContain("produce/answer/ch1")
    // a new row to answer from is asked for
    const ask2 = { ...ask, id: "w2", seq: 7 }
    expect(await ids([ask, ch, s, sel, refused, ask2])).toContain("produce/answer/ch1")
  })

  test("[MUST-FAIL] a repeat answer or due for the same request waits for the first one's grade", async () => {
    expect(await ids([ask, ch, hop, sch("answer", ["hop"]), a1])).not.toContain("produce/answer/ch1")
    expect(await ids([ask, ch, sch("due", []), d1])).not.toContain("produce/due/ch1")
  })

  test("[MUST-FAIL] a request with no pointer declines: no call is offered for the root, and nothing throws", async () => {
    const asked = { shape: "request", id: "q1", seq: 5, role: "described", pointer: { type: "fileContent", path: "a" } }
    expect(await ids([...pool.filter((r) => r.shape !== "request"), asked])).toContain("call/fileContent")
    const decline = { shape: "request", id: "q2", seq: 6, role: "described", none: "the ask is answered" }
    expect((await ids([...pool.filter((r) => r.shape !== "request"), asked, decline])).filter((id) => id.startsWith("call/"))).toEqual([])
    const again = { ...asked, id: "q3", seq: 7 }
    expect(await ids([...pool.filter((r) => r.shape !== "request"), asked, decline, again])).toContain("call/fileContent")
  })

  test("[MUST-FAIL] a template calling a produced shape with no channel is not run; one naming a channel is", async () => {
    const s = sch("answer", [])
    const tpl = (id: string, pointer: Record<string, unknown>) =>
      ({ shape: "activity_template", id, seq: 8, role: "described", sig: { in: ["world_changed"], out: ["answer"] }, calls: [{ shape: "answer", pointer }] })
    const skipped: any[] = []
    const got = (await applicable([ask, ch, s, tpl("t-hollow", { id: "a9", text: "Hello" }), tpl("t-ok", { via_ref: "ch1" })], skipped)).map((c) => c.id)
    expect(got).not.toContain("run/t-hollow")
    expect(got).toContain("run/t-ok")
    expect(skipped).toEqual([{ id: "t-hollow", unserved: ["answer (no channel)"] }])
  })

  test("[MUST-FAIL] an earlier outcome does not block grading a new answer", async () => {
    const outcome = sch("outcome", ["answer", "due"])
    expect(await ids([ask, ch, outcome, a1, o1])).not.toContain("produce/outcome/ch1")
    const a2 = { shape: "answer", id: "a2", seq: 8, role: "described", input_refs: ["w1", "h1"] }
    expect(await ids([ask, ch, outcome, a1, o1, a2])).toContain("produce/outcome/ch1")
  })

  test("[MUST-FAIL] an earlier outcome does not block grading a due that has since appeared (a lapse)", async () => {
    expect(await ids([ask, ch, sch("outcome", ["answer", "due"]), a1, o1, d1])).toContain("produce/outcome/ch1")
  })

  test("[MUST-FAIL] a grade is not offered before there is something to judge: an answer, or a deadline that passed", async () => {
    // the outcome schema's context as the owner writes it
    const grade = sch("outcome", ["answer", "due", "hop"])
    const request = { shape: "request", id: "q9", seq: 5, role: "described", input_refs: ["w1"], pointer: { type: "git_status" } }
    expect(await ids([ask, ch, grade])).not.toContain("produce/outcome/ch1")
    // a described row the grade does not read as context (a request) is nothing to judge
    expect(await ids([ask, ch, grade, request])).not.toContain("produce/outcome/ch1")
    // nor is the producer's own deadline while it is still ahead, though the grade reads dues
    const ahead = { ...d1, within_ms: 60_000, at: Date.now() + 600_000 }
    expect(await ids([ask, ch, grade, ahead])).not.toContain("produce/outcome/ch1")
    expect(await ids([ask, ch, grade, ahead, a1])).toContain("produce/outcome/ch1")
    const passed = { ...d1, within_ms: 60_000, at: Date.now() - 60_000 }
    expect(await ids([ask, ch, grade, passed])).toContain("produce/outcome/ch1")
  })

  test("a produce of any other shape is offered as before, with nothing to judge (a guard)", async () => {
    expect(await ids([ask, ch, sch("answer", ["hop"])])).toContain("produce/answer/ch1")
  })

  test("[MUST-FAIL] a root records says no one awaits an answer on may wait unbounded, whatever its shape is called", async () => {
    const chan = { shape: "channel", id: "ch1", seq: 2, calls: [] }
    const waits = async (rows: any[], awaits?: boolean) =>
      (await applicable(rows, [], Date.now(), awaits === undefined ? {} : { awaits })).filter((c) => c.kind === "wait-for")
    const anyName = { shape: "zzz_unknown", id: "z1", seq: 1, role: "detector" }
    const idle = await waits([anyName, chan], false)
    expect(idle).toHaveLength(1)
    expect("until" in idle[0].pointer).toBe(false)
    // the walk knows no shape by name: a "gap" row records did not mark is an ordinary root, and so is one it says awaits
    const gap = { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "x", status: "open" }
    expect(await waits([gap, chan])).toHaveLength(0)
    expect(await waits([gap, chan], true)).toHaveLength(0)
  })

  test("[MUST-FAIL] a schema's variant is another way to make the same shape: each is offered from its own inputs", async () => {
    const plain = { shape: "shape_schema", id: "s-plain", seq: 3, role: "owner", target: "answer", inputs: ["world_changed"] }
    const fromGap = { shape: "shape_schema", id: "s-gap", seq: 4, role: "owner", target: "answer", variant: "gap", inputs: ["gap"] }
    const gapRow = { shape: "gap", id: "g1", seq: 5, role: "detector", gap_id: "x", status: "open" }
    expect(await ids([ask, ch, plain, fromGap])).toEqual(expect.arrayContaining(["produce/answer/ch1"]))
    expect(await ids([ask, ch, plain, fromGap])).not.toContain("produce/answer/gap/ch1")
    const onGap = (await applicable([gapRow, ch, plain, fromGap] as any)).filter((c) => c.kind === "produce")
    expect(onGap.map((c) => c.id)).toEqual(["produce/answer/gap/ch1"])
    expect(onGap[0].pointer).toEqual({ type: "answer", shape: "answer", via_ref: "ch1", variant: "gap" })
  })

  test("an older schema row a newer one of the same variant superseded stays superseded, whatever its inputs (a guard)", async () => {
    const older = { shape: "shape_schema", id: "s-old", seq: 3, role: "owner", target: "answer", inputs: ["world_changed"] }
    const newer = { shape: "shape_schema", id: "s-new", seq: 4, role: "owner", target: "answer", inputs: ["world_changed", "nothing_here"] }
    expect(await ids([ask, ch, older, newer])).not.toContain("produce/answer/ch1")
  })

  test("[MUST-FAIL] a produce that saw the newest row of a latest_by input is not asked again while nothing newer comes", async () => {
    const schema = { shape: "shape_schema", id: "s1", seq: 3, target: "answer", inputs: ["gap", { shape: "gitDiff", latest_by: "shape" }] }
    const pool = [
      { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "x", status: "open" },
      { shape: "channel", id: "ch1", seq: 2, calls: [] },
      schema,
      { shape: "gitDiff", id: "d-old", seq: 4, role: "walk", tree: "t1" },
      { shape: "gitDiff", id: "d-new", seq: 5, role: "walk", tree: "t2" },
      // the verdict described-shape wrote: shown the gap and the newest diff only, so it cites those
      { shape: "answer", id: "v1", seq: 6, role: "described", r: 0, input_refs: ["g1", "d-new"] },
    ]
    expect((await applicable(pool)).some((c) => c.id === "produce/answer/ch1")).toBe(false) // it saw what it would see now
    const newer = [...pool, { shape: "gitDiff", id: "d-3", seq: 7, role: "walk", tree: "t3" }]
    expect((await applicable(newer)).some((c) => c.id === "produce/answer/ch1")).toBe(true) // a newer diff: asked again
  })

  test("[MUST-FAIL] an input named as {shape, …} is met by a row of its shape: the produce is offered", async () => {
    const pool = [
      { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "x", status: "open" },
      { shape: "channel", id: "ch1", seq: 2, calls: [] },
      { shape: "shape_schema", id: "s1", seq: 3, target: "answer", inputs: ["gap", { shape: "gitDiff", latest_by: "shape" }] },
    ]
    expect((await applicable(pool)).some((c) => c.id === "produce/answer/ch1")).toBe(false) // no gitDiff yet
    const withDiff = [...pool, { shape: "gitDiff", id: "d1", seq: 4, role: "walk", tree: "t1" }]
    expect((await applicable(withDiff)).some((c) => c.id === "produce/answer/ch1")).toBe(true)
  })

  test("[MUST-FAIL] a call the owner preconditions is offered only once the root holds what it requires", async () => {
    const req = { shape: "requires", id: "rq1", seq: 7, role: "owner", for: "fileContent", needs: "change_wanted", where: { wanted: true } }
    const cw = (wanted: boolean) => ({ shape: "change_wanted", id: `cw-${wanted}`, seq: 8, role: "described", wanted, input_refs: ["w1"] })
    const calls = async (rows: any[]) => (await applicable(rows)).map((c) => c.id).filter((id) => id === "call/fileContent")
    expect(await calls([...pool])).toEqual(["call/fileContent"]) // no precondition: as before
    expect(await calls([...pool, req])).toEqual([])
    expect(await calls([...pool, req, cw(false)])).toEqual([])
    expect(await calls([...pool, req, cw(true)])).toEqual(["call/fileContent"])
  })

  test("[MUST-FAIL] several preconditions for one call are alternatives: any one met offers it", async () => {
    const wants = { shape: "requires", id: "rq1", seq: 7, role: "owner", for: "fileContent", needs: "change_wanted", where: { wanted: true } }
    const gapOpen = { shape: "requires", id: "rq2", seq: 8, role: "owner", for: "fileContent", needs: "gap", where: { status: "open" } }
    const gap = (status: string) => ({ shape: "gap", id: `g-${status}`, seq: 9, role: "detector", status })
    const calls = async (rows: any[]) => (await applicable(rows)).map((c) => c.id).filter((id) => id === "call/fileContent")
    expect(await calls([...pool, wants, gapOpen, gap("closed")])).toEqual([])
    expect(await calls([...pool, wants, gapOpen, gap("open")])).toEqual(["call/fileContent"])
  })

  test("[MUST-FAIL] a landing's wait follows what it needs to the call that makes it, from the owner's schemas and the vessels' declared answers", async () => {
    for (const x of ["request", "land_verdict", "git_land", "git_diff"]) served.add(x)
    const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
    const rows: any[] = [
      { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "G1", status: "open" },
      own({ shape: "channel", id: "ch1", calls: [] }, 2),
      own({ shape: "shape_schema", id: "slg", target: "land_verdict", variant: "gap", inputs: ["gap", "gitDiff"] }, 5),
      own({ shape: "requires", id: "q3", for: "git_land", needs: "land_verdict", where: { r: 1 }, latest_by: "tree" }, 8),
    ]
    const ask = { shape: "request", id: "a1", seq: 10, role: "described", pointer: { type: "git_land" }, input_refs: ["g1"] }
    const answers = { git_diff: "gitDiff", git_commit: "gitCommitResult" }
    const said = async (pool: any[], a: Record<string, string>) => {
      const skipped: any[] = []
      await (applicable as any)(pool, skipped, Date.now(), {}, a)
      return skipped.map((x) => x.unserved).flat()
    }
    // no diff yet: the landing waits for a verdict, made from a diff, which a git_diff call makes
    expect(await said([...rows, ask], answers)).toEqual([
      "git_land (requires land_verdict; land_verdict is made from gitDiff, not yet here; gitDiff comes from a git_diff call)",
    ])
    // the diff is here: only the verdict is missing, and nothing about a diff is said
    const diff = { shape: "gitDiff", id: "d1", seq: 11, role: "walk", tree: "t".repeat(40), input_refs: ["g1"] }
    expect(await said([...rows, diff, ask], answers)).toEqual(["git_land (requires land_verdict)"])
    // no declared answers: as before
    expect(await said([...rows, ask], {})).toEqual(["git_land (requires land_verdict; land_verdict is made from gitDiff, not yet here)"])
  })

  test("[MUST-FAIL] the steps toward a need end, however the schemas and declared answers loop", async () => {
    for (const x of ["request", "git_land"]) served.add(x)
    const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
    const rows: any[] = [
      { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "G1", status: "open" },
      own({ shape: "shape_schema", id: "s1", target: "alpha", inputs: ["beta"] }, 2),
      own({ shape: "shape_schema", id: "s2", target: "beta", inputs: ["alpha"] }, 3),
      own({ shape: "requires", id: "q", for: "git_land", needs: "alpha" }, 4),
    ]
    const ask = { shape: "request", id: "a1", seq: 10, role: "described", pointer: { type: "git_land" }, input_refs: ["g1"] }
    const skipped: any[] = []
    await (applicable as any)([...rows, ask], skipped, Date.now(), {}, { make_alpha: "alpha", make_beta: "beta" })
    expect(skipped[0].unserved).toEqual(["git_land (requires alpha; alpha is made from beta, not yet here; beta is made from alpha, not yet here)"])
  })

  test("the walk names no shape a vessel serves: what a call answers is the vessels' to declare (a guard)", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    for (const f of ["applicable.ts", "calls.ts", "loop.ts"]) {
      const src = readFileSync(join(import.meta.dir, "..", "src", f), "utf8")
      expect(src).not.toMatch(/["'`](git_diff|gitDiff|git_commit|land_verdict|git_land)["'`]/)
    }
  })

  test("[MUST-FAIL] on a gap, a landing waits for its verdict, and each wait names the next step: diff, then judge, then land", async () => {
    for (const x of ["request", "land_verdict", "git_land", "git_diff"]) served.add(x)
    const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
    const rows: any[] = [
      { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "G1", status: "open" },
      own({ shape: "channel", id: "ch1", calls: [] }, 2),
      own({ shape: "shape_schema", id: "sr", target: "request", variant: "gap", inputs: ["gap"], context: ["hop", "failure"] }, 3),
      own({ shape: "shape_schema", id: "sl", target: "land_verdict", inputs: ["world_changed", "gitDiff"] }, 4),
      own({ shape: "shape_schema", id: "slg", target: "land_verdict", variant: "gap", inputs: ["gap", "gitDiff"] }, 5),
      own({ shape: "requires", id: "q1", for: "git_land", needs: "change_wanted", where: { wanted: true } }, 6),
      own({ shape: "requires", id: "q2", for: "git_land", needs: "gap", where: { status: "open" }, latest_by: "gap_id" }, 7),
      own({ shape: "requires", id: "q3", for: "git_land", needs: "land_verdict", where: { r: 1 }, latest_by: "tree", group: "verdict" }, 8),
    ]
    const ask = (id: string, seq: number, type: string, refs: string[] = ["g1"]) =>
      ({ shape: "request", id, seq, role: "described", pointer: { type }, input_refs: refs })
    const go = async (pool: any[], skipped: any[] = []) => (await (applicable as any)(pool, skipped)).map((c: { id: string }) => c.id)
    // asked to land with no verdict: not called, and told what the landing waits for and what that is made from
    const s1: any[] = []
    const c1 = await go([...rows, ask("a1", 10, "git_land")], s1)
    expect(c1).not.toContain("call/git_land")
    expect(c1).not.toContain("produce/request/gap/ch1") // nothing new yet: the same request would be asked again
    expect(s1).toEqual([{ id: "a1", unserved: ["git_land (requires land_verdict; land_verdict is made from gitDiff, not yet here)"], of: "request" }])
    // the walk's row saying so is new information: the request is produced again, with the reason in view
    const skip = { shape: "failure", id: "f1", seq: 11, role: "walk", kind: "skip", request_ref: "a1", unserved: s1[0].unserved, selection_ref: "x", input_refs: ["x", "a1"] }
    expect(await go([...rows, ask("a1", 10, "git_land"), skip])).toContain("produce/request/gap/ch1")
    // asked for the diff: called; the diff in the root: the verdict is produced
    expect(await go([...rows, skip, ask("a2", 12, "git_diff", ["g1", "f1"])])).toContain("call/git_diff")
    const diff = { shape: "gitDiff", id: "d1", seq: 13, role: "walk", tree: "t".repeat(40), input_refs: ["g1"] }
    expect(await go([...rows, diff])).toContain("produce/land_verdict/gap/ch1")
    // a verdict at r 0 still holds the landing; at r 1 it is called
    const verdict = (r: number) => ({ shape: "land_verdict", id: `v${r}`, seq: 14, role: "described", tree: diff.tree, r, input_refs: ["g1", "d1"] })
    expect(await go([...rows, diff, verdict(0), ask("a3", 15, "git_land")])).not.toContain("call/git_land")
    expect(await go([...rows, diff, verdict(1), ask("a3", 15, "git_land")])).toContain("call/git_land")
  })

  test("[MUST-FAIL] a template run in this root is not run again over the same inputs: the request it led to is called instead", async () => {
    for (const x of ["git_worktree", "fs_edit"]) served.add(x)
    const gap = { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "G1", status: "open" }
    const t = { shape: "activity_template", id: "t1", seq: 2, role: "described", sig: { in: ["gap"], out: ["gitWorktree"] }, calls: [{ shape: "git_worktree", pointer: { repo: "r" } }] }
    const sel = { shape: "selection", id: "s1", seq: 3, role: "walk", a: "run/t1", root: "g1" }
    const ended = { shape: "hop", id: "h1", seq: 4, role: "walk", phase: "ended", kind: "run", selection_ref: "s1", call_id: "c1" }
    const ask = { shape: "request", id: "q1", seq: 5, role: "described", pointer: { type: "fs_edit", path: "a" }, input_refs: ["g1"] }
    const ids = async (rows: any[]) => (await (applicable as any)(rows)).map((c: { id: string }) => c.id)
    expect(await ids([gap, t])).toContain("run/t1") // never run here: offered
    const after = await ids([gap, t, sel, ended, ask])
    expect(after).not.toContain("run/t1") // run, and nothing it takes in came since: not again
    expect(after).toContain("call/fs_edit") // so the request it led to is what is called
    // a run that failed may run again; so may one when a row it takes in comes later
    const failed = { shape: "failure", id: "f1", seq: 4, role: "walk", selection_ref: "s1", status: 503 }
    expect(await ids([gap, t, sel, failed, ask])).toContain("run/t1")
    expect(await ids([gap, t, sel, ended, ask, { ...gap, id: "g2", seq: 6 }])).toContain("run/t1")
    // the live shape: a template that takes in selections. The walk's own next selection (the produce that wrote the
    // request) is not a new input, so the template is not run again and the request is called
    const live = { ...t, id: "t2", sig: { in: ["selection"], out: ["outcome"] } }
    const s1 = { shape: "selection", id: "s1b", seq: 3, role: "walk", a: "run/t2", root: "g1" }
    const h1 = { ...ended, id: "h1b", selection_ref: "s1b" }
    const s2 = { shape: "selection", id: "s2b", seq: 5, role: "walk", a: "produce/request/gap/ch1", root: "g1" }
    const q1 = { ...ask, id: "q1b", seq: 6 }
    expect(await ids([gap, live, s1])).not.toContain("run/t2") // its run's own selection is not new input
    const loop = await ids([gap, live, s1, h1, s2, q1])
    expect(loop).not.toContain("run/t2")
    expect(loop).toContain("call/fs_edit")
  })

  test("[MUST-FAIL] a precondition bound to the call's pointer is met only by a row about the same thing", async () => {
    served.add("fs_edit")
    const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner" })
    const gap = { shape: "gap", id: "g1", seq: 1, role: "detector", gap_id: "G1", status: "open" }
    const read = own({ shape: "requires", id: "qr", for: "fs_edit", needs: "fileContent", where: { path: { "x-pointer": "path" } }, latest_by: "path", group: "read" }, 2)
    const edit = (path?: string) => ({ shape: "request", id: "e1", seq: 5, role: "described", pointer: { type: "fs_edit", ...(path ? { path } : {}), old_string: "a", new_string: "b" }, input_refs: ["g1"] })
    const content = (path: string, seq: number) => ({ shape: "fileContent", id: `fc-${seq}`, seq, role: "walk", path, content: "a" })
    const calls = async (rows: any[], skipped: any[] = []) => (await (applicable as any)(rows, skipped)).map((c: { id: string }) => c.id).filter((id: string) => id === "call/fs_edit")
    // not read at all, or read at another path (an older clone's): the edit waits, and says for what
    // the live shape (root 14282): the old clone's read does not open an edit in the new clone
    const oldClone = "/workspace/git/walk-trees/local-tools-vessel-mwd3wldh-acdfc6bd/src/index.ts"
    const newClone = "/workspace/git/walk-trees/local-tools-vessel-mwd8l8ul-5e1f0a2b/src/index.ts"
    const s1: any[] = []
    expect(await calls([gap, read, edit(newClone)], s1)).toEqual([])
    expect(s1[0].unserved[0]).toContain("fs_edit (requires fileContent")
    const s2: any[] = []
    expect(await calls([gap, read, content(oldClone, 3), edit(newClone)], s2)).toEqual([])
    expect(s2[0].unserved[0]).toContain("fs_edit (requires fileContent")
    // read at the very path the edit names: offered
    expect(await calls([gap, read, content(newClone, 3), edit(newClone)])).toEqual(["call/fs_edit"])
    // an edit naming no path cannot meet a row bound to its path
    expect(await calls([gap, read, content(newClone, 3), edit()])).toEqual([])
  })

  test("[MUST-FAIL] preconditions in different groups must each be met: a group is a gate, its rows its alternatives", async () => {
    const wants = { shape: "requires", id: "rq1", seq: 7, role: "owner", for: "fileContent", needs: "change_wanted", where: { wanted: true } }
    const gapOpen = { shape: "requires", id: "rq2", seq: 8, role: "owner", for: "fileContent", needs: "gap", where: { status: "open" } }
    const judged = { shape: "requires", id: "rq3", seq: 9, role: "owner", for: "fileContent", needs: "verdict", where: { r: 1 }, group: "judged" }
    const gap = { shape: "gap", id: "g-open", seq: 10, role: "detector", status: "open" }
    const verdict = (r: number) => ({ shape: "verdict", id: `v${r}`, seq: 11, role: "described", r })
    const calls = async (rows: any[]) => (await applicable(rows)).map((c) => c.id).filter((id) => id === "call/fileContent")
    expect(await calls([...pool, wants, gapOpen, judged, gap])).toEqual([]) // the ungrouped gate is met, the "judged" one is not
    expect(await calls([...pool, wants, gapOpen, judged, gap, verdict(0)])).toEqual([])
    expect(await calls([...pool, wants, gapOpen, judged, gap, verdict(1)])).toEqual(["call/fileContent"])
    expect(await calls([...pool, wants, gapOpen, judged, verdict(1)])).toEqual([]) // and the ungrouped gate still counts
    const skipped: Array<{ id: string; unserved: string[] }> = []
    const t = { shape: "activity_template", id: "t-g", seq: 6, role: "described", sig: { in: ["world_changed"], out: ["fileContent"] }, calls: [{ shape: "fileContent", pointer: {} }] }
    await applicable([...pool, t, wants, gapOpen, judged, gap] as any, skipped)
    expect(skipped.find((x) => x.id === "t-g")?.unserved).toEqual(["fileContent (requires verdict)"])
  })

  test("[MUST-FAIL] a template calling a preconditioned shape is not run until the root meets it, and the skip says why", async () => {
    const req = { shape: "requires", id: "rq1", seq: 7, role: "owner", for: "fileContent", needs: "change_wanted", where: { wanted: true } }
    const t = { shape: "activity_template", id: "t-req", seq: 6, role: "described", sig: { in: ["world_changed"], out: ["fileContent"] }, calls: [{ shape: "fileContent", pointer: {} }] }
    const skipped: Array<{ id: string; unserved: string[] }> = []
    const ids = (await applicable([...pool, t, req] as any, skipped)).map((c) => c.id)
    expect(ids).not.toContain("run/t-req")
    expect(skipped.find((x) => x.id === "t-req")?.unserved).toEqual(["fileContent (requires change_wanted)"])
    const met = { shape: "change_wanted", id: "cw1", seq: 8, role: "described", wanted: true }
    expect((await applicable([...pool, t, req, met] as any)).map((c) => c.id)).toContain("run/t-req")
  })

  test("[MUST-FAIL] a later judgment revokes an earlier one: the root's latest row of the needed shape decides", async () => {
    const req = { shape: "requires", id: "rq1", seq: 7, role: "owner", for: "fileContent", needs: "change_wanted", where: { wanted: true } }
    const cw = (id: string, seq: number, wanted: boolean) => ({ shape: "change_wanted", id, seq, role: "described", wanted })
    const calls = async (rows: any[]) => (await applicable(rows)).map((c) => c.id).filter((id) => id === "call/fileContent")
    expect(await calls([...pool, req, cw("cw1", 8, true), cw("cw2", 9, false)])).toEqual([]) // revoked
    expect(await calls([...pool, req, cw("cw1", 8, false), cw("cw2", 9, true)])).toEqual(["call/fileContent"])
  })

  test("[MUST-FAIL] a newer owner precondition for the same call and shape replaces the older: the looser row it tightened no longer opens the call", async () => {
    const loose = { shape: "requires", id: "rq1", seq: 7, role: "owner", for: "fileContent", needs: "change_wanted", where: { wanted: true } }
    const tight = { shape: "requires", id: "rq1b", seq: 8, role: "owner", for: "fileContent", needs: "change_wanted", where: { wanted: true, repo: "r1" } }
    const cw = (repo?: string) => ({ shape: "change_wanted", id: "cw1", seq: 9, role: "described", wanted: true, ...(repo ? { repo } : {}) })
    const calls = async (rows: any[]) => (await applicable(rows)).map((c) => c.id).filter((id) => id === "call/fileContent")
    expect(await calls([...pool, loose, cw()])).toEqual(["call/fileContent"]) // the loose row alone: met, as before
    expect(await calls([...pool, loose, tight, cw()])).toEqual([]) // replaced: the loose row no longer meets it
    expect(await calls([...pool, loose, tight, cw("r1")])).toEqual(["call/fileContent"])
    const skipped: Array<{ id: string; unserved: string[] }> = []
    const t = { shape: "activity_template", id: "t-q", seq: 6, role: "described", sig: { in: ["world_changed"], out: ["fileContent"] }, calls: [{ shape: "fileContent", pointer: {} }] }
    await applicable([...pool, t, loose, tight, cw()] as any, skipped)
    expect(skipped.find((x) => x.id === "t-q")?.unserved).toEqual(["fileContent (requires change_wanted)"])
  })

  test("[MUST-FAIL] a precondition the owner retires counts no more, and does not bring back the row it replaced", async () => {
    const wants = { shape: "requires", id: "rq1", seq: 7, role: "owner", for: "fileContent", needs: "change_wanted", where: { wanted: true } }
    const gone = { shape: "requires", id: "rq1r", seq: 8, role: "owner", for: "fileContent", needs: "change_wanted", where: { wanted: true }, retired: true }
    const gapOpen = { shape: "requires", id: "rq2", seq: 9, role: "owner", for: "fileContent", needs: "gap", where: { status: "open" } }
    const cw = { shape: "change_wanted", id: "cw1", seq: 10, role: "described", wanted: true }
    const calls = async (rows: any[]) => (await applicable(rows)).map((c) => c.id).filter((id) => id === "call/fileContent")
    expect(await calls([...pool, wants, gapOpen, cw])).toEqual(["call/fileContent"]) // before retiring: the ask opens it
    expect(await calls([...pool, wants, gone, gapOpen, cw])).toEqual([]) // retired: only an open gap does
    expect(await calls([gone, ...pool, gapOpen, cw, wants])).toEqual([]) // by seq, not by order in the pool: the retired row comes first
    expect(await calls([...pool, wants, gone, gapOpen, { shape: "gap", id: "g1", seq: 12, role: "detector", status: "open" }])).toEqual(["call/fileContent"])
  })

  test("[MUST-FAIL] a retired gate no longer makes its judge judge again", async () => {
    const gate = { shape: "requires", id: "rq-j", seq: 2, role: "owner", for: "fileContent", needs: "answer", where: { ok: true } }
    const gone = { ...gate, id: "rq-jr", seq: 3, retired: true }
    const schema = { shape: "shape_schema", id: "s-a10", seq: 10, role: "owner", target: "answer", inputs: ["world_changed"] }
    const old = { shape: "answer", id: "a-old", seq: 5, role: "described", input_refs: ["w1"] }
    expect(await ids([ask, ch, gate, schema, old])).toContain("produce/answer/ch1") // a live gate: judged again, as before
    expect(await ids([ask, ch, gate, gone, schema, old])).not.toContain("produce/answer/ch1")
  })

  test("[MUST-FAIL] rows that speak for different things are judged each by its own latest: another gap's newer row does not hide this one", async () => {
    const req = { shape: "requires", id: "rq2", seq: 7, role: "owner", for: "fileContent", needs: "gap", where: { status: "open" }, latest_by: "gap_id" }
    const gap = (id: string, seq: number, gapId: string, status: string) => ({ shape: "gap", id, seq, role: "detector", gap_id: gapId, status })
    const calls = async (rows: any[]) => (await applicable(rows)).map((c) => c.id).filter((id) => id === "call/fileContent")
    // an older open gap A and a newer closed gap B: A's latest is open, so the requirement is met
    expect(await calls([...pool, req, gap("ga", 8, "A", "open"), gap("gb", 9, "B", "closed")])).toEqual(["call/fileContent"])
    // A's own later row closing it: A's latest is closed, B is closed: unmet
    expect(await calls([...pool, req, gap("ga", 8, "A", "open"), gap("gb", 9, "B", "closed"), gap("ga2", 10, "A", "closed")])).toEqual([])
  })

  test("[MUST-FAIL] a gate's judge that changed judges again: a schema row newer than the root's last judgment offers it once more", async () => {
    // the fake discovery serves answer; a requires row needing it makes it a gate's judgment here
    const gate = { shape: "requires", id: "rq-j", seq: 2, role: "owner", for: "fileContent", needs: "answer", where: { ok: true } }
    const schema = (seq: number) => ({ shape: "shape_schema", id: `s-a${seq}`, seq, role: "owner", target: "answer", inputs: ["world_changed"] })
    const a = (id: string, seq: number) => ({ shape: "answer", id, seq, role: "described", input_refs: ["w1"] })
    // the root's judgment was made before the owner rewrote the schema: offered again
    expect(await ids([ask, ch, gate, schema(10), a("a-old", 5)])).toContain("produce/answer/ch1")
    // once the root holds a judgment made after the schema, it is held back as before (once per schema change)
    expect(await ids([ask, ch, gate, schema(10), a("a-old", 5), a("a-new", 12)])).not.toContain("produce/answer/ch1")
    // with the judgment newer than the schema to begin with, nothing changes (a guard)
    expect(await ids([ask, ch, gate, schema(3), a("a-old", 5)])).not.toContain("produce/answer/ch1")
  })

  test("a newer schema for a shape no gate reads offers nothing again: an answer is not sent twice, a deadline not moved (a guard)", async () => {
    const schema = { shape: "shape_schema", id: "s-a10", seq: 10, role: "owner", target: "answer", inputs: ["world_changed"] }
    const old = { shape: "answer", id: "a-old", seq: 5, role: "described", input_refs: ["w1"] }
    expect(await ids([ask, ch, schema, old])).not.toContain("produce/answer/ch1")
  })

  test("[MUST-FAIL] what a tick cost is only in timing: two selections that differ in it alone are the same choice", async () => {
    const { selectionRow } = await import("../src/loop")
    const option = { cand: { id: "call/fileContent", kind: "call", pointer: {}, calls: [], t: "" }, pool: [...pool], context: ["world_changed", "asker:person", "age:0"], cell: "call/fileContent|world_changed,asker:person,age:0", skipped: [], root: "w1" }
    const post = { at_seq: 9, posts: [{ cell: option.cell, alpha: 1, beta: 1 }] }
    const fast = { episodes_ms: 1, episodes_reads: 1, choices_ms: 2, posterior_ms: 3, posterior_reads: 1, draw_ms: 0, cands: 1, cells: 1 }
    const slow = { episodes_ms: 9000, episodes_reads: 4, choices_ms: 800, posterior_ms: 7000, posterior_reads: 2, draw_ms: 5, cands: 1, cells: 1 }
    const a = selectionRow("treated", [option as any], post, 7, 0, fast)
    const b = selectionRow("treated", [option as any], post, 7, 0, slow)
    const { timing: ta, ...restA } = a as Record<string, unknown>
    const { timing: tb, ...restB } = b as Record<string, unknown>
    expect(ta).toEqual(fast)
    expect(tb).toEqual(slow)
    expect(restA).toEqual(restB) // the cell, its context, pool_refs, input_refs, a, from and root are untouched by timing
    // and the walk offers the same moves whether the pool holds the fast or the slow selection
    const sel = (t: object, id: string) => ({ ...(selectionRow("treated", [option as any], post, 7, 0, t as any)), id, seq: 20, role: "walk", writer: "walk" })
    const ids = async (s: object) => (await applicable([...pool, s] as any)).map((c) => c.id).sort()
    expect(await ids(sel(fast, "s1"))).toEqual(await ids(sel(slow, "s1")))
  })

  test("a precondition row not written by the owner binds nothing (a guard)", async () => {
    const forged = { shape: "requires", id: "rq9", seq: 7, role: "walk", for: "fileContent", needs: "change_wanted", where: { wanted: true } }
    expect((await applicable([...pool, forged] as any)).map((c) => c.id)).toContain("call/fileContent")
  })

  test("producers are asked of discovery as vesselCapability, by shape", () => {
    expect(asked.length).toBeGreaterThan(0)
    for (const p of asked) expect(p.type).toBe("vesselCapability")
  })
})

describe("walk vessel process", () => {
  let discovery: Fake
  let port: number
  let vessel: ReturnType<typeof run>

  beforeAll(async () => {
    // /resolve never answers, so the walk stays parked on its first records call.
    discovery = fake((path) =>
      path === "/resolve" ? new Promise<Response>(() => {}) : Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true }))
    port = freePort()
    vessel = run("src/index.ts", {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: String(port), DISCOVERY_URL: discovery.url,
      WALK_ENDPOINT: `http://127.0.0.1:${port}`, METABOB_API_KEY: NODE_KEY,
    })
    await healthy(port)
    for (let i = 0; i < 200 && !discovery.seen.some((s) => s.path === "/resolve"); i++) await Bun.sleep(25)
  })

  afterAll(() => {
    vessel?.kill()
    discovery?.stop()
  })

  test("/health answers 200 with the vessel id only", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/health`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ vessel: "walk-test" })
  })

  test("[MUST-FAIL] the shape it registers is answered: walk_heartbeat says it is alive; any other shape is not served", async () => {
    const ask = (body: unknown) => fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    const hb = await ask({ impulse: { pointer: { type: "walk_heartbeat" } } })
    expect(hb.status).toBe(200)
    expect(await hb.json()).toEqual({ vessel: "walk-test", alive: true })
    expect((await ask({ pointer: { type: "walk_heartbeat" } })).status).toBe(200)
    const other = await ask({ impulse: { pointer: { type: "answer" } } })
    expect(other.status).toBe(404)
    expect(String(((await other.json()) as { error: string }).error)).toContain("not served")
    // a path with no route answers a bare 404, which a caller can tell apart from the walk saying no
    const none = await fetch(`http://127.0.0.1:${port}/no-such-route`, { method: "POST" })
    expect(none.status).toBe(404)
    expect(await none.text()).toBe("")
  })

  test("registers under the node key, with no forward time limit", () => {
    const reg = discovery.seen.find((s) => s.path === "/register")
    expect(reg?.auth).toBe(`ApiKey ${NODE_KEY}`)
    expect((reg?.body as { resolve_timeout_ms: number }).resolve_timeout_ms).toBe(2147483647)
  })

  test("[MUST-FAIL] describes the rows it writes as written, never as shapes it serves", () => {
    const body = discovery.seen.find((s) => s.path === "/register")?.body as {
      shapes: string[]; writes: string[]; shape_descriptions: Record<string, string>
    }
    expect([...body.writes].sort()).toEqual(["failure", "hop", "selection"])
    for (const w of body.writes) {
      expect(body.shapes).not.toContain(w)
      expect(body.shape_descriptions[w]?.length ?? 0).toBeGreaterThan(0)
    }
    expect(body.shape_descriptions.hop).toContain("pointer_type")
    expect(body.shape_descriptions.hop).toContain("never a shape to call")
    expect(body.shape_descriptions.hop).toContain("until")
    expect(body.shape_descriptions.selection).toContain("arm")
    for (const w of body.writes) expect(body.shape_descriptions[w].length).toBeLessThanOrEqual(1024)
  })

  test("its first call goes to discovery /resolve by shape: the wait for its own arm row", () => {
    const first = discovery.seen.find((s) => s.path === "/resolve")
    expect(first?.auth).toBe(`ApiKey ${NODE_KEY}`)
    expect(first?.body).toEqual({ pointer: { shapes: ["arm"], after_seq: 0, where: { vessel_id: "walk-test" }, type: "record_wait_exact" } })
  })

  test("a missing boot value exits 1 and names it, never its value", async () => {
    const { code, stderr } = await exitsNaming("src/index.ts", {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: String(freePort()), DISCOVERY_URL: discovery.url, WALK_ENDPOINT: "x",
    })
    expect(code).toBe(1)
    expect(stderr).toContain("missing env METABOB_API_KEY")
    expect(stderr).not.toContain(NODE_KEY)
  })
})

describe("what records answers is used only when it is the shape asked for", () => {
  beforeAll(() => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
  })

  test("[MUST-FAIL] an arm row needs a named arm and a finite as_of_seq; an episodes answer needs roots and shared; a posterior one post per cell", async () => {
    const { isArm, isEpisodes, isPosterior } = await import("../src/loop")
    for (const bad of [null, undefined, {}, { ok: true }, { arm: "treated" }, { arm: "treated", as_of_seq: "99" }, { arm: "", as_of_seq: 1 }, { arm: "treated", as_of_seq: Number.NaN }, [{ arm: "treated", as_of_seq: 1 }]]) {
      expect([bad, isArm(bad)]).toEqual([bad, false])
    }
    expect(isArm({ shape: "arm", arm: "treated", as_of_seq: 99 })).toBe(true)
    for (const bad of [null, {}, { ok: true }, { roots: [] }, { shared: [] }, "x"]) expect([bad, isEpisodes(bad)]).toEqual([bad, false])
    expect(isEpisodes([])).toBe(true)
    expect(isEpisodes({ shared: [], roots: [] })).toBe(true)
    expect(isPosterior(2)({ at_seq: 3, posts: [{}, {}] })).toBe(true)
    for (const bad of [{ at_seq: 3, posts: [{}] }, { at_seq: Number.NaN, posts: [{}, {}] }, { posts: [{}, {}] }, null, { ok: true }]) expect([bad, isPosterior(2)(bad)]).toEqual([bad, false])
  })

  test("[MUST-FAIL] readUntil reads again after a pause until the answer is the shape asked for, and says so once a minute", async () => {
    const { readUntil, isArm } = await import("../src/loop")
    const answers: unknown[] = [{ ok: true }, null, { shape: "arm", arm: "treated", as_of_seq: 7 }]
    const pauses: number[] = []
    const logged: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => { logged.push(a.join(" ")) }
    try {
      const got = await readUntil(async () => answers.shift(), isArm, "arm row", async (ms) => { pauses.push(ms) }, () => 0, () => { throw new Error("gave up") })
      expect(got).toEqual({ shape: "arm", arm: "treated", as_of_seq: 7 })
    } finally { console.log = log }
    expect(pauses).toEqual([2000, 2000])
    expect(logged).toEqual(["[walk] records answered no arm row; reading again (0 s)"])
  })

  test("[MUST-FAIL] a wait that never gets the right shape is said every 20 s and ends after READ_WAIT_MS with a stop the unit restarts", async () => {
    const { readUntil, isArm, READ_WAIT_MS } = await import("../src/loop")
    let t = 0
    let gaveUp = 0
    const logged: string[] = []
    const errors: string[] = []
    const [log, err] = [console.log, console.error]
    console.log = (...a: unknown[]) => { logged.push(a.join(" ")) }
    console.error = (...a: unknown[]) => { errors.push(a.join(" ")) }
    try {
      // The stand-in refuses past 200 reads: with no bound, the loop would spin on the fake clock and fill memory.
      let reads = 0
      const read = async () => { if (++reads > 200) throw new Error("read again past any bound: the wait has no end"); return { ok: true, why: "x" } }
      const got = await readUntil(read, isArm, "arm row", async (ms) => { t += ms }, () => t, () => { gaveUp++ })
      expect(got).toBeUndefined()
    } finally { [console.log, console.error] = [log, err] }
    expect(READ_WAIT_MS).toBe(60_000)
    expect(gaveUp).toBe(1)
    expect(logged).toEqual(["0 s", "20 s", "40 s"].map((n) => `[walk] records answered no arm row; reading again (${n})`))
    expect(errors).toEqual(["[walk] records answered no arm row for 60 s (last: an object with keys [ok,why]); stopping so the unit restarts"])
    const { shapeOf } = await import("../src/loop")
    expect([shapeOf(null), shapeOf([1, 2]), shapeOf("s"), shapeOf({ secret: "v" })]).toEqual(["null", "a list of 2", "string", "an object with keys [secret]"])
  })
})

describe("a records that answers a non-row while it restarts", () => {
  let discovery: Fake
  let vessel: ReturnType<typeof run>
  let selection: Record<string, any> | undefined
  let printed = ""
  const asked: Record<string, number> = {}

  beforeAll(async () => {
    const pool = [
      { shape: "world_changed", id: "w1", seq: 2, writer: "kid-person", role: "person", what: "x", t: new Date().toISOString() },
      { shape: "channel", id: "ch1", seq: 3, writer: "owner", role: "owner", calls: [] },
      { shape: "shape_schema", id: "s1", seq: 4, writer: "owner", role: "owner", target: "answer", inputs: ["world_changed"] },
    ]
    // The first answer to each read is what discovery gave while records re-registered: a 200 that is no row.
    const first = (k: string) => { asked[k] = (asked[k] ?? 0) + 1; return asked[k] === 1 }
    discovery = fake((path, body) => {
      if (path !== "/resolve") return Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true })
      const p = body.pointer
      if (p.type === "record_wait_exact") return Response.json(first("arm") ? { ok: true } : { shape: "arm", id: "arm1", seq: 1, arm: "treated", as_of_seq: 99 })
      if (p.type === "record_read" && p.roots === "all") {
        return Response.json(first("episodes") ? { ok: true } : { shared: pool.slice(1, 3), roots: [{ root: pool[0], rows: [pool[0]] }] })
      }
      if (p.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "v" }] } })
      if (p.type === "shapeDescriptions") return Response.json({ shape_answers: {} })
      if (p.type === "posterior") return Response.json(first("posterior") ? {} : { at_seq: 6, posts: p.cells.map(() => ({ alpha: 2, beta: 1, from: "move" })) })
      if (p.type === "record_write" && p.row?.shape === "selection" && !selection) selection = p.row
      if (p.type === "record_write") return Response.json({ ...p.row, id: `r${Math.random()}`, seq: 7 })
      return new Promise<Response>(() => {})
    })
    const port = freePort()
    vessel = run("src/index.ts", {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: String(port), DISCOVERY_URL: discovery.url,
      WALK_ENDPOINT: `http://127.0.0.1:${port}`, METABOB_API_KEY: NODE_KEY,
    })
    void (async () => { const d = new TextDecoder(); for await (const c of vessel.stdout as any) printed += d.decode(c, { stream: true }) })()
    await healthy(port)
    for (let i = 0; i < 600 && !selection; i++) await Bun.sleep(25)
  }, 30_000)

  afterAll(() => {
    vessel?.kill()
    discovery?.stop()
  })

  test("[MUST-FAIL] the walk waits out the non-rows and draws with its real arm and the evidence records gave, without stopping", () => {
    expect(asked.arm ?? 0).toBeGreaterThanOrEqual(2)
    expect(asked.episodes ?? 0).toBeGreaterThanOrEqual(2)
    expect(selection?.arm).toBe("treated")
    expect(selection?.posts_seq).toBe(6)
    for (const p of selection?.posts ?? [undefined]) expect(p).toEqual({ alpha: 2, beta: 1, from: "move" })
    expect(vessel.exitCode).toBeNull()
    for (const what of ["arm row", "episodes", "posterior"]) expect(printed).toContain(`[walk] records answered no ${what}; reading again`)
  })
})

describe("a records that never answers the shape asked for", () => {
  let discovery: Fake
  let vessel: ReturnType<typeof run>
  let printed = ""
  let code: number | null = null

  beforeAll(async () => {
    discovery = fake((path, body) => {
      if (path !== "/resolve") return Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true })
      if (body.pointer.type === "record_wait_exact") return Response.json({ ok: true })
      return new Promise<Response>(() => {})
    })
    const port = freePort()
    vessel = run("src/index.ts", {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: String(port), DISCOVERY_URL: discovery.url,
      WALK_ENDPOINT: `http://127.0.0.1:${port}`, METABOB_API_KEY: NODE_KEY,
    })
    void (async () => { const d = new TextDecoder(); for await (const c of vessel.stderr as any) printed += d.decode(c, { stream: true }) })()
    code = await Promise.race([vessel.exited, Bun.sleep(80_000).then(() => null)])
  }, 90_000)

  afterAll(() => {
    vessel?.kill()
    discovery?.stop()
  })

  test("[MUST-FAIL] the walk exits non-zero within the bound, naming what it got, so its unit restarts it", () => {
    expect(code).not.toBeNull()
    expect(code).not.toBe(0)
    expect(printed).toContain("[walk] records answered no arm row for 6")
    expect(printed).toContain("(last: an object with keys [ok]); stopping so the unit restarts")
  })
})

describe("cell context", () => {
  let discovery: Fake
  let vessel: ReturnType<typeof run>
  let cells: string[] = []
  let selection: Record<string, any> | undefined

  beforeAll(async () => {
    const pool = [
      { shape: "world_changed", id: "w1", seq: 2, writer: "kid-person", role: "person", what: "x", t: new Date().toISOString() },
      { shape: "channel", id: "ch1", seq: 3, writer: "owner", role: "owner", calls: [] },
      { shape: "shape_schema", id: "s1", seq: 4, writer: "owner", role: "owner", target: "answer", inputs: ["world_changed"] },
      { shape: "selection", id: "own1", seq: 5, writer: "walk-test", role: "walk" },
      { shape: "failure", id: "own2", seq: 6, writer: "walk-test", role: "walk" },
    ]
    discovery = fake((path, body) => {
      if (path !== "/resolve") return Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true })
      const p = body.pointer
      if (p.type === "record_wait_exact") return Response.json({ shape: "arm", id: "arm1", seq: 1, arm: "treated", as_of_seq: 99 })
      if (p.type === "record_read" && p.roots === "all") {
        return Response.json({ shared: pool.slice(1, 3), roots: [{ root: pool[0], rows: [pool[0], ...pool.slice(3)] }] })
      }
      if (p.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "v" }] } })
      if (p.type === "shapeDescriptions") return Response.json({ shape_answers: {} })
      if (p.type === "posterior") {
        if (cells.length === 0) cells = p.cells
        return Response.json({ at_seq: 6, posts: p.cells.map(() => ({ alpha: 1, beta: 1, from: "move" })) })
      }
      if (p.type === "record_write" && p.row?.shape === "selection" && !selection) selection = p.row
      if (p.type === "record_write") return Response.json({ ...p.row, id: `r${Math.random()}`, seq: 7 })
      return new Promise<Response>(() => {})
    })
    const port = freePort()
    vessel = run("src/index.ts", {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: String(port), DISCOVERY_URL: discovery.url,
      WALK_ENDPOINT: `http://127.0.0.1:${port}`, METABOB_API_KEY: NODE_KEY,
    })
    await healthy(port)
    for (let i = 0; i < 200 && (cells.length === 0 || !selection); i++) await Bun.sleep(25)
  })

  afterAll(() => {
    vessel?.kill()
    discovery?.stop()
  })

  test("[MUST-FAIL] the selection row keeps the level of evidence each posterior came from", () => {
    expect(selection?.posts?.length ?? 0).toBeGreaterThan(0)
    for (const p of selection!.posts) expect(p).toEqual({ alpha: 1, beta: 1, from: "move" })
  })

  test("[MUST-FAIL] a cell's context is the shapes the move reads among rows the walk did not write, then the root's asker and age", () => {
    expect(cells.length).toBeGreaterThan(0)
    for (const c of cells) expect(c.split("|")[1]).toBe("world_changed,asker:person,age:0")
    expect(selection?.cell_scheme).toBe("reads")
  })

  test("[MUST-FAIL] the selection row carries what the tick cost: each part's ms and each read's tries", () => {
    const t = selection?.timing
    expect(t).toBeDefined()
    for (const k of ["episodes_ms", "choices_ms", "posterior_ms", "draw_ms"]) expect(t[k]).toBeGreaterThanOrEqual(0)
    expect(t.episodes_reads).toBeGreaterThanOrEqual(1)
    expect(t.posterior_reads).toBeGreaterThanOrEqual(1)
    expect(t.cands).toBeGreaterThanOrEqual(1)
    expect(t.cells).toBeGreaterThanOrEqual(1)
  })
})

describe("the declared answers read", () => {
  test("[MUST-FAIL] a discovery that refuses the shapeDescriptions read leaves the walk going, with no answers", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("unavailable", { status: 500 })) as typeof fetch
    const exit = process.exit
    let exited = false
    process.exit = ((() => { exited = true }) as unknown) as typeof process.exit
    try {
      const { shapeAnswers } = await import("../src/calls")
      expect(await shapeAnswers()).toEqual({})
      expect(exited).toBe(false)
    } finally {
      globalThis.fetch = realFetch
      process.exit = exit
    }
  })
})

describe("a stop mid-call", () => {
  test("[MUST-FAIL] a SIGTERM ends the call in flight as a failure the callee is blamed for, then exits 0", async () => {
    const rows: Array<Record<string, any>> = []
    const pool = [
      { shape: "world_changed", id: "w1", seq: 2, writer: "kid-person", role: "person", what: "x", t: new Date().toISOString() },
      { shape: "channel", id: "ch1", seq: 3, writer: "owner", role: "owner", calls: [] },
      { shape: "shape_schema", id: "s1", seq: 4, writer: "owner", role: "owner", target: "answer", inputs: ["world_changed"] },
    ]
    const discovery = fake((path, body) => {
      if (path !== "/resolve") return Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true })
      const p = body.pointer
      if (p.type === "record_wait_exact") return Response.json({ shape: "arm", id: "arm1", seq: 1, arm: "treated", as_of_seq: 99 })
      if (p.type === "record_read" && p.roots === "all") return Response.json({ shared: pool.slice(1), roots: [{ root: pool[0], rows: [pool[0]] }] })
      if (p.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "v" }] } })
      if (p.type === "shapeDescriptions") return Response.json({ shape_answers: {} })
      if (p.type === "posterior") return Response.json({ at_seq: 6, posts: p.cells.map(() => ({ alpha: 1, beta: 1 })) })
      if (p.type === "record_write") {
        rows.push(p.row)
        return Response.json({ ...p.row, id: `r${rows.length}`, seq: 10 + rows.length })
      }
      return new Promise<Response>(() => {}) // the produce never comes back: it is in flight when the stop comes
    })
    const port = freePort()
    const vessel = run("src/index.ts", {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: String(port), DISCOVERY_URL: discovery.url,
      WALK_ENDPOINT: `http://127.0.0.1:${port}`, METABOB_API_KEY: NODE_KEY,
    })
    try {
      await healthy(port)
      await until(() => rows.some((r) => r.shape === "hop" && r.phase === "started"), "a started hop")
      const started = rows.find((r) => r.shape === "hop" && r.phase === "started")!
      vessel.kill("SIGTERM")
      expect(await vessel.exited).toBe(0)
      const ends = rows.filter((r) => r.call_id === started.call_id && r !== started)
      expect(ends).toHaveLength(1)
      expect(ends[0]).toMatchObject({ shape: "failure", status: 0, selection_ref: started.selection_ref })
      expect("kind" in ends[0]).toBe(false)
      // nothing new is chosen once stopping
      expect(rows.filter((r) => r.shape === "selection")).toHaveLength(1)
    } finally {
      vessel.kill()
      discovery.stop()
    }
  })
})

describe("a template the walk will not run", () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })

  test("[MUST-FAIL] leaves one failure row naming the unserved shapes, once per template in the episode", async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    const written: Array<Record<string, any>> = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      if (pointer.type === "record_write") written.push(pointer.row)
      return Response.json({ ...pointer.row, id: "r", seq: 1 })
    }) as typeof fetch
    const { recordSkipped } = await import("../src/calls")
    const sel = { shape: "selection", id: "sel-3", seq: 11 } as any
    await recordSkipped([], [{ id: "t-hop", unserved: ["hop"] }], sel)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ shape: "failure", kind: "skip", template_ref: "t-hop", unserved: ["hop"], selection_ref: "sel-3" })
    expect("call_id" in written[0] || "status" in written[0]).toBe(false)
    expect(String(written[0].body)).toContain("hop")
    const earlier = { shape: "failure", id: "f1", seq: 12, kind: "skip", template_ref: "t-hop", unserved: ["hop"] } as any
    await recordSkipped([earlier], [{ id: "t-hop", unserved: ["hop"] }], sel)
    expect(written).toHaveLength(1)
  })

  test("[MUST-FAIL] a request its call must wait for is said once per reason, naming the request", async () => {
    const written: Array<Record<string, any>> = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      if (pointer.type === "record_write") written.push(pointer.row)
      return Response.json({ ...pointer.row, id: "r", seq: 1 })
    }) as typeof fetch
    const { recordSkipped } = await import("../src/calls")
    const sel = { shape: "selection", id: "sel-5", seq: 20 } as any
    const why = ["git_land (requires land_verdict)"]
    await recordSkipped([], [{ id: "a1", unserved: why, of: "request" }], sel)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ shape: "failure", kind: "skip", request_ref: "a1", unserved: why, selection_ref: "sel-5", input_refs: ["sel-5", "a1"] })
    expect("template_ref" in written[0]).toBe(false)
    expect(String(written[0].body)).toContain("request a1 cannot be called yet")
    const told = { shape: "failure", id: "f9", seq: 21, kind: "skip", request_ref: "a1", unserved: why } as any
    await recordSkipped([told], [{ id: "a1", unserved: why, of: "request" }], sel)
    expect(written).toHaveLength(1) // the same reason: nothing
    await recordSkipped([told], [{ id: "a1", unserved: ["git_land (requires gap)"], of: "request" }], sel)
    expect(written).toHaveLength(2) // a new reason: said
  })

  test("[MUST-FAIL] a template skipped for a new reason says so once; the reason its latest row gives writes nothing", async () => {
    const written: Array<Record<string, any>> = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      if (pointer.type === "record_write") written.push(pointer.row)
      return Response.json({ ...pointer.row, id: "r", seq: 1 })
    }) as typeof fetch
    const { recordSkipped } = await import("../src/calls")
    const sel = { shape: "selection", id: "sel-4", seq: 13 } as any
    const old = { shape: "failure", id: "f2", seq: 10, kind: "skip", template_ref: "t1", unserved: ["outcome", "answer"] } as any
    await recordSkipped([old], [{ id: "t1", unserved: ["answer (no channel)"] }], sel)
    expect(written.map((r) => r.unserved)).toEqual([["answer (no channel)"]])
    const now = { ...old, id: "f3", seq: 14, unserved: ["answer (no channel)"] }
    await recordSkipped([old, now], [{ id: "t1", unserved: ["answer (no channel)"] }], sel)
    expect(written).toHaveLength(1) // the same reason as the latest row: nothing
    await recordSkipped([old, now], [{ id: "t1", unserved: ["answer", "outcome"] }], sel) // back to the old reason
    expect(written).toHaveLength(2)
  })
})

describe("a wait-for's row", () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })

  test("[MUST-FAIL] records the until it waited by, and nothing when the wait has none", async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    const written: Array<Record<string, any>> = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      if (pointer.type === "record_write") { written.push(pointer.row); return Response.json({ ...pointer.row, id: "r", seq: 1 }) }
      return Response.json(null)
    }) as typeof fetch
    const { execute } = await import("../src/calls")
    const sel = { shape: "selection", id: "sel-4", seq: 12, posts_seq: 3 } as any
    await execute({ id: "wait-for", kind: "wait-for", pointer: { shapes: [], until: 1_900_000_000_000 }, calls: [], t: "" }, sel)
    expect(written.find((r) => r.shape === "hop" && r.phase === "started")?.until).toBe(1_900_000_000_000)
    written.length = 0
    await execute({ id: "wait-for", kind: "wait-for", pointer: { shapes: [] }, calls: [], t: "" }, sel)
    expect("until" in (written.find((r) => r.shape === "hop" && r.phase === "started") ?? {})).toBe(false)
  })
})

describe("a learned template's calls", () => {
  const realFetch = globalThis.fetch
  const sent: Array<Record<string, any>> = []

  afterAll(() => {
    globalThis.fetch = realFetch
  })

  test("[MUST-FAIL] a call names the selection it is made for, as a template's calls do", async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    const seen: Array<Record<string, any>> = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      seen.push(pointer)
      return Response.json(pointer.type === "record_write" ? { ...pointer.row, id: "r", seq: 1 } : { shape: "gitWorktree", cwd: "/x" })
    }) as typeof fetch
    const { execute } = await import("../src/calls")
    const sel = { shape: "selection", id: "sel-7", seq: 9, pool_refs: ["w1"] }
    await execute({ id: "call/git_worktree", kind: "call", pointer: { type: "git_worktree", repo: "super" }, t: "", calls: [] }, sel)
    const call = seen.find((p) => p.type === "git_worktree")
    expect(call?.selection_ref).toBe("sel-7")
    expect(call?.repo).toBe("super")
  })

  test("[MUST-FAIL] a forwarded call carries no declared writer or role: the walk cannot write as the owner, a detector or a grader", async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    const seen: Array<Record<string, any>> = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      seen.push(pointer)
      return Response.json(pointer.type === "record_write" ? { ...pointer.row, id: "r", seq: 1 } : { ok: true })
    }) as typeof fetch
    const { execute } = await import("../src/calls")
    const sel = { shape: "selection", id: "sel-9", seq: 9, pool_refs: ["w1"] }
    const verdict = { shape: "land_verdict", r: 1, tree: "t1", repo: "demo" }
    await execute({ id: "call/record_write", kind: "call", pointer: { type: "record_write", row: verdict, writer: "described-x", role: "described" }, t: "", calls: [] }, sel)
    await execute({ id: "run/t", kind: "run", pointer: {}, t: "", calls: [
      { shape: "record_write", pointer: { row: { shape: "shape_schema", target: "x" }, writer: "owner", role: "owner" } },
      { shape: "record_write", pointer: { row: { shape: "gap", gap_id: "g", status: "closed" }, writer: "pull-sync", role: "detector" } },
    ] }, sel)
    const forwarded = seen.filter((p) => p.type === "record_write" && p.row?.shape !== "hop" && p.row?.shape !== "failure")
    expect(forwarded.map((p) => p.row.shape)).toEqual(["land_verdict", "shape_schema", "gap"])
    for (const p of forwarded) {
      expect("writer" in p).toBe(false)
      expect("role" in p).toBe(false)
    }
    // control: the walk's own rows (hops) are still written as the walk
    const own = seen.filter((p) => p.type === "record_write" && p.row?.shape === "hop")
    expect(own.length).toBeGreaterThan(0)
    for (const p of own) expect([p.writer, p.role]).toEqual(["walk-test", "walk"])
  })

  test("carry the selection, its pool and their own call id, as a produce does", async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      sent.push(pointer)
      return Response.json(pointer.type === "record_write" ? { ...pointer.row, id: "r", seq: 1 } : { ok: true })
    }) as typeof fetch
    const { execute } = await import("../src/calls")
    const sel = { shape: "selection", id: "sel-1", seq: 9, pool_refs: ["w1", "ch1"] }
    await execute({ id: "run/t1", kind: "run", pointer: {}, t: "", calls: [
      { shape: "answer", pointer: { via_ref: "ch1" } },
      { shape: "outcome", pointer: { via_ref: "ch1" } },
    ] }, sel)
    const calls = sent.filter((p) => p.type === "answer" || p.type === "outcome")
    expect(calls.map((p) => p.type)).toEqual(["answer", "outcome"])
    for (const p of calls) {
      expect(p.selection_ref).toBe("sel-1")
      expect(p.input_refs).toEqual(["w1", "ch1"])
      expect(p.via_ref).toBe("ch1")
      expect(typeof p.call_id).toBe("string")
    }
    expect(calls[0].call_id).not.toBe(calls[1].call_id)
  })

  test("[MUST-FAIL] a 200 answer that carries an error, in a forward's envelope or at the top, is a failure row and stops the template", async () => {
    sent.length = 0
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      sent.push(pointer)
      if (pointer.type === "record_write") return Response.json({ ...pointer.row, id: "r", seq: 1 })
      // The shape of the one error-bearing ENDED hop on a running node (2122): a forward's envelope, the error under content.
      if (pointer.type === "answer") return Response.json({ content: { error: "unauthorized", shape: "answer" }, metadata: { forwarded: true } })
      return Response.json(pointer.type === "outcome" ? { error: "provider refused" } : { ok: true })
    }) as typeof fetch
    const { execute } = await import("../src/calls")
    await execute({ id: "run/t2", kind: "run", pointer: {}, t: "", calls: [
      { shape: "answer", pointer: { via_ref: "ch1" } },
      { shape: "outcome", pointer: { via_ref: "ch1" } },
    ] }, { shape: "selection", id: "sel-2", seq: 10, pool_refs: ["w1"] })
    const rows = sent.filter((p) => p.type === "record_write").map((p) => p.row)
    expect(rows.some((r) => r.shape === "failure" && String(r.body).includes("unauthorized"))).toBe(true)
    expect(rows.some((r) => r.shape === "hop" && r.phase === "ended")).toBe(false)
    expect(sent.some((p) => p.type === "outcome")).toBe(false)
  })

  test("[MUST-FAIL] a tool's answer naming its own shape is recorded as a row; one naming a shape others serve is not", async () => {
    sent.length = 0
    const servedBy: Record<string, string> = { git_diff: "tools", git_status: "tools", gitDiff: "tools", request: "described", fs_read: "tools" }
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      sent.push(pointer)
      if (pointer.type === "record_write") return Response.json({ ...pointer.row, id: "r", seq: 1 })
      if (pointer.type === "vesselCapability") return Response.json({ content: { vessels: servedBy[pointer.shape] ? [{ vesselId: servedBy[pointer.shape] }] : [] } })
      if (pointer.type === "git_diff") return Response.json({ shape: "gitDiff", tree: "t1", diff: "+x", id: "spoof", role: "person", r: 1, refused: "schema" })
      if (pointer.type === "git_status") return Response.json({ shape: "gitDiff", seq: 40, writer: "walk-test", tree: "t9" })
      if (pointer.type === "fs_read") return Response.json({ shape: "request", pointer: { type: "bounded_shell" } })
      return Response.json({ shape: "answer", text: "same shape as called" })
    }) as typeof fetch
    const { execute } = await import("../src/calls")
    const sel = { shape: "selection", id: "sel-r", seq: 12, root: "w1", pool_refs: ["w1", "ch1", "x2", "x3"] }
    await execute({ id: "run/t3", kind: "run", pointer: {}, t: "", calls: [
      { shape: "git_diff", pointer: { cwd: "/c" } }, { shape: "fs_read", pointer: { path: "/p" } }, { shape: "answer", pointer: {} },
      { shape: "git_status", pointer: {} },
    ] }, sel)
    const rows = sent.filter((p) => p.type === "record_write").map((p) => p.row).filter((r) => r.shape !== "hop")
    expect(rows.map((r) => r.shape)).toEqual(["gitDiff"])
    expect(rows[0].tree).toBe("t1")
    expect(rows[0].input_refs).toEqual(["w1"]) // its request only, not the selection's whole pool
    expect(rows[0].selection_ref).toBe("sel-r")
    expect(rows[0].id).toBeUndefined()
    expect(rows[0].role).toBeUndefined()
    expect(rows[0].r).toBeUndefined() // a recorded answer never reads as a grade
    expect(rows[0].refused).toBeUndefined()
    // and git_status, answering a stored row (seq, writer), wrote nothing: rows holds only the one gitDiff
  })

  test("[MUST-FAIL] a huge answer is kept cut in its hop and is not recorded as a row", async () => {
    sent.length = 0
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      sent.push(pointer)
      if (pointer.type === "record_write") return Response.json({ ...pointer.row, id: "r", seq: 1 })
      if (pointer.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "tools" }] } })
      return Response.json({ shape: "gitStatus", stdout: "?? x\n".repeat(60_000) })
    }) as typeof fetch
    const { execute } = await import("../src/calls")
    await execute({ id: "run/t4", kind: "run", pointer: {}, t: "", calls: [{ shape: "git_status", pointer: {} }] },
      { shape: "selection", id: "sel-big", seq: 13, pool_refs: ["w1"] })
    const rows = sent.filter((p) => p.type === "record_write").map((p) => p.row)
    const ended = rows.find((r) => r.shape === "hop" && r.phase === "ended")
    expect(ended.output.cut).toBe(true)
    expect(JSON.stringify(ended).length).toBeLessThan(20_000)
    expect(rows.some((r) => r.shape === "gitStatus")).toBe(false)
    const skipped = rows.find((r) => r.shape === "failure" && r.kind === "too_big")
    expect(skipped?.unrecorded).toBe("gitStatus")
    expect(skipped?.bytes).toBeGreaterThan(96 * 1024)
    expect(skipped?.selection_ref).toBe("sel-big")
  })

  test("[MUST-FAIL] a failure keeps the producer's word for what kind of refusal it was, and only that", async () => {
    sent.length = 0
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      sent.push(pointer)
      if (pointer.type === "record_write") return Response.json({ ...pointer.row, id: "r", seq: 1 })
      if (pointer.type === "answer") return Response.json({ failure: { status: 422, body: "x", refused: "schema" } }, { status: 422 })
      return Response.json({ failure: { status: 422, body: "read refused" } }, { status: 422 })
    }) as typeof fetch
    const { execute } = await import("../src/calls")
    for (const shape of ["answer", "outcome"]) {
      await execute({ id: `run/${shape}`, kind: "run", pointer: {}, t: "", calls: [{ shape, pointer: { via_ref: "ch1" } }] },
        { shape: "selection", id: `sel-${shape}`, seq: 11, pool_refs: ["w1"] })
    }
    const failures = sent.filter((p) => p.type === "record_write" && p.row.shape === "failure").map((p) => p.row)
    expect(failures.find((r) => r.selection_ref === "sel-answer")?.refused).toBe("schema")
    expect("refused" in (failures.find((r) => r.selection_ref === "sel-outcome") ?? {})).toBe(false)
  })
})

describe("choosing among open requests", () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })

  test("[MUST-FAIL] every open request offers its own moves, tagged with it; one already answered and self-graded does not", async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
    const { choices } = await import("../src/loop")
    const now = Date.parse("2026-01-01T12:00:00Z")
    const shared = [
      { shape: "channel", id: "ch1", seq: 1, role: "owner", calls: [] },
      { shape: "shape_schema", id: "s1", seq: 2, role: "owner", target: "answer", inputs: ["world_changed"] },
      { shape: "shape_schema", id: "s2", seq: 3, role: "owner", target: "due", inputs: ["world_changed"] },
    ]
    const old = { shape: "world_changed", id: "w117", seq: 4, role: "owner", t: "2026-01-01T10:00:00Z" }
    const fresh = { shape: "world_changed", id: "w2308", seq: 10, role: "person", t: "2026-01-01T11:59:30Z" }
    const answer = { shape: "answer", id: "a117", seq: 5, role: "described", input_refs: ["w117"] }
    const self = { shape: "outcome", id: "o117", seq: 6, role: "described", r: 1, input_refs: ["w117", "a117"], evidence_refs: ["a117"] }
    const soonDue = { shape: "due", id: "d117", seq: 7, role: "described", within_ms: 60_000, at: now + 60_000, input_refs: ["w117"] }
    const laterDue = { shape: "due", id: "d2308", seq: 11, role: "described", within_ms: 600_000, at: now + 600_000, input_refs: ["w2308"] }
    const got = await choices(shared as any, [
      { root: old as any, rows: [old, answer, self, soonDue] as any },
      { root: fresh as any, rows: [fresh, laterDue] as any },
    ], now)
    const of = (root: string, id: string) => got.filter((o) => o.root === root && o.cand.id === id)
    expect(of("w2308", "produce/answer/ch1")).toHaveLength(1)
    expect(of("w117", "produce/answer/ch1")).toHaveLength(0)
    expect(of("w2308", "produce/answer/ch1")[0].context).toContain("asker:person")
    expect(of("w2308", "produce/answer/ch1")[0].context).toContain("age:0")
    expect(got.filter((o) => o.root === "w117")).toHaveLength(0) // its one move, a wait, is not offered beside another's move
    // a root has a move, so no wait is offered: a wait would hold both roots
    expect(got.filter((o) => o.cand.kind === "wait-for")).toHaveLength(0)
  })

  test("[MUST-FAIL] a call that ended for one request offers nothing again for another", async () => {
    const { choices } = await import("../src/loop")
    const now = Date.parse("2026-01-01T12:00:00Z")
    const shared = [
      { shape: "channel", id: "ch1", seq: 1, role: "owner", calls: [] },
      { shape: "shape_schema", id: "s1", seq: 2, role: "owner", target: "answer", inputs: ["world_changed"], context: ["hop"] },
    ]
    const ra = { shape: "world_changed", id: "wa", seq: 3, role: "person", t: "2026-01-01T11:59:00Z" }
    const rb = { shape: "world_changed", id: "wb", seq: 4, role: "person", t: "2026-01-01T11:59:00Z" }
    const aa = { shape: "answer", id: "aa", seq: 5, role: "described", input_refs: ["wa"] }
    const ab = { shape: "answer", id: "ab", seq: 6, role: "described", input_refs: ["wb"] }
    const hb = { shape: "hop", id: "hb", seq: 7, role: "walk", phase: "ended", kind: "call", selection_ref: "sb" }
    const got = await choices(shared as any, [
      { root: ra as any, rows: [ra, aa] as any },
      { root: rb as any, rows: [rb, ab, hb] as any },
    ], now)
    const produce = (root: string) => got.filter((o) => o.root === root && o.cand.id === "produce/answer/ch1")
    expect(produce("wa")).toHaveLength(0)
    expect(produce("wb")).toHaveLength(1)
  })

  test("[MUST-FAIL] one root's long first deadline does not park the walk while another root has a move", async () => {
    globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
    const { choices } = await import("../src/loop")
    const now = Date.parse("2026-01-01T12:00:00Z")
    const shared = [
      { shape: "channel", id: "ch1", seq: 1, role: "owner", calls: [] },
      { shape: "shape_schema", id: "s1", seq: 2, role: "owner", target: "request", inputs: ["gap"] },
    ]
    // X: a person's request answered, its first deadline hours ahead (legal): its only move is to wait
    const x = { shape: "world_changed", id: "wx", seq: 3, role: "person", t: "2026-01-01T11:00:00Z" }
    const xDue = { shape: "due", id: "dx", seq: 4, role: "described", within_ms: 4 * 3_600_000, at: now + 3 * 3_600_000, input_refs: ["wx"] }
    // Y: a gap a detector opened, whose move is to ask for the next call toward closing it
    const y = { shape: "gap", id: "gy", seq: 5, role: "detector", gap_id: "y", status: "open", t: "2026-01-01T11:30:00Z" }
    const roots = [{ root: x as any, rows: [x, xDue] as any }, { root: y as any, rows: [y] as any }]
    const got = await choices(shared as any, roots, now)
    expect(got.filter((o) => o.cand.kind === "wait-for")).toHaveLength(0)
    expect(got.some((o) => o.root === "gy" && o.cand.id.startsWith("produce/request"))).toBe(true)
    // with nothing to do on Y, the walk waits again, bounded by X's first deadline
    const idle = await choices(shared as any, [roots[0]], now)
    expect(idle.map((o) => [o.cand.kind, o.cand.pointer.until])).toEqual([["wait-for", now + 3 * 3_600_000]])
  })

  test("[MUST-FAIL] once any request's first deadline has passed, no wait is offered: not even another root's unbounded one", async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
    const { choices } = await import("../src/loop")
    const now = Date.parse("2026-01-01T12:00:00Z")
    const shared = [
      { shape: "channel", id: "ch1", seq: 1, role: "owner", calls: [] },
      { shape: "shape_schema", id: "s1", seq: 2, role: "owner", target: "outcome", inputs: ["world_changed"], context: ["answer"] },
    ]
    const gap = { shape: "gap", id: "g1", seq: 3, role: "detector", gap_id: "x", status: "open", t: "2026-01-01T11:00:00Z" }
    const ask = { shape: "world_changed", id: "w1", seq: 4, role: "person", t: "2026-01-01T11:00:00Z" }
    const other = { shape: "world_changed", id: "w2", seq: 6, role: "person", t: "2026-01-01T11:00:00Z" }
    const due = (id: string, of: string, at: number) => ({ shape: "due", id, seq: 7, role: "described", within_ms: 60_000, at, input_refs: [of] })
    const waitsWith = async (at: number) => (await choices(shared as any, [
      { root: gap as any, rows: [gap] as any, awaits: false },
      { root: ask as any, rows: [ask, due("d1", "w1", at)] as any },
      { root: other as any, rows: [other, due("d2", "w2", now + 600_000)] as any },
    ], now)).filter((o) => o.cand.kind === "wait-for")
    expect(await waitsWith(now - 1)).toHaveLength(0)
    // with every deadline still ahead, the wait is offered, bounded by the earliest
    const ahead = await waitsWith(now + 60_000)
    expect(ahead).toHaveLength(1)
    expect(ahead[0].cand.pointer.until).toBe(now + 60_000)
  })

  test("a request whose lapse grade is pending (graded what it saw, not closed) does not hold the other waits back (a guard)", async () => {
    globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
    const { choices } = await import("../src/loop")
    const now = Date.parse("2026-01-01T12:00:00Z")
    const shared = [
      { shape: "channel", id: "ch1", seq: 1, role: "owner", calls: [] },
      { shape: "shape_schema", id: "s1", seq: 2, role: "owner", target: "outcome", inputs: ["world_changed"], context: ["answer", "due", "hop"] },
    ]
    // the live pattern: a passed first due, an answer, and the walk's r 0 over both; the request stays open
    const ask = { shape: "world_changed", id: "w1", seq: 3, role: "person", t: "2026-01-01T11:00:00Z" }
    const due = { shape: "due", id: "d1", seq: 4, role: "described", within_ms: 60_000, at: now - 60_000, input_refs: ["w1"] }
    const answer = { shape: "answer", id: "a1", seq: 5, role: "described", input_refs: ["w1"] }
    const graded = { shape: "outcome", id: "o1", seq: 6, role: "described", r: 0, input_refs: ["w1", "d1", "a1"], evidence_refs: ["a1"] }
    const other = { shape: "world_changed", id: "w2", seq: 7, role: "person", t: "2026-01-01T11:00:00Z" }
    const due2 = { shape: "due", id: "d2", seq: 8, role: "described", within_ms: 600_000, at: now + 600_000, input_refs: ["w2"] }
    const got = await choices(shared as any, [
      { root: ask as any, rows: [ask, due, answer, graded] as any },
      { root: other as any, rows: [other, due2] as any },
    ], now)
    const waits = got.filter((o) => o.cand.kind === "wait-for")
    expect(waits).toHaveLength(1)
    expect(waits[0].cand.pointer.until).toBe(now + 600_000)
  })

  test("[MUST-FAIL] with no move on any request, the walk waits, bounded by the next deadline ahead, rather than having none", async () => {
    globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
    const { choices } = await import("../src/loop")
    const now = Date.parse("2026-01-01T12:00:00Z")
    const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person", t: "2026-01-01T11:00:00Z" }
    const passed = { shape: "due", id: "d0", seq: 2, role: "described", within_ms: 60_000, at: now - 60_000, input_refs: ["w1"] }
    const later = { shape: "due", id: "d2", seq: 3, role: "described", within_ms: 60_000, at: now + 300_000, input_refs: ["w1"] }
    const bounded = await choices([], [{ root: ask as any, rows: [ask, passed, later] as any }], now)
    expect(bounded.map((o) => o.cand.kind)).toEqual(["wait-for"])
    expect(bounded[0].cand.pointer.until).toBe(now + 300_000)
    expect(bounded[0].root).toBe("w1")
    const open = await choices([], [{ root: ask as any, rows: [ask] as any }], now)
    expect(open.map((o) => o.cand.kind)).toEqual(["wait-for"])
    expect("until" in open[0].cand.pointer).toBe(false)
  })

  test("a records that answers the single episode as a list is worked as one root", async () => {
    const { asEpisodes } = await import("../src/loop")
    const rows = [{ shape: "world_changed", id: "w1", seq: 1 }, { shape: "channel", id: "ch1", seq: 2 }]
    expect(asEpisodes(rows)).toEqual({ shared: [], roots: [{ root: rows[0], rows }] } as any)
    expect(asEpisodes({ shared: [], roots: [] })).toEqual({ shared: [], roots: [] })
  })
})

describe("a move the walk cannot run", () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })

  test("[MUST-FAIL] leaves a failure marked as the walk's own, not as a callee's answer", async () => {
    Object.assign(process.env, {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: NODE_KEY,
    })
    const written: Array<Record<string, any>> = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, any> }
      if (pointer.type === "record_write") { written.push(pointer.row); return Response.json({ ...pointer.row, id: "r", seq: 1 }) }
      return Response.json(null)
    }) as typeof fetch
    const { execute } = await import("../src/calls")
    await execute({ id: "wait-until", kind: "wait-until", pointer: {}, calls: [], t: "" }, { shape: "selection", id: "sel-u", seq: 1 } as any)
    expect(written).toHaveLength(1)
    expect(written[0].kind).toBe("unrunnable")
  })
})
