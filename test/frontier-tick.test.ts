// SPDX-License-Identifier: MIT
// What a tick hands a produce: the request_acts row it writes carries the root's frontier and the calls that take it, as
// the tick computed them, so the producer is shown the offer at the moment it chooses (the activity lattice).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type Fake, fake, freePort, healthy, run } from "./harness"

describe("a tick's request_acts carries its root's frontier", () => {
  let discovery: Fake
  let vessel: ReturnType<typeof run>
  let acts: Record<string, any> | undefined

  beforeAll(async () => {
    const ask = { shape: "world_changed", id: "w1", seq: 2, writer: "kid-person", role: "person", what: "x", t: new Date().toISOString() }
    const edit = { shape: "fileEditResult", id: "e1", seq: 6, writer: "walk-test", role: "walk", call_id: "c1", path: "src/a.ts", input_refs: ["w1"] }
    const shared = [
      { shape: "channel", id: "ch1", seq: 3, writer: "owner", role: "owner", calls: [] },
      { shape: "shape_schema", id: "s1", seq: 4, writer: "owner", role: "owner", target: "answer", inputs: ["world_changed"] },
      { shape: "requires", id: "rq", seq: 5, writer: "owner", role: "owner", for: "git_commit", needs: "fileEditResult" },
    ]
    discovery = fake((path, body) => {
      if (path !== "/resolve") return Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true })
      const p = body.pointer
      if (p.type === "record_wait_exact") return Response.json({ shape: "arm", id: "arm1", seq: 1, arm: "treated", as_of_seq: 99 })
      if (p.type === "record_read" && p.roots === "all") return Response.json({ shared, roots: [{ root: ask, rows: [ask, edit] }] })
      if (p.type === "vesselCapability") return Response.json({ content: { vessels: [{ vesselId: "v" }] } })
      if (p.type === "shapeDescriptions") return Response.json({ shape_answers: { fs_edit: "fileEditResult" } })
      if (p.type === "posterior") return Response.json({ at_seq: 7, posts: p.cells.map(() => ({ alpha: 2, beta: 1, from: "move" })) })
      if (p.type === "record_write" && p.row?.shape === "request_acts" && !acts) acts = p.row
      if (p.type === "record_write") return Response.json({ ...p.row, id: `r${Math.random()}`, seq: 8 })
      return new Promise<Response>(() => {})
    })
    const port = freePort()
    vessel = run("src/index.ts", {
      WALK_VESSEL_ID: "walk-test", WALK_PORT: String(port), DISCOVERY_URL: discovery.url,
      WALK_ENDPOINT: `http://127.0.0.1:${port}`, METABOB_API_KEY: "node-key-for-test",
    })
    await healthy(port)
    for (let i = 0; i < 600 && !acts; i++) await Bun.sleep(25)
  }, 30_000)

  afterAll(() => {
    vessel?.kill()
    discovery?.stop()
  })

  test("[MUST-FAIL] the row written before the produce names the edit as its frontier and git_commit as what takes it", () => {
    expect([acts?.frontier, acts?.calls, acts?.frontier_widened]).toEqual([{ id: "e1", shape: "fileEditResult" }, ["git_commit"], undefined])
  })
})
