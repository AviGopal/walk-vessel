// SPDX-License-Identifier: MIT
// What a tick says of the roots it did not draw: a root waiting on a person has a move (its wait) and is neither stalled
// nor made to say what it holds back; a root with no move at all says once what it holds back and why, citing itself and
// the held row and naming no selection, since the tick's selection is another root's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type Fake, fake, freePort, healthy, run } from "./harness"

const NODE_KEY = "node-key-for-test"
type Fx = { as_of_seq: number; now: number; awaits: boolean; root: any; shared: any[]; rows: any[] }
const fx = JSON.parse(gunzipSync(readFileSync(join(import.meta.dir, "fixtures", "d929-person-wait.json.gz"))).toString()) as Fx

// One tick of the vessel against a fake discovery serving these episodes; every row the walk writes is kept.
const tick = (shared: any[], roots: any[], selSeq: number) => {
  const st: { discovery?: Fake; vessel?: ReturnType<typeof run>; written: Array<Record<string, any>> } = { written: [] }
  beforeAll(async () => {
    st.discovery = fake((path, body) => {
      if (path !== "/resolve") return Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true })
      const p = body.pointer
      if (p.type === "record_wait_exact") return Response.json({ shape: "arm", id: "arm1", seq: 1, arm: "treated", as_of_seq: 99 })
      if (p.type === "record_read" && p.roots === "all") return Response.json({ shared, roots })
      if (p.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "v" }] } })
      if (p.type === "shapeDescriptions") return Response.json({ shape_answers: {} })
      if (p.type === "posterior") return Response.json({ at_seq: 6, posts: p.cells.map(() => ({ alpha: 2, beta: 1, from: "move" })) })
      if (p.type === "record_write") {
        st.written.push(p.row)
        return Response.json({ ...p.row, id: `r${st.written.length}`, seq: p.row?.shape === "selection" ? selSeq : selSeq + st.written.length })
      }
      return new Promise<Response>(() => {})
    })
    const port = freePort()
    st.vessel = run("src/index.ts", {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: String(port), DISCOVERY_URL: st.discovery.url,
      WALK_ENDPOINT: `http://127.0.0.1:${port}`, METABOB_API_KEY: NODE_KEY,
    })
    await healthy(port)
    // the drawn move's started hop is written after the tick's skip and stall rows, so once it is here they are too
    for (let i = 0; i < 600 && !st.written.some((r) => r.shape === "hop"); i++) await Bun.sleep(25)
  }, 30_000)
  afterAll(() => {
    st.vessel?.kill()
    st.discovery?.stop()
  })
  return st
}

const ask = (id: string, seq: number) => ({ shape: "world_changed", id, seq, writer: "kid-person", role: "person", what: "x", t: new Date().toISOString() })
const cites = (r: Record<string, any>, id: string) => [r.input_refs].flat().map(String).includes(id) || r.root === id

describe("a root waiting on a person, beside a root with a move (d929 as records serves it)", () => {
  // The rule's rows far behind the tick for every root, so only having a move keeps a root from a stall row.
  const shared = [...fx.shared, { shape: "stall_rule", id: "sr", seq: 2, writer: "owner", role: "owner", after_rows: 5 }]
  const other = ask("w-move", fx.as_of_seq - 10)
  // a root of a shape nothing takes: no move at all, the control that the rule is live in this tick
  const none = { shape: "note", id: "z1", seq: fx.as_of_seq - 20, writer: "detector", role: "detector" }
  const st = tick(shared, [{ root: fx.root, rows: fx.rows, awaits: fx.awaits }, { root: other, rows: [other] }, { root: none, rows: [none] }], fx.as_of_seq + 1000)

  test("[MUST-FAIL] the waiting root is not drawn, gets no stall row and no skip row (red before: a stall row for it)", () => {
    const sel = st.written.find((r) => r.shape === "selection")
    expect(sel?.root).toBe("w-move")
    const about = st.written.filter((r) => r.shape === "failure" && cites(r, fx.root.id))
    expect(about).toEqual([])
    // the control: the rule is live, so its silence on the waiting root is the wait, not a missing rule
    expect(st.written.filter((r) => r.shape === "failure" && r.kind === "stall").map((r) => r.root)).toEqual(["z1"])
  })
})

