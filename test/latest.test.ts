// SPDX-License-Identifier: MIT
// The clone's newest tree (x-latest): a landing is offered only on a verdict of it, and the step toward one names a diff
// of it. Read from real rows (database's pools, cut to what each leg needs): 82ac, whose clone moved with no tree and
// whose only diff and verdict are of an older tree; and 010a, a gap opened again with no clone of its own.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

type Row = Record<string, any>
// the walk's own rows carry its writer; the fixtures' alias for it is replaced by this test's walk id
const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8").replaceAll('"writer-3"', '"walk-test"')) as { root: Row; rows: Row[]; owner?: Row[]; templates?: Row[] }
const XL = (continues?: string) => ({ "x-latest": { shapes: ["gitCommitResult", "gitWorktree", "gitDiff"], moves: ["gitCommitResult", "gitWorktree"], same: "cwd", field: "tree", ...(continues ? { continues } : {}) } })
// the three owner rows the seed writes, newer than every row in the fixture
const latestRows = (continues?: string): Row[] => [
  { shape: "requires", id: "xl-req", seq: 90001, role: "owner", for: "git_land", needs: "land_verdict", where: { r: 1, tree: XL(continues) }, latest_by: "tree", group: "verdict" },
  { shape: "shape_schema", id: "xl-lv", seq: 90002, role: "owner", target: "land_verdict", variant: "", inputs: ["world_changed", { shape: "gitDiff", latest_by: "shape", where: { tree: XL(continues) } }] },
  { shape: "shape_schema", id: "xl-lvg", seq: 90003, role: "owner", target: "land_verdict", variant: "gap", inputs: ["gap", { shape: "gitDiff", latest_by: "shape", where: { tree: XL(continues) } }] },
]

