// SPDX-License-Identifier: MIT
// What a producer is shown as gated agrees with the frontier it is shown. A precondition bound to the call's own pointer
// (a commit needs an edit in its clone) is judged for the target the root's newest made row names: an edit in the clone
// meets it, and the commit is not shown as gated beside a frontier whose calls name it. An edit in another clone, or no
// edit yet, leaves it gated, its reasons read against that target.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const realFetch = globalThis.fetch
const keys = ["WALK_VESSEL_ID", "WALK_PORT", "DISCOVERY_URL", "WALK_ENDPOINT", "METABOB_API_KEY"] as const
const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
let applicable: (pool: any[], skipped?: any[], now?: number, note?: any, answers?: Record<string, string>) => Promise<Array<{ id: string }>>
let choices: (shared: any[], roots: Array<{ root: any; rows: any[] }>, now?: number, answers?: Record<string, string>) => Promise<any[]>
let actsFactRow: (pool: any[], root: string, write: (row: object) => Promise<any>, sel?: string, gated?: Record<string, string[]>, frontier?: any) => Promise<string | undefined>
beforeAll(async () => {
  Object.assign(process.env, {
    WALK_VESSEL_ID: "walk-test", WALK_PORT: "1", DISCOVERY_URL: "http://discovery.test", WALK_ENDPOINT: "http://walk.test", METABOB_API_KEY: "k",
  })
  globalThis.fetch = (async () => Response.json({ content: { vessels: [{ vesselId: "v" }] } })) as typeof fetch
  applicable = (await import("../src/applicable")).applicable as never
  choices = (await import("../src/loop")).choices as never
  actsFactRow = (await import("../src/acts")).actsFactRow as never
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]
})

const ANSWERS = { fs_edit: "fileEditResult", git_worktree: "gitWorktree", git_commit: "gitCommitResult", git_diff: "gitDiff" }
const owner = (id: string, seq: number, row: object) => ({ id, seq, role: "owner", ...row })
const cwd = { "x-pointer": "cwd" }
// the owner seed's commit group: an edit in the clone, a clone carrying uncommitted work, or a diff saying so
const COMMIT = [
  owner("rq-edit", 1, { shape: "requires", for: "git_commit", needs: "fileEditResult", where: { cwd }, latest_by: "cwd", group: "uncommitted" }),
  owner("rq-tree", 2, { shape: "requires", for: "git_commit", needs: "gitWorktree", where: { carried: "uncommitted", cwd }, latest_by: "cwd", group: "uncommitted" }),
  owner("rq-diff", 3, { shape: "requires", for: "git_commit", needs: "gitDiff", where: { uncommitted_any: true, cwd }, latest_by: "cwd", group: "uncommitted" }),
]
const gap = { shape: "gap", id: "g1", seq: 10, role: "detector", status: "open" }
// a clone handed out carrying commits only, as e40e's was, then an ok edit in it
const tree = { shape: "gitWorktree", id: "w1", seq: 11, role: "walk", cwd: "/trees/x", carried: "commits", input_refs: ["g1"] }
const edit = (at: string) => ({ shape: "fileEditResult", id: "e1", seq: 12, role: "walk", cwd: at, path: `${at}/src/a.ts`, ok: true, input_refs: ["g1"] })
const gatedOf = async (pool: any[]) => {
  const note: any = { root: "g1" }
  await applicable(pool, [], Date.now(), note, ANSWERS)
  return { gated: note.gated?.git_commit as string[] | undefined, calls: note.frontier?.calls as string[] | undefined }
}

describe("a commit's precondition bound to its clone is judged for the frontier's clone", () => {
  test("[MUST-FAIL] an ok edit in the clone handed out carrying commits: git_commit is the frontier's call and is not gated", async () => {
    expect(await gatedOf([...COMMIT, gap, tree, edit("/trees/x")])).toEqual({ gated: undefined, calls: ["git_commit"] })
  })

  test("[MUST-FAIL] an edit in another clone than the frontier's leaves git_commit gated, its reason read against the frontier's clone", async () => {
    const newer = { ...tree, id: "w2", seq: 13, cwd: "/trees/z" }
    const { gated, calls } = await gatedOf([...COMMIT, gap, tree, edit("/trees/x"), newer])
    expect(calls).not.toContain("git_commit")
    expect(gated?.length).toBe(1)
    expect(gated?.[0]).toContain(`cwd: the call's "/trees/z"`)
    expect(gated?.[0]).toEndWith(`for the frontier's cwd "/trees/z"`)
  })

  test("[GUARD] before any edit, the clone carrying commits only leaves git_commit gated", async () => {
    const { gated } = await gatedOf([...COMMIT, gap, tree])
    expect(gated?.length).toBe(1)
    expect(gated?.[0]).toStartWith("git_commit (requires fileEditResult")
  })

  test("[MUST-FAIL] through choices(), the request_acts row written for the root names git_commit as its call and not as gated", async () => {
    const shared = [owner("ch1", -5, { shape: "channel", calls: [] }), owner("sr", -4, { shape: "shape_schema", target: "request", inputs: ["gap"] }), ...COMMIT]
    const options = await choices(shared, [{ root: gap, rows: [gap, tree, edit("/trees/x")] }], Date.now(), ANSWERS)
    const mine = options.filter((o) => o.root === "g1")
    expect(mine.length).toBeGreaterThan(0)
    for (const o of mine) {
      const out: any[] = []
      await actsFactRow([gap, tree, edit("/trees/x")], "g1", async (row) => { out.push(row); return { id: "f1" } }, "s1", o.gated, o.frontier)
      expect(out[0]?.calls).toEqual(["git_commit"])
      expect(out[0]?.gated?.git_commit).toBeUndefined()
    }
  })
})
