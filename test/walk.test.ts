// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { draw } from "../src/draw"
import { type Fake, exitsNaming, fake, freePort, healthy, run } from "./harness"

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
      { shape: "activity_template", id: "t-ok", seq: 8, sig, calls: [{ shape: "fileContent", pointer: { path: "a" } }, { shape: "answer", pointer: {} }] },
    ]
    const ids = (await applicable(templates)).map((c) => c.id)
    expect(ids).toContain("run/t-ok")
    expect(ids).not.toContain("run/t-hop")
    const skipped: Array<{ id: string; unserved: string[] }> = []
    await (applicable as any)(templates, skipped)
    expect(skipped).toEqual([{ id: "t-hop", unserved: ["hop"] }])
  })

  test("[MUST-FAIL] while a request is open, a wait ends by a deadline still ahead, and without one is not offered", async () => {
    const waits = async (rows: any[]) => (await applicable(rows)).filter((c) => c.kind === "wait-for")
    const soon = Date.now() + 600_000
    const later = Date.now() + 1_200_000
    const passed = Date.now() - 60_000
    expect(await waits(pool)).toEqual([])
    expect(await waits([...pool, { shape: "due", id: "d0", seq: 7, at: passed }])).toEqual([])
    const bounded = await waits([...pool,
      { shape: "due", id: "d0", seq: 7, at: passed },
      { shape: "due", id: "d1", seq: 8, at: later },
      { shape: "due", id: "d2", seq: 9, at: soon },
    ])
    expect(bounded.length).toBeGreaterThan(0)
    for (const c of bounded) expect(c.pointer.until).toBe(soon)
    const idle = await waits([...pool, { shape: "arm", id: "arm1", seq: 7, arm: "treated" }])
    expect(idle.length).toBeGreaterThan(0)
    for (const c of idle) expect("until" in c.pointer).toBe(false)
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

  test("[MUST-FAIL] a repeat answer or due for the same request waits for the first one's grade", async () => {
    expect(await ids([ask, ch, hop, sch("answer", ["hop"]), a1])).not.toContain("produce/answer/ch1")
    expect(await ids([ask, ch, sch("due", []), d1])).not.toContain("produce/due/ch1")
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

describe("cell context", () => {
  let discovery: Fake
  let vessel: ReturnType<typeof run>
  let cells: string[] = []

  beforeAll(async () => {
    const pool = [
      { shape: "world_changed", id: "w1", seq: 2, writer: "kid-person", role: "person", what: "x" },
      { shape: "channel", id: "ch1", seq: 3, writer: "owner", role: "owner", calls: [] },
      { shape: "shape_schema", id: "s1", seq: 4, writer: "owner", role: "owner", target: "answer", inputs: ["world_changed"] },
      { shape: "selection", id: "own1", seq: 5, writer: "walk-test", role: "walk" },
      { shape: "failure", id: "own2", seq: 6, writer: "walk-test", role: "walk" },
    ]
    discovery = fake((path, body) => {
      if (path !== "/resolve") return Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true })
      const p = body.pointer
      if (p.type === "record_wait_exact") return Response.json({ shape: "arm", id: "arm1", seq: 1, arm: "treated", as_of_seq: 99 })
      if (p.type === "record_read") return Response.json(pool)
      if (p.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "v" }] } })
      if (p.type === "posterior") {
        if (cells.length === 0) cells = p.cells
        return Response.json({ at_seq: 6, posts: p.cells.map(() => ({ alpha: 1, beta: 1 })) })
      }
      if (p.type === "record_write") return Response.json({ ...p.row, id: `r${Math.random()}`, seq: 7 })
      return new Promise<Response>(() => {})
    })
    const port = freePort()
    vessel = run("src/index.ts", {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: String(port), DISCOVERY_URL: discovery.url,
      WALK_ENDPOINT: `http://127.0.0.1:${port}`, METABOB_API_KEY: NODE_KEY,
    })
    await healthy(port)
    for (let i = 0; i < 200 && cells.length === 0; i++) await Bun.sleep(25)
  })

  afterAll(() => {
    vessel?.kill()
    discovery?.stop()
  })

  test("a cell's context is the shapes of rows the walk did not write itself", () => {
    expect(cells.length).toBeGreaterThan(0)
    for (const c of cells) expect(c.split("|")[1]).toBe("channel,shape_schema,world_changed")
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
    await recordSkipped([{ shape: "failure", id: "f1", seq: 12, template_ref: "t-hop" } as any], [{ id: "t-hop", unserved: ["hop"] }], sel)
    expect(written).toHaveLength(1)
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
})
