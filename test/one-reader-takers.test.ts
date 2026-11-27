// SPDX-License-Identifier: MIT
// Which call takes the root's newest made row has one reader: the calls' declared consumes (calls.ts declaredConsumes).
// The hand list it replaced (requires rows read as takers, and the out_of_scope mark it put on a call outside them) is
// gone from the source, not kept beside the declaration where a later change could read it again.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "src")
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"))

describe("one reader for what takes the frontier", () => {
  test("[GUARD] no source file names takers, takenBy or out_of_scope", () => {
    const hits = files.flatMap((f) => readFileSync(join(SRC, f), "utf8").split("\n")
      .map((line, i) => [f, i + 1, line] as const).filter(([, , line]) => /\btakers\b|\btakenBy\b|\bout_of_scope\b/.test(line)))
    expect(hits.map(([f, n]) => `${f}:${n}`)).toEqual([])
  })

  test("[GUARD] the frontier's calls and the chain step are read from the declared consumes, and no requires row's binds are read", () => {
    const src = readFileSync(join(SRC, "applicable.ts"), "utf8")
    expect(src.match(/declaredConsumes\(\)/g)?.length).toBe(2)
    expect(src).not.toMatch(/\bq\.binds\b|\.binds as Record/)
  })
})
