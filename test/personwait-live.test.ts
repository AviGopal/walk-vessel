// SPDX-License-Identifier: MIT
// No root waits on a person, on a real root's episode as records serves it (d929 at the moment its git_land request
// was written, its land failure saying waits_for person): its moves are those of the same rows with the field gone. Rows scrubbed by
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

const strip = (rs: any[]) => rs.map(({ waits_for: _w, ...r }) => r)
const pool = (rows: any[], shared: any[]) => {
  const ids = new Set(rows.map((r) => r.id))
  return [...shared.filter((r) => !ids.has(r.id)), ...rows].sort((a, b) => a.seq - b.seq)
}

describe("a root whose row says it waits on a person, as records serves it", () => {
  const moves = async (rows: any[], shared: any[], now: number) => {
    const { applicable } = await import("../src/applicable")
    return (await applicable(pool(rows, shared), [], now, { awaits: fx.awaits, shared: new Set(shared.map((r) => r.id)), root: fx.root.id })).map((c) => c.id)
  }
  test("[MUST-FAIL] d929 at its git_land request: its moves are those of the same rows without waits_for, more than a wait", async () => {
    expect(fx.rows.some((r) => r.waits_for === "person")).toBe(true)
    const got = await moves(fx.rows, fx.shared, fx.now)
    expect(got).toEqual(await moves(strip(fx.rows), strip(fx.shared), fx.now))
    expect(got.filter((id) => id !== "wait-for").length).toBeGreaterThan(0)
  })
  test("[MUST-FAIL] d929 once its first deadline has passed: the same moves as without waits_for, more than a wait", async () => {
    const first = fx.rows.filter((r) => r.shape === "due" && r.role === "described" && typeof r.within_ms === "number" && typeof r.at === "number" &&
      [r.input_refs].flat().includes(fx.root.id)).sort((a, b) => a.seq - b.seq)[0]
    const later = first.at + 60_000
    const got = await moves(fx.rows, fx.shared, later)
    expect(got).toEqual(await moves(strip(fx.rows), strip(fx.shared), later))
    expect(got).not.toEqual(["wait-for"])
  })
  test("[MUST-FAIL] through choices(): the root has the options it has without waits_for", async () => {
    const { choices } = await import("../src/loop")
    const ids = async (rows: any[], shared: any[]) => (await choices(shared, [{ root: fx.root, rows, awaits: fx.awaits }], fx.now))
      .filter((o) => o.root === fx.root.id).map((o) => o.cand.id)
    const got = await ids(fx.rows, fx.shared)
    expect(got).toEqual(await ids(strip(fx.rows), strip(fx.shared)))
    expect(got.filter((id) => id !== "wait-for").length).toBeGreaterThan(0)
  })
})
