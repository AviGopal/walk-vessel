// SPDX-License-Identifier: MIT
// A tick says what a root with no move holds back BEFORE it draws: a reason is news to that root's producer only once
// read, and the walk's own rows end no wait, so a reason written after a draw with nothing else to do sat unread until
// the idle wait's bound. A tick that wrote one reads again, once, and draws over the read that holds it. A tick that
// wrote none draws at once; a store that does not yet show what was written gets one re-read, which writes nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type Fake, fake, freePort, healthy, run } from "./harness"

const own = (x: Record<string, unknown>, seq: number) => ({ ...x, seq, role: "owner", writer: "owner" })
const shared: any[] = [
  own({ shape: "channel", id: "ch1", calls: [] }, 2),
  own({ shape: "shape_schema", id: "sq", target: "request", inputs: ["world_changed"], context: ["hop", "failure"] }, 3),
]
const pointer = { type: "code_replace_lines", path: "src/engine.ts", start_line: 1669, end_line: 1669, text: "b" }
const ask = (seq: number) => [
  { shape: "selection", id: `sel${seq}`, seq, role: "walk", root: "w1", a: "produce/request/ch1", seen_key: `k${seq}` },
  { shape: "hop", id: `hp${seq}`, seq: seq + 1, role: "walk", phase: "ended", kind: "produce", selection_ref: `sel${seq}` },
  { shape: "request", id: `q${seq + 2}`, seq: seq + 2, role: "described", selection_ref: `sel${seq}`, input_refs: ["w1"], pointer },
]
const replace = (seq: number, from: number, after: string) => [
  { shape: "selection", id: `sel${seq}`, seq, role: "walk", root: "w1", a: "call/code_replace_lines", from: `q${from}` },
  { shape: "hop", id: `hs${seq}`, seq: seq + 1, role: "walk", phase: "started", kind: "call", call_id: `c${seq}`, pointer_type: "code_replace_lines", selection_ref: `sel${seq}` },
  { shape: "hop", id: `he${seq}`, seq: seq + 2, role: "walk", phase: "ended", kind: "call", call_id: `c${seq}`, selection_ref: `sel${seq}`,
    output: { shape: "codeReplaceResult", path: "src/engine.ts", start_line: 1669, end_line: 1669, after } },
]
const world = { shape: "world_changed", id: "w1", seq: 1, role: "person", writer: "kid-person", what: "fix the failing check" }
// w1's newest request ended in a repeat (its call answered as q5's had): held, with no other move
const stuck = [world, ...ask(3), ...replace(10, 5, "a1"), ...ask(20), ...replace(30, 22, "a1")]
const why = ["code_replace_lines: it answered as row 12 did, so it changed nothing the walk can tell apart; the same call again answers the same, and a different pointer is a different call"]
const skip = (seq: number, req: string) => ({ shape: "failure", kind: "skip", id: `sk${seq}`, seq, role: "walk", request_ref: req, input_refs: ["w1", req], unserved: why })
// the same root, still with no move, once its reasons are written: q22's was news and was produced over (q52), q52's call
// answered the same again, and its reason, already told, is written too. It is held, and has nothing to say.
const told = [...stuck, skip(40, "q22"), ...ask(50), ...replace(60, 52, "a1"), skip(70, "q52")]

// One vessel against a fake store; every call it makes is kept, in order. With shows, a read holds what was written.
const walk = (rows: any[], shows: boolean) => {
  const st: { discovery?: Fake; vessel?: ReturnType<typeof run>; calls: Array<{ type: string; row?: any }> } = { calls: [] }
  beforeAll(async () => {
    st.discovery = fake((path, body) => {
      if (path !== "/resolve") return Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true })
      const p = body.pointer
      st.calls.push({ type: String(p.type), ...(p.type === "record_write" ? { row: p.row } : {}) })
      if (p.type === "record_wait_exact") return Response.json({ shape: "arm", id: "arm1", seq: 0, arm: "treated", as_of_seq: 99, role: "walk" })
      if (p.type === "record_read" && p.roots === "all") {
        const extra = shows ? st.calls.filter((c) => c.type === "record_write" && c.row?.shape === "failure").map((c, i) => ({ ...c.row, id: `x${i}`, seq: 200 + i, role: "walk" })) : []
        return Response.json({ shared, roots: [{ root: world, rows: [...rows, ...extra] }] })
      }
      if (p.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "v" }] } })
      if (p.type === "shapeDescriptions") return Response.json({ shape_answers: {} })
      if (p.type === "posterior") return Response.json({ at_seq: 300, posts: p.cells.map(() => ({ alpha: 2, beta: 1, from: "move" })) })
      if (p.type === "record_write") return Response.json({ ...p.row, id: `r${st.calls.length}`, seq: 300 + st.calls.length })
      return new Promise<Response>(() => {})
    })
    const port = freePort()
    st.vessel = run("src/index.ts", {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: String(port), DISCOVERY_URL: st.discovery.url,
      WALK_ENDPOINT: `http://127.0.0.1:${port}`, METABOB_API_KEY: "node-key-for-test",
    })
    await healthy(port)
    // the first selection's move runs after every write before it
    for (let i = 0; i < 600 && !st.calls.some((c) => c.type === "record_write" && c.row?.shape === "hop"); i++) await Bun.sleep(25)
    for (let i = 0; i < 600 && !st.calls.some((c) => c.type === "record_wait"); i++) await Bun.sleep(25)
  }, 30_000)
  afterAll(() => {
    st.vessel?.kill()
    st.discovery?.stop()
  })
  // up to the first selection written: the reads and the skip rows, in order
  const before = () => {
    const i = st.calls.findIndex((c) => c.type === "record_write" && c.row?.shape === "selection")
    return st.calls.slice(0, i < 0 ? st.calls.length : i)
      .filter((c) => (c.type === "record_read") || (c.type === "record_write" && c.row?.kind === "skip"))
      .map((c) => (c.type === "record_read" ? "read" : `skip:${c.row.request_ref}`))
  }
  return { st, before }
}

describe("a root with no move says what it holds back before the draw", () => {
  const { before } = walk(stuck, true)
  test("[MUST-FAIL] the reason is written before the tick's selection, and the tick reads again once before it draws", () => {
    expect(before()).toEqual(["read", "skip:q22", "read"])
  })
})

describe("a reason already written", () => {
  const { before } = walk(told, true)
  test("[GUARD] a root held for a reason already written writes nothing, and the tick draws on its one read", () => {
    expect(before()).toEqual(["read"])
  })
})

describe("a store that does not yet show what was written", () => {
  const { before } = walk(stuck, false)
  test("[GUARD] gets one re-read that writes nothing, never a loop: the tick then draws", () => {
    expect(before()).toEqual(["read", "skip:q22", "read"])
  })
})