describe("the clone's newest tree", () => {
  const served = new Set(["git_land", "git_diff", "land_verdict"])
  const realFetch = globalThis.fetch
  let applicable: (pool: Row[], skipped?: Row[], now?: number, note?: Row, answers?: Record<string, string>) => Promise<Array<{ id: string }>>
  beforeAll(async () => {
    Object.assign(process.env, { WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k" })
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const { pointer } = JSON.parse(String(init?.body)) as { pointer: Record<string, unknown> }
      return Response.json({ content: { vessels: served.has(String(pointer.shape)) ? [{ vesselId: "v", endpoint: "http://v.test" }] : [] } })
    }) as typeof fetch
    applicable = (await import("../src/applicable")).applicable as any
  })
  afterAll(() => { globalThis.fetch = realFetch })

  const f = fx("latest-82ac.json")
  const root = f.root.id as string
  const clone = f.rows.find((r) => r.shape === "gitWorktree") as Row // 68334: carried commits, no tree
  const cwd = clone.cwd as string
  const channel = { shape: "channel", id: "ch", seq: 2, role: "owner", calls: [] }
  const ask = { shape: "request", id: "rq-land", seq: 69300, role: "described", pointer: { type: "git_land", cwd }, input_refs: [root] }
  const T = (n: number) => String(n).repeat(40)
  const diff = (seq: number, tree: string | undefined, at = cwd, role = "walk") =>
    ({ shape: "gitDiff", id: `d${seq}`, seq, role, ...(role === "walk" ? { call_id: `c${seq}` } : {}), cwd: at, ...(tree ? { tree, head: `h${seq}` } : {}), input_refs: [root] })
  const verdict = (seq: number, tree: string) => ({ shape: "land_verdict", id: `v${seq}`, seq, role: "described", r: 1, tree, input_refs: [root] })
  const run = async (extra: Row[], withLatest = true) => {
    const skipped: Row[] = []
    const cands = await applicable([f.root, ...f.rows, ...(f.owner ?? []), channel, ask, ...(withLatest ? latestRows() : []), ...extra], skipped, Date.now(), { root }, { git_diff: "gitDiff" })
    const land = skipped.find((s) => s.id === "rq-land")
    return { ids: cands.map((c) => c.id), land: land === undefined ? undefined : String(land.unserved) }
  }
  const verdictOffered = (ids: string[]) => ids.some((id) => id.startsWith("produce/land_verdict"))

  test("[MUST-FAIL] 82ac as it is: no diff of the clone's newest tree, so the step named is a git_diff, and the old diff makes no verdict", async () => {
    const today = await run([], false) // the rows as seeded today: the old tree's diff stands in, so no diff is asked for
    expect(today.land?.includes("gitDiff comes from a git_diff call")).toBe(false)
    const now = await run([])
    expect(verdictOffered(now.ids)).toBe(false)
    expect(now.land).toContain("land_verdict is made from gitDiff, not yet here; gitDiff comes from a git_diff call")
  })

  test("[MUST-FAIL] then a diff of the clone (T3), a verdict on T3, and git_land is offered (82ac's path, no refresh)", async () => {
    const d3 = diff(69400, T(3))
    const step = await run([d3])
    expect([verdictOffered(step.ids), step.ids.includes("call/git_land")]).toEqual([true, false])
    const landed = await run([d3, verdict(69500, T(3))])
    expect([landed.ids.includes("call/git_land"), landed.land]).toEqual([true, undefined])
  })

  test("[MUST-FAIL] a later commit (T2 after the T3 diff) makes the T3 verdict stale: the step is a diff again", async () => {
    const commit = { shape: "gitCommitResult", id: "k1", seq: 69600, role: "walk", call_id: "ck", cwd, tree: T(2), input_refs: [root] }
    const r = await run([diff(69400, T(3)), verdict(69500, T(3)), commit])
    expect(r.ids.includes("call/git_land")).toBe(false)
    expect(r.land).toContain("gitDiff comes from a git_diff call")
  })

  test("[MUST-FAIL] rows that do not say where the clone is never move it: another clone, a model's row, a tree-less diff, a refused commit", async () => {
    const base = [diff(69400, T(3)), verdict(69500, T(3))]
    const other = await run([...base, diff(69700, T(4), "/elsewhere")]) // another clone's newer tree
    const model = await run([...base, diff(69700, T(9), cwd, "described")]) // a produced row naming a tree
    const plain = await run([...base, diff(69700, undefined)]) // a diff with no tree moves nothing
    const refused = await run([...base, { shape: "failure", id: "f1", seq: 69700, role: "walk", call_id: "cf", status: 200, blames: "request", input_refs: [root] }])
    expect([other, model, plain, refused].map((x) => x.ids.includes("call/git_land"))).toEqual([true, true, true, true])
  })

  test("[MUST-FAIL] a move that does not say its tree (a refresh that carried commits) leaves the tree unknown until the next diff", async () => {
    const moved = { ...clone, id: "wt2", seq: 69700, call_id: "cw2" }
    const r = await run([diff(69400, T(3)), verdict(69500, T(3)), moved])
    expect(r.ids.includes("call/git_land")).toBe(false)
    expect(r.land).toContain("the clone's newest tree is not known")
    const after = await run([diff(69400, T(3)), verdict(69500, T(3)), moved, diff(69800, T(5)), verdict(69900, T(5))])
    expect(after.ids.includes("call/git_land")).toBe(true)
  })

  test("[MUST-FAIL] a gap opened again with no clone of its own binds the clone of the gap it continues (010a), only when the owner names how", async () => {
    const g = fx("latest-010a.json")
    const tpl = g.templates?.[0] as Row
    const run010 = async (owner: Row[]) => {
      const skipped: Row[] = []
      const cands = await applicable([g.root, ...g.rows, tpl, ...owner], skipped, Date.now(), { root: g.root.id }, { git_diff: "gitDiff" })
      return { run: cands.some((c) => c.id === `run/${tpl.id}`), unbound: skipped.some((s) => s.id === tpl.id && String(s.unserved).includes("unbound")) }
    }
    expect(await run010([])).toEqual({ run: false, unbound: true }) // as today: "unbound {{ sig.in[0].cwd }}"
    expect(await run010(latestRows("gap_id"))).toEqual({ run: true, unbound: false })
  })
})
