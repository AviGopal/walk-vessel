// SPDX-License-Identifier: MIT
// Whether a tool call's pointer meets the inputs its callee declared to discovery (shape_inputs): the walk offers and
// forwards a call only then, so a model's request can reach only what a vessel said it takes, in the form it said
// (research, deployment: a produced record_read could have read whole rows). The vessels' declarations decide; no tool
// is named here. A schema this check cannot fully judge (a keyword it does not know) is not met, and says which: it
// fails closed rather than pass what it could not read.

type Schema = Record<string, unknown>

// What this check knows how to judge; every other keyword in a declaration fails the check, named.
const KNOWN = new Set([
  "type", "required", "properties", "additionalProperties", "items", "enum", "const",
  "minLength", "maxLength", "pattern", "minimum", "maximum", "minItems", "maxItems",
  // words that say nothing about what is valid
  "description", "title", "examples", "default",
])
// Keys a walk's own forwarding adds to a pointer, never part of what a call takes
const FORWARDING = new Set(["type"])

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v

// A value as a refusal or a skip shows it, so the next producer sees what it sent, but only when it is plainly not a
// credential: a value holding a run of 16 or more of the characters keys and tokens are written in (letters, digits,
// "+", "/", "=", "_", "-": base64 and its URL form, hex, the common token alphabets) that mixes at least two of upper
// case, lower case and digits, or longer than the cap, is withheld with its length. A run in one case only is a name or
// a path ("human-surface-vessel", "repos/human-surface-vessel/src/ui-views.ts"), not a key, and stays shown. Refusals
// land in rows the surface shows, so nothing key-shaped is copied there (research, deployment, qa).
const RUN = /[A-Za-z0-9+/=_-]{16,}/g
const keyLike = (j: string): boolean => (j.match(RUN) ?? [])
  .some((r) => [/[A-Z]/, /[a-z]/, /[0-9]/].filter((c) => c.test(r)).length >= 2)
export const shownValue = (v: unknown, cap: number): string => {
  const j = JSON.stringify(v) ?? String(v)
  return j.length <= cap && !keyLike(j) ? j : `[value withheld, ${j.length} chars]`
}
const shown = (v: unknown): string => shownValue(v, 80)

const fits = (want: unknown, v: unknown): boolean => {
  const ts = [want].flat().map(String)
  const t = typeOf(v)
  return ts.some((w) => w === t || (w === "number" && t === "integer"))
}

/** The first way value fails schema, as a short reason with its path; undefined when it meets it. */
export const problem = (schema: unknown, value: unknown, at = ""): string | undefined => {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return `${at || "the pointer"}: its declared inputs are not a schema`
  const s = schema as Schema
  const unknown = Object.keys(s).filter((k) => !KNOWN.has(k))
  if (unknown.length > 0) return `${at || "the pointer"}: its declaration uses ${unknown.join(", ")}, which this check cannot judge`
  const where = at || "the pointer"
  if (s.type !== undefined && !fits(s.type, value)) return `${where} is ${typeOf(value)}, not ${[s.type].flat().join(" or ")}`
  // what was sent and the rule it broke, so the next producer can see what to change (a refusal naming neither left
  // the request producer guessing: "entries[3].words[0] does not match its pattern", 598a988a)
  if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(value)) return `${where} is ${shown(value)}, not ${shown(s.const)}`
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return `${where} is ${shown(value)}, not one of ${shown(s.enum)}`
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) return `${where} is shorter than ${s.minLength}`
    if (typeof s.maxLength === "number" && value.length > s.maxLength) return `${where} is longer than ${s.maxLength}`
    if (typeof s.pattern === "string") {
      let re: RegExp
      try { re = new RegExp(s.pattern, "u") } catch { return `${where}: its declared pattern cannot be read` }
      if (!re.test(value)) return `${where} is ${shown(value)}, which does not match its pattern ${s.pattern}`
    }
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) return `${where} is below ${s.minimum}`
    if (typeof s.maximum === "number" && value > s.maximum) return `${where} is above ${s.maximum}`
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) return `${where} has fewer than ${s.minItems} items`
    if (typeof s.maxItems === "number" && value.length > s.maxItems) return `${where} has more than ${s.maxItems} items`
    if (s.items !== undefined) for (let i = 0; i < value.length; i++) { const p = problem(s.items, value[i], `${where}[${i}]`); if (p) return p }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const v = value as Record<string, unknown>
    for (const k of [s.required ?? []].flat().map(String)) if (v[k] === undefined) return `${where} lacks ${k}`
    const props = (typeof s.properties === "object" && s.properties !== null ? s.properties : {}) as Record<string, unknown>
    for (const [k, sub] of Object.entries(props)) {
      if (v[k] === undefined) continue
      const p = problem(sub, v[k], at ? `${at}.${k}` : k)
      if (p) return p
    }
    if (s.additionalProperties === false) {
      const extra = Object.keys(v).filter((k) => !(k in props) && !(at === "" && FORWARDING.has(k)))
      if (extra.length > 0) return `${where} has ${extra.join(", ")}, which it does not take`
    }
  }
  return undefined
}

/** Why a call of this type with this pointer may not be made, or undefined when it may: the tool must have declared its
 * inputs, and the pointer (less the walk's own forwarding keys) must meet them. inputs null: the vocabulary could not be
 * read, so no call is made. */
export const callProblem = (inputs: Record<string, unknown> | null, type: string, pointer: Record<string, unknown>): string | undefined => {
  if (inputs === null) return `${type}: the declared inputs could not be read, so no call is made`
  if (!(type in inputs)) return `${type}: no declared inputs`
  const p = problem(inputs[type], pointer)
  return p === undefined ? undefined : `${type}: ${p}`
}
