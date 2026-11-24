// SPDX-License-Identifier: MIT
// No root waits on a person. A row saying waits_for "person" (a call's failure, a gap) is information: the root's moves
// are what they would be without it, and a passed deadline's lapse is graded as on any root. A call refused for the
// request's state is still not sent again until something new comes: that is the walk's rule for every refusal, not a
// wait on anyone.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const realFetch = globalThis.fetch
const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
let applicable: (pool: any[], skipped?: any[], now?: number, note?: any) => Promise<Array<{ id: string }>>
beforeAll(async () => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
  })
  globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "tools", endpoint: "http://tools.test" }] } })) as typeof fetch
  applicable = (await import("../src/applicable")).applicable
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]
})

const without = ({ waits_for: _w, ...r }: Record<string, unknown>) => r
const ask = { shape: "world_changed", id: "w1", seq: 1, role: "person" }
const req = { shape: "request", id: "q2", seq: 2, role: "described", pointer: { type: "git_land", cwd: "/trees/x" }, input_refs: ["w1"] }
const sel = { shape: "selection", id: "s3", seq: 3, role: "walk", a: "call/git_land", from: "q2" }
const hop = { shape: "hop", id: "h4", seq: 4, role: "walk", phase: "started", kind: "call", call_id: "c1", pointer_type: "git_land", selection_ref: "s3" }
// a land call's failure as the walk writes it (calls.ts: selection_ref and input_refs to the call's selection), saying
// waits_for person from before no change waited on one, and so stamped blames callee by records (120950's field set):
// neither the answered rule nor the settle rule reads a callee's failure, so no news is needed to call it again
const waiting = { shape: "failure", id: "f5", seq: 5, role: "walk", writer: "walk-test", call_id: "c1", selection_ref: "s3", status: 409,
  body: "{\"error\":\"only a person's verdict lands it\"}", input_refs: ["s3"], waits_for: "person", blames: "callee" }
const moves = async (pool: any[], note: any = {}) => (await applicable(pool, [], Date.now(), { root: "w1", ...note })).map((c) => c.id)

describe("a call's failure that says it waits for a person", () => {
  test("[MUST-FAIL] the call is offered again, no person's row needed: the root's moves are those of the same failure without the field", async () => {
    expect(await moves([ask, req, sel, hop, waiting])).toContain("call/git_land")
    for (const note of [{}, { awaits: true }]) {
      expect(await moves([ask, req, sel, hop, waiting], note)).toEqual(await moves([ask, req, sel, hop, without(waiting)], note))
    }
  })

  test("[MUST-FAIL] past its deadline the root is overdue and its lapse graded, as on a root whose failure says nothing", async () => {
    const shared = [{ shape: "channel", id: "ch", seq: -5, role: "owner", calls: [] },
      { shape: "shape_schema", id: "s-outcome", seq: -4, role: "owner", target: "outcome", inputs: ["world_changed"], context: ["answer", "due"] }]
    const answer = { shape: "answer", id: "a1", seq: 1.2, role: "described", text: "done", input_refs: ["w1"] }
    const due = { shape: "due", id: "d1", seq: 1.3, role: "described", within_ms: 1, at: 100, input_refs: ["w1"] }
    const seen = async (f: Record<string, unknown>) => {
      const note: any = { root: "w1", awaits: true, dues: [due.at] }
      const ids = (await applicable([...shared, ask, answer, due, req, sel, hop, f], [], 1_000, note)).map((c) => c.id)
      return { overdue: note.overdue === true, lapse: ids.includes("produce/outcome/ch") }
    }
    expect(await seen(without(waiting))).toEqual({ overdue: true, lapse: true })
    expect(await seen(waiting)).toEqual({ overdue: true, lapse: true })
  })
})

describe("a row of the root's own that says it waits for a person", () => {
  const config = [
    { shape: "channel", id: "ch1", seq: 2, role: "owner", calls: [] },
    { shape: "shape_schema", id: "sr", seq: 3, role: "owner", target: "request", inputs: ["gap"] },
  ]
  const gap = { shape: "gap", id: "g1", seq: 10, role: "detector", claim: "the source must change", waits_for: "person" }
  const ids = async (pool: any[]) => (await applicable(pool, [], Date.now(), { root: "g1", shared: new Set(config.map((r) => r.id)) })).map((c) => c.id)

  test("[MUST-FAIL] a gap marked waits_for person moves as the same gap without the mark: its request is produced", async () => {
    expect(await ids([...config, gap])).toEqual(await ids([...config, without(gap)]))
    expect(await ids([...config, gap])).not.toEqual(["wait-for"])
  })
})

describe("a refused land call is not sent again in a loop", () => {
  // records stamps a refusal for the request's state as blaming the request (fold.ts blames). Two rules then hold the
  // call: the request whose call was refused is answered, never called again (spoke/ended); and a new request for the
  // same call over the same inputs is settled until something new comes (refusedHere/settled, agf_7fcivb4rk967)
  const refused = { ...without(waiting), blames: "request" }
  const fresh = { ...req, id: "q6", seq: 6 }
  // news: a person's row of a shape a producer reads (an owner schema takes it)
  const reads = { shape: "shape_schema", id: "sx", seq: 0, role: "owner", target: "answer", inputs: ["note"] }
  const news = { shape: "note", id: "o7", seq: 7, role: "person", input_refs: ["w1"] }

  test("[GUARD] a new request for the same call after a refusal is not called while nothing new has come; a failure blaming no request leaves it called", async () => {
    expect(await moves([ask, req, sel, hop, refused, fresh])).not.toContain("call/git_land")
    // the walk's own later rows are not news
    const own = { shape: "selection", id: "s8", seq: 8, role: "walk", a: "produce/request/ch1" }
    expect(await moves([ask, req, sel, hop, refused, fresh, own])).not.toContain("call/git_land")
    expect(await moves([ask, req, sel, hop, without(waiting), fresh])).toContain("call/git_land")
  })

  test("[GUARD] the refused request itself is not called again, even once something new has come: a new request asks again", async () => {
    expect(await moves([reads, ask, req, sel, hop, refused, news])).not.toContain("call/git_land")
    expect(await moves([reads, ask, req, sel, hop, refused, news, { ...fresh, seq: 8 }])).toContain("call/git_land")
  })
})