describe("roots with no move at all say what they hold back, once per reason, naming no selection", () => {
  const shared = [
    { shape: "channel", id: "ch1", seq: 4, writer: "owner", role: "owner", calls: [] },
    { shape: "shape_schema", id: "s1", seq: 5, writer: "owner", role: "owner", target: "answer", inputs: ["world_changed"] },
    { shape: "stall_rule", id: "sr", seq: 6, writer: "owner", role: "owner", after_rows: 5 },
    { shape: "requires", id: "rq", seq: 7, writer: "owner", role: "owner", for: "git_land", needs: "land_verdict", where: { r: 1 } },
  ]
  const gap = (id: string, seq: number) => ({ shape: "gap", id, seq, writer: "detector", role: "detector", gap_id: id, status: "open" })
  // 82ac's form: a landing asked for, gated by the only verdict here, an r 0
  const g8 = gap("g8", 10)
  const gated = [g8,
    { shape: "land_verdict", id: "lv8", seq: 11, writer: "described", role: "described", r: 0, input_refs: ["g8"] },
    { shape: "request", id: "q8", seq: 12, writer: "described", role: "described", pointer: { type: "git_land" }, input_refs: ["g8"] }]
  // 90b4's form: a call refused for the request's state, asked again with the same pointer and nothing new since
  const repeat = (root: string, s: number) => {
    const p = { type: "git_commit", cwd: "/c", message: "fix: once" }
    return [gap(root, s),
      { shape: "request", id: `${root}-q1`, seq: s + 1, writer: "described", role: "described", pointer: p, input_refs: [root] },
      { shape: "selection", id: `${root}-s1`, seq: s + 2, writer: "walk-test", role: "walk", a: "call/git_commit", from: `${root}-q1`, root },
      { shape: "hop", id: `${root}-h1`, seq: s + 3, writer: "walk-test", role: "walk", phase: "started", kind: "call", call_id: `${root}-c1`, pointer_type: "git_commit", selection_ref: `${root}-s1` },
      { shape: "failure", id: `${root}-f1`, seq: s + 4, writer: "walk-test", role: "walk", call_id: `${root}-c1`, selection_ref: `${root}-s1`, status: 200, blames: "request", body: "nothing new to commit" },
      { shape: "request", id: `${root}-q2`, seq: s + 5, writer: "described", role: "described", pointer: p, input_refs: [root] }]
  }
  const g9 = repeat("g9", 20)
  // the same form, its held reason already said on an earlier tick: a row with no selection citing the root, as records
  // keeps it among the root's rows. Its reasons are the tick's own, word for word: this discovery declares no call's inputs,
  // so each request is also held for that.
  const g7 = [...repeat("g7", 40), { shape: "failure", id: "g7-k", seq: 46, writer: "walk-test", role: "walk", kind: "skip", request_ref: "g7-q2",
    unserved: ["git_commit: the declared inputs could not be read, so no call is made",
      "git_commit: this same call was refused here (row 44) and nothing new has come since; a different pointer is a different call"],
    input_refs: ["g7", "g7-q2"] }]
  const move = ask("w1", 60)
  const roots = [{ root: move, rows: [move] }, ...[gated, g9, g7].map((rows) => ({ root: rows[0], rows }))]
  const st = tick(shared, roots, 1000)

  test("[MUST-FAIL] a gated landing and a repeated call each write one skip row citing their root and the request, with no selection_ref (red before: none)", () => {
    expect(st.written.find((r) => r.shape === "selection")?.root).toBe("w1")
    const skips = st.written.filter((r) => r.shape === "failure" && r.kind === "skip")
    expect(skips.map((r) => r.request_ref).sort()).toEqual(["g9-q2", "q8"])
    for (const r of skips) expect("selection_ref" in r).toBe(false)
    const by = new Map(skips.map((r) => [r.request_ref, r]))
    expect(by.get("q8")?.input_refs).toEqual(["g8", "q8"])
    expect(String(by.get("q8")?.unserved)).toContain("git_land (requires land_verdict")
    expect(by.get("g9-q2")?.input_refs).toEqual(["g9", "g9-q2"])
    expect(String(by.get("g9-q2")?.unserved)).toContain("this same call was refused here (row 24)")
  })

  test("[MUST-FAIL] a reason already said for that request writes nothing again", () => {
    expect(st.written.filter((r) => r.shape === "failure" && r.kind === "skip" && cites(r, "g7"))).toEqual([])
  })

  test("roots with no move are still stalled; the drawn root is not", () => {
    const stalled = st.written.filter((r) => r.shape === "failure" && r.kind === "stall").map((r) => r.root).sort()
    expect(stalled).toEqual(["g7", "g8", "g9"])
    for (const r of st.written.filter((x) => x.shape === "failure" && x.kind === "stall")) expect("selection_ref" in r).toBe(false)
  })
})

describe("a root whose only move is a wait bounded by its first deadline, still ahead, beside a root with a move", () => {
  const shared = [
    { shape: "channel", id: "ch1", seq: 4, writer: "owner", role: "owner", calls: [] },
    { shape: "shape_schema", id: "s1", seq: 5, writer: "owner", role: "owner", target: "answer", inputs: ["world_changed"] },
    { shape: "stall_rule", id: "sr", seq: 6, writer: "owner", role: "owner", after_rows: 5 },
  ]
  // a person's row no schema takes, so nothing is produced for it; its producer's deadline, an hour ahead, is its wait
  const waiting = { shape: "note", id: "n1", seq: 50, writer: "kid-person", role: "person", what: "x" }
  const due = { shape: "due", id: "d1", seq: 51, writer: "described", role: "described", within_ms: 3_600_000, at: Date.now() + 3_600_000, input_refs: ["n1"] }
  const none = { shape: "note", id: "z1", seq: 40, writer: "detector", role: "detector" }
  const move = ask("w1", 60)
  const st = tick(shared, [{ root: move, rows: [move] }, { root: waiting, rows: [waiting, due] }, { root: none, rows: [none] }], 1000)

  test("[MUST-FAIL] the waiting root is not drawn and gets no stall row; the root with no move does", () => {
    expect(st.written.find((r) => r.shape === "selection")?.root).toBe("w1")
    expect(st.written.filter((r) => r.shape === "failure" && r.kind === "stall").map((r) => r.root)).toEqual(["z1"])
  })
})
