// SPDX-License-Identifier: MIT
// What the walk names on its episodes read of its own selections (loop.ts UNREAD: cands, posts, timing) it must never
// read back from an episode row: records leaves them out of that answer. So every decision a tick makes from the answer
// is the same whether those fields are there (a records that ignores omit) or not (one that honours it, marking each
// row fields_omitted), and the walk's code reads them from no row.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { type Fake, fake, freePort, healthy, run } from "./harness"

const NODE_KEY = "node-key-for-test"
const NAMED = ["cands", "posts", "timing"]
type Row = Record<string, any>

describe("the episodes read names what the walk does not read back", () => {
  let discovery: Fake
  let vessel: ReturnType<typeof run>
  const pointers: Row[] = []
  const written: Row[] = []

  beforeAll(async () => {
    // One ask no schema takes: the move each tick is a wait, which records answers at once, so the walk ticks again. The
    // episodes answer carries the walk's own selections back whole, as a records that ignores omit would.
    const ask = { shape: "world_changed", id: "w1", seq: 2, writer: "kid-person", role: "person", what: "x", t: new Date().toISOString() }
    const shared = [{ shape: "channel", id: "ch1", seq: 3, writer: "owner", role: "owner", calls: [] }]
    discovery = fake((path, body) => {
      if (path !== "/resolve") return Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true })
      const p = body.pointer
      pointers.push(p)
      if (p.type === "record_wait_exact") return Response.json({ shape: "arm", id: "arm1", seq: 1, arm: "treated", as_of_seq: 99 })
      if (p.type === "record_read" && p.roots === "all") {
        return Response.json({ shared, roots: [{ root: ask, rows: [ask, ...written.filter((r) => r.shape === "selection" || r.shape === "hop")] }] })
      }
      if (p.type === "record_wait") return Response.json([])
      if (p.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "v" }] } })
      if (p.type === "shapeDescriptions") return Response.json({ shape_answers: {} })
      if (p.type === "posterior") return Response.json({ at_seq: 6, posts: p.cells.map(() => ({ alpha: 2, beta: 1, from: "move" })) })
      if (p.type === "record_write") {
        const row = { ...p.row, id: `r${written.length}`, seq: 10 + written.length, writer: "walk-test", role: "walk" }
        written.push(row)
        return Response.json(row)
      }
      return new Promise<Response>(() => {})
    })
    const port = freePort()
    vessel = run("src/index.ts", {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: String(port), DISCOVERY_URL: discovery.url,
      WALK_ENDPOINT: `http://127.0.0.1:${port}`, METABOB_API_KEY: NODE_KEY,
    })
    await healthy(port)
    for (let i = 0; i < 600 && written.filter((r) => r.shape === "selection").length < 3; i++) await Bun.sleep(25)
  }, 30_000)

  afterAll(() => {
    vessel?.kill()
    discovery?.stop()
  })

  test("[MUST-FAIL] every episodes read names the selection's cands, posts and timing; no other read or write the walk makes carries omit", () => {
    const episodes = pointers.filter((p) => p.type === "record_read" && p.roots === "all")
    expect(episodes.length).toBeGreaterThanOrEqual(3)
    for (const p of episodes) expect(p.omit).toEqual({ selection: NAMED })
    const others = pointers.filter((p) => !(p.type === "record_read" && p.roots === "all"))
    expect(["record_wait_exact", "posterior", "record_write", "record_wait"].filter((t) => !others.some((p) => p.type === t))).toEqual([])
    expect(others.filter((p) => "omit" in p).map((p) => p.type)).toEqual([])
  })

  test("a records that ignores omit and answers the selections whole: the walk keeps ticking, and stores each selection whole", () => {
    const sels = written.filter((r) => r.shape === "selection")
    expect(sels.length).toBeGreaterThanOrEqual(3)
    for (const s of sels) {
      expect([Array.isArray(s.cands), Array.isArray(s.posts), typeof s.timing, "fields_omitted" in s]).toEqual([true, true, "object", false])
      expect(s.posts_seq).toBe(6)
    }
    expect(vessel.exitCode).toBeNull()
  })
})

// ── what a tick decides is the same with or without the fields ──

