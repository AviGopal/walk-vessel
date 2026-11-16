// SPDX-License-Identifier: MIT
// A call waiting on a person, on a real root's episode as records serves it (d929 at the moment its git_land request
// was written, 11-16; qa, research: the hand-built pools missed the schemas that root had ready). Rows scrubbed by
// database: no text, writers pseudonymised, ids remapped, times kept as distances to the fixture's now.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { join } from "node:path"

type Fx = { as_of_seq: number; now: number; awaits: boolean; root: any; shared: any[]; rows: any[] }
const fx = JSON.parse(gunzipSync(readFileSync(join(import.meta.dir, "fixtures", "d929-person-wait.json.gz"))).toString()) as Fx
const realFetch = globalThis.fetch
beforeAll(() => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
  })
  globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v", endpoint: "http://v.test" }] } })) as typeof fetch
})
afterAll(() => { globalThis.fetch = realFetch })

describe("a root waiting on a person, as records serves it", () => {
  test("[MUST-FAIL] d929 at its git_land request: the root offers only its wait (red before the fix: outcome, request and template produces)", async () => {
    const { applicable } = await import("../src/applicable")
    const ids = new Set(fx.rows.map((r) => r.id))
    const pool = [...fx.shared.filter((r) => !ids.has(r.id)), ...fx.rows].sort((a, b) => a.seq - b.seq)
    const cands = await applicable(pool, [], fx.now, { awaits: fx.awaits, shared: new Set(fx.shared.map((r) => r.id)), root: fx.root.id })
    expect(cands.map((c) => c.id)).toEqual(["wait-for"])
  })
  test("[MUST-FAIL] d929 once its first deadline has passed: still only its wait, no lapse grade (the USER: No lapse while waiting; red on f3f65ae: outcome)", async () => {
    const { applicable } = await import("../src/applicable")
    const ids = new Set(fx.rows.map((r) => r.id))
    const pool = [...fx.shared.filter((r) => !ids.has(r.id)), ...fx.rows].sort((a, b) => a.seq - b.seq)
    const first = fx.rows.filter((r) => r.shape === "due" && r.role === "described" && typeof r.within_ms === "number" && typeof r.at === "number" &&
      [r.input_refs].flat().includes(fx.root.id)).sort((a, b) => a.seq - b.seq)[0]
    const later = first.at + 60_000
    const cands = await applicable(pool, [], later, { awaits: fx.awaits, shared: new Set(fx.shared.map((r) => r.id)), root: fx.root.id })
    expect(cands.map((c) => c.id)).toEqual(["wait-for"])
  })
  test("[MUST-FAIL] through choices(): the waiting root has no option", async () => {
    const { choices } = await import("../src/loop")
    const options = await choices(fx.shared, [{ root: fx.root, rows: fx.rows, awaits: fx.awaits }], fx.now)
    expect(options.filter((o) => o.root === fx.root.id && o.cand.kind !== "wait-for")).toEqual([])
  })
})
