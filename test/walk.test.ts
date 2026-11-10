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
  const served = new Set(["answer", "fileContent"])
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

  test("waits are always candidates, and candidates carry no address", async () => {
    const cands = await applicable(pool)
    expect(cands.map((c) => c.id)).toContain("wait-for")
    expect(JSON.stringify(cands)).not.toContain("http")
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