type Fx = { as_of_seq: number; now: number; awaits: boolean; root: Row; shared: Row[]; rows: Row[] }
const d929 = JSON.parse(gunzipSync(readFileSync(join(import.meta.dir, "fixtures", "d929-person-wait.json.gz"))).toString()) as Fx
const latest = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8").replaceAll('"writer-3"', '"walk-test"')) as { root: Row; rows: Row[]; owner?: Row[] }
const realFetch = globalThis.fetch
const writes: Row[] = []

const stub = () => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
  })
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const { pointer } = JSON.parse(String(init?.body)) as { pointer: Row }
    if (pointer.type === "record_write") {
      writes.push(pointer.row)
      return Response.json({ ...pointer.row, id: `w${writes.length}`, seq: 1e9 + writes.length })
    }
    return Response.json({ content: { vessels: [{ vesselId: "v", endpoint: "http://v.test" }] } })
  }) as typeof fetch
}

// A selection as selectionRow writes it: the fields added where an older row (d929's) lacks them.
const whole = (r: Row): Row => r.shape !== "selection" || r.role !== "walk" ? r : {
  cands: [{ id: String(r.a ?? "wait-for"), kind: "produce", root: String(r.root) }, { id: "call/git_diff", kind: "call", root: String(r.root) }],
  posts: [{ alpha: 3.4300000000000006, beta: 1, from: "cell" }, { alpha: 1, beta: 2, from: "move" }],
  timing: { episodes_ms: 1780, episodes_reads: 1, choices_ms: 40, posterior_ms: 12, posterior_reads: 1, draw_ms: 0, cands: 2, cells: 2 },
  posts_seq: r.seq - 1, ...r,
}
// The same selection as records answers it under omit: the fields gone, marked.
const thinned = (r: Row): Row => {
  if (r.shape !== "selection" || r.role !== "walk") return r
  const gone = NAMED.filter((k) => k in r)
  return { ...Object.fromEntries(Object.entries(r).filter(([k]) => !gone.includes(k))), fields_omitted: gone }
}

// One tick's decisions from an episodes answer, as chain() makes them: the options (each one's move, pointer, cell,
// context, pool, what it held back), the roots with no move, the stall rows, the skip rows and each produce's acts row.
const tick = async (shared: Row[], roots: Array<{ root: Row; rows: Row[]; awaits?: boolean }>, now: number) => {
  const { choices, stalls } = await import("../src/loop")
  const { recordSkipped } = await import("../src/calls")
  const { actsFactRow } = await import("../src/acts")
  writes.length = 0
  const arm = { shape: "arm", id: "arm1", seq: 1, role: "owner", writer: "owner", arm: "treated", as_of_seq: 0 }
  const held = { moving: new Set<string>(), still: [] as Array<{ root: string; pool: Row[]; skipped: any[] }> }
  const options = await choices(shared as any, roots as any, now, {}, arm as any, undefined, held as any)
  const at = Math.max(0, ...[...shared, ...roots.flatMap((x) => x.rows)].map((r) => Number(r.seq))) + 1
  const stall = stalls(shared as any, roots as any, [...options, ...[...held.moving].map((root) => ({ root }))], at)
  const sel = { shape: "selection", id: "sel-now", seq: at } as any
  const acts: unknown[] = []
  for (const o of options) {
    await recordSkipped(o.pool, o.skipped, sel)
    if (o.cand.kind === "produce") acts.push(await actsFactRow(o.pool, o.root, async (row) => { acts.push(row); return { ...row, id: "acts" } as any }, sel.id, o.gated))
  }
  for (const h of held.still) await recordSkipped(h.pool as any, h.skipped, undefined, h.root)
  return {
    options: options.map((o) => ({ id: o.cand.id, kind: o.cand.kind, pointer: o.cand.pointer, from: o.cand.from, seen_key: o.cand.seen_key, cell: o.cell,
      context: o.context, root: o.root, gated: o.gated, skipped: o.skipped, pool: o.pool.map((r) => r.id) })),
    moving: [...held.moving].sort(), still: held.still.map((h) => [h.root, h.skipped]), stall, writes: [...writes], acts,
  }
}

// The same tick over the answer with the fields whole, without them and marked, and without them and unmarked.
const same = async (shared: Row[], roots: Array<{ root: Row; rows: Row[]; awaits?: boolean }>, now: number) => {
  const full = (rs: Row[]) => rs.map(whole)
  const thin = (rs: Row[]) => rs.map((r) => thinned(whole(r)))
  const bare = (rs: Row[]) => rs.map((r) => { const { fields_omitted: _f, ...k } = thinned(whole(r)); return k })
  const at = (f: (rs: Row[]) => Row[]) => tick(f(shared), roots.map((x) => ({ ...x, root: x.root, rows: f(x.rows) })), now)
  const want = await at(full)
  expect(JSON.stringify(await at(thin))).toBe(JSON.stringify(want))
  expect(JSON.stringify(await at(bare))).toBe(JSON.stringify(want))
  return want
}

describe("a tick decides the same with or without its selections' cands, posts and timing", () => {
  beforeAll(stub)
  afterAll(() => { globalThis.fetch = realFetch })
  test("d929 as records serves it, at every 200th row of its episode and at its last, now and once its first deadline has passed", async () => {
    const rows = [...d929.rows].sort((a, b) => a.seq - b.seq)
    expect(rows.filter((r) => r.shape === "selection").length).toBeGreaterThan(1000)
    const kinds = new Set<string>()
    let wrote = 0
    const cuts = [...rows.map((_r, i) => i).filter((i) => i % 200 === 199), rows.length - 1]
    for (const i of cuts) {
      const upto = rows[i]!.seq
      const roots = [{ root: d929.root, rows: rows.slice(0, i + 1), awaits: d929.awaits }]
      const shared = d929.shared.filter((r) => r.seq <= upto)
      for (const now of [d929.now, d929.now + 7 * 86_400_000]) {
        const want = await same(shared, roots, now)
        for (const o of want.options) kinds.add(o.kind)
        wrote += want.writes.length + want.acts.length
      }
    }
    // the cuts reach moves of every kind the episode had, not only the wait it ends on, and rows the tick writes
    expect([...kinds].sort()).toEqual(expect.arrayContaining(["produce", "wait-for"]))
    expect(wrote).toBeGreaterThan(0)
  }, 120_000)

  test("the clone fixtures (82ac, 010a) with selections of the walk's beside their rows, and several roots at once", async () => {
    for (const name of ["latest-82ac.json", "latest-010a.json"]) {
      const f = latest(name)
      const sels = [f.root, ...f.rows].map((r, k) => ({ shape: "selection", id: `s${k}`, seq: 50_000 + k, role: "walk", writer: "walk-test", root: f.root.id,
        a: k % 2 === 0 ? "call/git_diff" : "produce/answer/ch", from: "move", seen_key: `k${k}`, cell: "c", context: ["asker:person"], pool_refs: [f.root.id], input_refs: [] }))
      const channel = { shape: "channel", id: "ch", seq: 2, role: "owner", writer: "owner", calls: [] }
      const schema = { shape: "shape_schema", id: "sch", seq: 3, role: "owner", writer: "owner", target: "answer", inputs: [String(f.root.shape)] }
      await same([channel, schema, ...(f.owner ?? [])], [{ root: f.root, rows: [f.root, ...f.rows, ...sels] }], Date.now())
    }
    await same(d929.shared, [{ root: d929.root, rows: d929.rows, awaits: d929.awaits }, { root: latest("latest-82ac.json").root, rows: latest("latest-82ac.json").rows }], d929.now)
  }, 120_000)
})

// No walk code reads the named fields off a row: the only reads of them anywhere in src are of the posterior answer
// (isPosterior's `a`, the tick's `post`). A new read of one changes this list, and must not be of an episode row.
test("src reads cands, posts and timing only from the posterior answer", () => {
  const dir = join(import.meta.dir, "..", "src")
  const found: string[] = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts")).sort()) {
    const src = readFileSync(join(dir, f), "utf8")
    for (const m of src.matchAll(/([\w$\])]+)\??\.(cands|posts|timing)\b/g)) found.push(`${f}: ${m[1]}.${m[2]}`)
    for (const m of src.matchAll(/\[\s*["'`](cands|posts|timing)["'`]\s*\]/g)) found.push(`${f}: [${m[1]}]`)
    for (const m of src.matchAll(/\{[^{}]*\b(cands|posts|timing)\b[^{}]*\}\s*=[^=>]/g)) found.push(`${f}: {${m[1]}} =`)
  }
  expect(found).toEqual(["loop.ts: a.posts", "loop.ts: a.posts", "loop.ts: post.posts", "loop.ts: post.posts"])
})
