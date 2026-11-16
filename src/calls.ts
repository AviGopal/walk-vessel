// SPDX-License-Identifier: MIT
import type { Skipped } from "./applicable"
import { type Scope, type Source, bind } from "./bind"
import { DISCOVERY_URL, KEY, VESSEL_ID } from "./config"
import { AUTH_SCHEME, RESOLVE } from "./routes"
import {
  CALL, FAILURE, HOP, PRODUCE, RECORD_WAIT, RECORD_WRITE, RUN, SHAPE_DESCRIPTIONS, VESSEL_CAPABILITY, WAIT_FOR, WALK,
} from "./shapes"

export type Row = { shape: string; id: string; seq: number; [k: string]: unknown }
export type Inner = { shape: string; pointer: Record<string, unknown> }
export type Cand = {
  id: string
  kind: string
  pointer: Record<string, unknown>
  calls: Inner[]
  t: string
  /** For a call: the request row it answers, recorded on the selection so a request is called until a call ends OK. */
  from?: string
  /** For a run: its inputs, the request's rows its placeholders are filled from (bind.ts), by sig.in order. */
  inputs?: Array<Row | undefined>
  /**
   * The shapes this move consumes: a produce its schema's inputs and context, a call its request's shape, a run its
   * template's inputs, a wait none. Its cell context is the pool's shapes among these, so a shape it does not read (a new
   * owner kind, an unrelated grade) never changes what it has learned.
   */
  reads?: string[]
  /** For a produce: the key of the rows it sees, kept on its selection so a refusal over the same rows is known again. */
  seen_key?: string
}
/** pool: the ids of every row the move had, handed to the call that needs them (a produce, a run) and never stored. */
type Runner = (c: Cand, sel: Row, pool: string[]) => Promise<void>

export const STARTED = "started"
export const ENDED = "ended"

// infra: the call never got an answer (the connection was refused or reset, the body broke off): an outage between the
// walk and what it called, never a refusal of what was asked. Status 0, as every unanswered call is recorded (records
// blames it on the callee: no writer is debited, and the walk-failure detector files it as infra).
// unsent: the connection was refused, so the call provably never reached its callee (a reset or a broken body may come
// after the callee acted).
type Answer = { ok: boolean; status: number; body: unknown; text: string; infra?: true; unsent?: true }
// The errors that say a connection was never made (Bun's and Node's names for it).
const NEVER_CONNECTED = new Set(["ConnectionRefused", "ECONNREFUSED"])

// Every call the walk makes goes through here, and none throws (agf_v6jjy70pfiis: an ECONNRESET thrown out of a read the
// walk needed killed the process, and every call then in flight was cut): an error on the way is an answer, infra.
const resolve = async (pointer: object): Promise<Answer> => {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${AUTH_SCHEME} ${KEY}` },
    body: JSON.stringify({ pointer }),
    timeout: false,
  }
  try {
    const r = await fetch(new URL(RESOLVE, DISCOVERY_URL).href, init)
    if (!r.ok) {
      return { ok: false, status: r.status, body: null, text: await r.text() }
    }
    return { ok: true, status: r.status, body: (await r.json()) as unknown, text: "" }
  } catch (e) {
    const code = String((e as { code?: unknown })?.code ?? (e as { name?: unknown })?.name ?? "")
    return { ok: false, status: 0, body: null, text: `no answer: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`, infra: true,
      ...(NEVER_CONNECTED.has(code) ? { unsent: true as const } : {}) }
  }
}

// How long the walk waits for what it cannot go on without (its own rows, records' reads) while it gets no usable
// answer, asking again every READ_AGAIN_MS: well past a records or discovery restart (seconds). Past it the walk stops,
// non-zero, so its unit restarts it and the restart counter shows the fault.
export const READ_AGAIN_MS = 2_000
export const READ_WAIT_MS = 60_000

// What the walk cannot go on without. A refusal stops the walk (its unit restarts it). An outage on the way (infra) is
// asked again, within READ_WAIT_MS, rather than ending a walk whose calls are in flight: any outage for a call that may be
// made twice (repeatable: a read), and only a refused connection for one that may not (a write: records gives each
// row its own id and keeps no write key, so a write whose answer was lost after records appended it would be written
// twice, a false fact; qa). A write that may have landed stops the walk, as before.
export const loopCall = async (shape: string, pointer: object, pause: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
  now: () => number = Date.now, repeatable = true): Promise<unknown> => {
  const start = now()
  for (;;) {
    const r = await resolve({ ...pointer, type: shape })
    if (r.ok) return r.body
    if (r.infra === true && (repeatable || r.unsent === true) && now() - start < READ_WAIT_MS) {
      console.error(`${shape}: ${r.text}; asking again`)
      await pause(READ_AGAIN_MS)
      continue
    }
    console.error(`${shape} answered ${r.status}: ${r.text}`)
    process.exit(1)
  }
}

import { callProblem } from "./inputs"
export const writeRow = async (row: object): Promise<Row> =>
  (await loopCall(RECORD_WRITE, { row, writer: VESSEL_ID, role: WALK }, undefined, undefined, false)) as Row

// What each call answers with, as the serving vessels declare it to discovery (shape_answers): read once per pass, so a
// skip can name the call that makes a shape a step still needs. It only adds to what a skip says, so it never stops the
// walk: read with resolve (loopCall exits on a refusal, as it must for what the walk cannot go on without), and a
// discovery that refuses, throws or declares none is no answers: the skip then says what it said before.
// The same read keeps what each call takes (shape_inputs): the walk offers and forwards a tool call only when its callee
// declared its inputs and the pointer meets them (inputs.ts). A read that fails, or declares no inputs at all, leaves
// null: no tool call is made, and each call the walk would have offered is skipped saying why, a failure row the
// walk-failure detector reads (fail closed). Named debt (agf_fvk6ygxdhtr2): no gap is filed by the walk itself for it. Not yet read:
// undefined (a test that never reads applies no check; the loop reads it before every choice).
let declared: Record<string, unknown> | null | undefined
export const declaredInputs = (): Record<string, unknown> | null | undefined => declared
/** Tests only: as if the vocabulary had not been read (each test reads its own, or none). */
export const forgetDeclaredInputs = (): void => { declared = undefined }
export const shapeAnswers = async (): Promise<Record<string, string>> => {
  try {
    const res = await resolve({ type: SHAPE_DESCRIPTIONS })
    if (!res.ok) { declared = null; return {} }
    const r = res.body as { shape_answers?: unknown; shape_inputs?: unknown; content?: { shape_answers?: unknown; shape_inputs?: unknown } } | null
    const i = r?.shape_inputs ?? r?.content?.shape_inputs
    declared = i && typeof i === "object" && !Array.isArray(i) && Object.keys(i).length > 0 ? i as Record<string, unknown> : null
    const a = r?.shape_answers ?? r?.content?.shape_answers
    if (!a || typeof a !== "object" || Array.isArray(a)) return {}
    return Object.fromEntries(Object.entries(a as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
  } catch {
    declared = null
    return {}
  }
}

export const exists = async (shape: string): Promise<boolean> => {
  const cap = (await loopCall(VESSEL_CAPABILITY, { shape })) as { content: { vessels: unknown[] } }
  return cap.content.vessels.length > 0
}

// A tool's answer that names its own shape (git_diff answers shape gitDiff) is recorded as a row of that shape, so a
// producer can take it as an input: the walk stays the one recorder of what happened. Only when the shape is served by a
// vessel that also serves the shape called, so a tool can name its own output but cannot mint a request, an answer or an
// outcome, which other vessels serve. (Named debt: discovery does not say which of those vessels answered this call.)
// Never copied: a stored row's own stamps, and r and refused, so a recorded answer can never read as a grade or a refusal.
const OWN_FIELDS = new Set(["id", "seq", "t", "writer", "role", "shape", "r", "refused"])
const servers = async (shape: string): Promise<Set<string> | null> => {
  const r = await resolve({ type: VESSEL_CAPABILITY, shape })
  const vessels = (r.body as { content?: { vessels?: Array<{ vesselId?: unknown }> } } | null)?.content?.vessels
  return r.ok && Array.isArray(vessels) ? new Set(vessels.map((v) => String(v.vesselId))) : null
}
// Who serves a tool's answer shape, asked once per answer: whether it becomes a row (recordAnswer) and, when no vessel
// advertises it at all, what the call's ended hop says about it.
type Served = { shape: string; mine: Set<string> | null; its: Set<string> | null }
const answerServed = async (called: string, body: Record<string, unknown>): Promise<Served | undefined> => {
  const shape = body.shape
  if (typeof shape !== "string" || shape === called) return undefined
  // An answer that is itself a stored row (a records read or wait answering one) is a row already, not a tool's answer.
  if ("seq" in body || "writer" in body) return undefined
  const [mine, its] = await Promise.all([servers(called), servers(shape)])
  return { shape, mine, its }
}
// An answer whose shape no vessel advertises is not made a row (nothing vouches for it), but it is said, on the call's
// ended hop: otherwise a tool that never advertised its answer (a clone's gitWorktree) leaves every request blind to it
// with nothing anywhere saying why. On the hop, not a failure row: records withdraws a selection's credit for any
// failure row the walk writes for it, and the call itself succeeded.
const unservedNote = (s: Served | undefined): { unrecorded: { shape: string; why: string } } | Record<string, never> =>
  s && s.mine && s.its && s.its.size === 0 ? { unrecorded: { shape: s.shape, why: "unserved" } } : {}
const recordAnswer = async (sel: Row, s: Served | undefined, body: Record<string, unknown>, callId: string): Promise<void> => {
  if (!s) return
  const { shape, mine, its } = s
  if (!mine || !its || ![...its].some((v) => mine.has(v))) return
  const fields = Object.fromEntries(Object.entries(body).filter(([k]) => !OWN_FIELDS.has(k)))
  // An answer too big to read whole is not made a row: every prompt that took it as an input would carry it. The skip is
  // a failure row, so a landing that waits for that row is not left waiting on silence.
  const bytes = JSON.stringify(fields).length
  if (bytes > RECORDED_MAX) {
    await writeRow({ shape: FAILURE, kind: "too_big", call_id: callId, selection_ref: sel.id, unrecorded: shape, bytes, input_refs: [sel.id] })
    return
  }
  // It cites the request it was made for (the selection's root): what a reader needs to tie it to that request, without
  // the selection's whole pool, which grows with the request and would make the row too big to read whole.
  const cites = typeof sel.root === "string" ? [sel.root] : [sel.pool_refs].flat().map(String)
  await writeRow({ ...fields, shape, selection_ref: sel.id, call_id: callId, input_refs: cites })
}

// A tool that brought the clone it works in onto a newer base first (local-tools clone-refresh.ts) says so in its answer:
// `refreshed`, a row of its own with its own shape. The walk records it as a row, once, with the call that said it, so
// the request's rows show the clone's new base as a fresh clone's answer would. Only a tool's answer (a call, or a
// template's call): a produce's answer is a model's and never carries a row the walk would record as its own. And only
// a row of a shape a vessel serving the called shape also serves, the rule recordAnswer holds an answer to: any
// capability is a tool, so a refreshed row naming a verdict, a gap or an owner row is written by no one.
const recordRefreshed = async (sel: Row, called: string, body: Record<string, unknown>, callId: string): Promise<void> => {
  const r = body.refreshed
  if (typeof r !== "object" || r === null || typeof (r as { shape?: unknown }).shape !== "string") return
  const [mine, its] = await Promise.all([servers(called), servers(String((r as { shape: string }).shape))]).catch(() => [null, null])
  if (!mine || !its || ![...its].some((v) => mine.has(v))) {
    console.log(`[walk] a ${called} answer said refreshed as ${String((r as { shape: string }).shape).slice(0, 40)}, which no vessel serving ${called} serves: not recorded`)
    return
  }
  const fields = Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([k]) => !OWN_FIELDS.has(k)))
  const cites = typeof sel.root === "string" ? [sel.root] : [sel.pool_refs].flat().map(String)
  await writeRow({ ...fields, shape: String((r as { shape: string }).shape), selection_ref: sel.id, call_id: callId, input_refs: cites })
}

// What the walk keeps of a call's answer. A hop is shown to producers as context, so a tool's whole stdout (a 237 KB
// untracked listing, recorded on every call) would ride along in every prompt after it. Past the bound the hop keeps a
// marked start of the answer, and says how big it was. A recorded answer row may be bigger (a gitDiff is capped at
// 64 KiB where it is made), but not unbounded.
const HOP_OUTPUT_MAX = 16 * 1024
// The same bound described-shape shows an input row whole by: a gitDiff capped at 64 KiB of text, JSON-escaped.
const RECORDED_MAX = 96 * 1024
const bounded = (value: unknown, max: number): unknown => {
  const whole = JSON.stringify(value ?? null)
  return whole.length <= max ? value : { cut: true, bytes: whole.length, start: whole.slice(0, max) }
}

// The calls started and not yet ended, by call_id, with the selection each was made for: what a stop ends (stop below).
const inFlight = new Map<string, Row>()
let stopping = false
export const stopped = (): boolean => stopping

// A unit stopped mid-call (a restart of the walk, or of a unit it is part of) leaves a started hop that nothing ends,
// and a call nothing says the outcome of. So a stop writes each call still in flight a failure row, waits included: status
// 0 and no kind, which records blames on the callee, so the cell is neither credited nor debited and the request stays
// callable. Once stopping, a call that comes back writes nothing, so no call is ended twice.
const STOPPED = "the walk was stopped before the call ended"
export const stop = async (): Promise<void> => {
  stopping = true
  const open = [...inFlight]
  inFlight.clear()
  await Promise.allSettled(open.map(([callId, sel]) =>
    writeRow({ shape: FAILURE, call_id: callId, selection_ref: sel.id, status: 0, body: STOPPED, input_refs: [sel.id] })))
}

const once = async (sel: Row, kind: string, pointer: Record<string, unknown>, callId: string, args?: { args: unknown; bound: Source[] }): Promise<{ ok: boolean; row?: Row; body?: unknown }> => {
  const refs = [sel.id]
  await writeRow({
    shape: HOP, call_id: callId, phase: STARTED, kind, selection_ref: sel.id, pointer_type: String(pointer.type), input_refs: refs,
    // A template's call as it was sent, with where each filled-in value came from: a template is written once and run in
    // many requests, so what one run actually did is only here (bounded like an answer, since a write carries a file).
    ...(args !== undefined ? { args: bounded(args.args, HOP_OUTPUT_MAX), bound: args.bound } : {}),
    // A wait's bound, when it has one, so how long the walk agreed to wait is in the row, not only in the request.
    ...(pointer.until !== undefined ? { until: pointer.until } : {}),
  })
  inFlight.set(callId, sel)
  try {
    // The walk forwards a call as itself. Who wrote a row is records' stamp from the caller's key, so a forwarded pointer
    // carries no declared writer or role: under the node key, a request naming them could otherwise write as the owner,
    // a detector or a grader (agf_g65ujxjbt2l5). A record_write forwarded this way is refused by records, which takes a
    // node-key write only with both stated; the walk's own rows go through writeRow.
    const { writer: _writer, role: _role, ...forwarded } = pointer
    // what the producer (or the template) wrote: the forwarded pointer less the walk's own transport (TRANSPORT)
    const written = lessTransport(forwarded)
    // A tool call is forwarded only when it meets its callee's declared inputs (the same check that offered it, now on
    // the pointer as bound): a produce goes through a channel (via_ref) and is not a tool call. Refused here, it is a
    // failure the request is blamed for (records: a 4xx other than 401/403/408/429), so its writer is debited.
    const gate = (kind === CALL || kind === RUN) && forwarded.via_ref === undefined && declared !== undefined
      ? callProblem(declared, String(forwarded.type), written) : undefined
    if (gate !== undefined) {
      inFlight.delete(callId)
      await writeRow({ shape: FAILURE, call_id: callId, selection_ref: sel.id, status: 422, body: gate, refused: "inputs", input_refs: refs })
      return { ok: false }
    }
    const r = await resolve(forwarded).finally(() => inFlight.delete(callId))
    if (stopping) return { ok: false }
    // A 200 can carry a failure: an error at the top level, or under content, the envelope a forwarded call comes back
    // in (a federation refusal arrives as {content: {error: "unauthorized", ...}, metadata}). That is a failure, not a
    // call that ended, so the request stays callable and the row says why.
    const body = (typeof r.body === "object" && r.body !== null ? r.body : {}) as { error?: unknown; content?: { error?: unknown } }
    const said = r.ok && Boolean(body.error || (typeof body.content === "object" && body.content !== null && body.content.error))
    if (!r.ok || said) {
      // A producer may say what kind of refusal this was (described-shape marks one by the schema); kept as a field so a
      // reader does not have to guess from the status.
      const refused = ((): unknown => { try { return (JSON.parse(r.text) as { failure?: { refused?: unknown } }).failure?.refused } catch { return undefined } })()
      // A tool may say its refusal waits for a person (git_land: only a person's verdict lands this change): kept as a
      // field, read from the answer itself (top level, or under content when forwarded), so records reads the field and
      // never a body the row may have cut short. Only a tool's answer (a call, or a template's call in a run): a produce's
      // answer is written by a model, and must not be able to escape its own debit by saying it.
      const answer = kind !== CALL && kind !== RUN ? {} : r.ok ? body as Record<string, unknown> : ((): Record<string, unknown> => { try { return JSON.parse(r.text) as Record<string, unknown> } catch { return {} } })()
      const inner = typeof answer.content === "object" && answer.content !== null ? answer.content as Record<string, unknown> : {}
      const waits = answer.waits_for === "person" || inner.waits_for === "person"
      // A call that never reached a producer (no one serves the shape, or the resolver could not serve it now) is said
      // as `unserved`: the shape. Read as a field, from: a producer's failure envelope (failure.unserved, which
      // described-shape builds itself, so a model's text cannot set it), a non-200 answer (the router's or transport's
      // own body, never a produced row), or a tool's own answer (a call or a run). records blames such a failure on the
      // callee: no producer and none of the chain is debited for a call nothing answered.
      const str = (v: unknown): string | undefined => typeof v === "string" && v !== "" ? v : undefined
      // Only a non-200 is read for it from the body as sent: a 200 is the producer's answer, which a model may have
      // written, so its fields (a `failure` object included) never lower a blame (deployment).
      const sent = r.ok ? {} : ((): Record<string, unknown> => { try { return JSON.parse(r.text) as Record<string, unknown> } catch { return {} } })()
      const unserved = str((sent.failure as { unserved?: unknown } | undefined)?.unserved) ?? str(sent.unserved)
        ?? str(answer.unserved) ?? str(inner.unserved)
      await writeRow({
        shape: FAILURE, call_id: callId, selection_ref: sel.id, status: r.status,
        body: r.ok ? JSON.stringify(r.body).slice(0, 1000) : r.text, input_refs: refs,
        ...(typeof refused === "string" ? { refused } : {}),
        ...(waits ? { waits_for: "person" } : {}),
        ...(unserved !== undefined ? { unserved } : {}),
      })
      // A clone the tool moved before it failed was moved all the same: the move is recorded, as on success, or the
      // clone's rows would name a base it is no longer on.
      if (kind === CALL || kind === RUN) await recordRefreshed(sel, String(pointer.type), answer, callId)
      return { ok: false }
    }
    // The call has ended well: nothing in what follows may unsettle it. A lookup that throws (discovery restarting) means
    // no note and no row, never a failure row with no ended hop for a call whose clone, commit or landing happened.
    const served = kind === CALL || kind === RUN
      ? await answerServed(String(pointer.type), body as Record<string, unknown>).catch(() => undefined) : undefined
    await writeRow({ shape: HOP, call_id: callId, phase: ENDED, kind, selection_ref: sel.id, output: bounded(r.body, HOP_OUTPUT_MAX), input_refs: refs, ...unservedNote(served) })
    await recordAnswer(sel, served, body as Record<string, unknown>, callId)
    if (kind === CALL || kind === RUN) await recordRefreshed(sel, String(pointer.type), body as Record<string, unknown>, callId)
    return { ok: true, body: r.body }
  } catch (e) {
    if (stopping) return { ok: false }
    return {
      ok: false,
      row: await writeRow({ shape: FAILURE, call_id: callId, selection_ref: sel.id, status: 0, body: String(e), input_refs: refs }),
    }
  }
}

// A call names the selection it is made for, as a template's calls do, so a tool that keeps something per request (a
// change clone) can tell which request is asking.
// The walk's forward contract: every call it forwards carries, in its pointer, selection_ref (which selection it is
// for), and a run's or a produce's also call_id and input_refs (which call, over which rows). They stay in the pointer
// (local-tools finds a gap by the call's selection_ref), they are never held to the callee's declared inputs here (what
// the producer wrote is), and a callee that declares additionalProperties: false must list them as taken and ignored
// (records' record_summary does). Defined here only. The walk owns them: what a producer or a template wrote under
// these names is dropped before the walk adds its own, so a callee never receives a call id or rows the walk did not
// set (qa: a produced input_refs or call_id was forwarded as written, under the gate's exemption).
const TRANSPORT = new Set(["selection_ref", "input_refs", "call_id"])
const lessTransport = (p: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(p).filter(([k]) => !TRANSPORT.has(k)))

const callRunner: Runner = async (c, sel) => {
  await once(sel, CALL, { ...lessTransport(c.pointer), selection_ref: sel.id }, crypto.randomUUID())
}

const produceRunner: Runner = async (c, sel, pool) => {
  const callId = crypto.randomUUID()
  const pointer = { ...c.pointer, input_refs: pool, selection_ref: sel.id, call_id: callId }
  await once(sel, PRODUCE, pointer, callId)
}

const waitForRunner: Runner = async (c, sel) => {
  const pointer = { ...c.pointer, type: RECORD_WAIT, after_seq: sel.posts_seq }
  await once(sel, WAIT_FOR, pointer, crypto.randomUUID())
}

// Each call's placeholders are filled from the run's inputs and the answers of its calls so far (bind.ts). A call with a
// placeholder that cannot be filled is not made: a placeholder sent as text reaches the tool as a path that is not
// there. The run stops at it with a failure row naming the placeholder (kind unbound, no call made), which records
// counts against the template's writer, not the run.
const runRunner: Runner = async (c, sel, pool) => {
  const scope: Scope = { sig: { in: c.inputs ?? [] }, calls: [] }
  for (const inner of c.calls) {
    const callId = crypto.randomUUID()
    const b = bind(inner.pointer, scope)
    if (b.unbound.length > 0) {
      await writeRow({
        shape: FAILURE, kind: "unbound", selection_ref: sel.id, template_ref: c.id.slice(RUN.length + 1), unbound: b.unbound,
        body: `unbound ${b.unbound.map((p) => `{{ ${p} }}`).join(", ")}: no such field in this run`, input_refs: [sel.id],
      })
      return
    }
    const args = b.value as Record<string, unknown>
    const pointer = { ...args, type: inner.shape, input_refs: pool, selection_ref: sel.id, call_id: callId }
    const res = await once(sel, RUN, pointer, callId, { args, bound: b.sources })
    if (!res.ok) {
      return
    }
    scope.calls.push({ output: res.body, call_id: callId })
  }
}

const RUNNERS = new Map<string, Runner>([
  [CALL, callRunner],
  [PRODUCE, produceRunner],
  [WAIT_FOR, waitForRunner],
  [RUN, runRunner],
])

// A template not run because a shape it calls is unserved leaves a failure row naming those shapes, once per template
// in the episode (a row already naming it in the pool is enough), so the class is visible rather than a silent skip.
// kind "skip" says no call was made: the row has no call_id and no status, which belong to calls discovery answered.
// The selection only carries it, so it stays in the episode's pool; it is not what that selection chose.
// Once per template and reason: a template skipped again for the reason its latest skip row gives writes nothing, but
// one whose reason changed (it named a shape nothing served; now a call with no channel) writes the new reason, so the
// latest skip row never says something no longer true.
const why = (unserved: unknown): string => JSON.stringify([unserved].flat().map(String).sort())
export const recordSkipped = async (pool: Row[], skipped: Skipped[], sel: Row): Promise<void> => {
  const latest = new Map<string, Row>()
  for (const r of pool.filter((x) => x.shape === FAILURE && x.kind === "skip").sort((a, b) => a.seq - b.seq)) {
    latest.set(String(r.template_ref ?? r.request_ref), r)
  }
  for (const t of skipped.filter((x) => latest.get(x.id) === undefined || why(latest.get(x.id)?.unserved) !== why(x.unserved))) {
    const which = t.of === "request"
      // What is needed and how to make it come first: the walk keeps the start of a failure, so a long name or id never
      // pushes the reason out of what the producer is shown.
      ? { request_ref: t.id, body: `${t.unserved.join("; ")}: request ${t.id} cannot be called yet` }
      : { template_ref: t.id, body: `${t.unserved.join("; ")}: template ${t.id} cannot run` }
    // unbound: the template's placeholders this request cannot fill, which records counts against the template's
    // writer (once per request, template and placeholder), since the plan, not the run, is what failed.
    // against_refs: the rows the skip's reasons compared, named so a producer shown this skip can be shown them
    await writeRow({ shape: FAILURE, kind: "skip", selection_ref: sel.id, unserved: t.unserved, ...which, ...(t.unbound ? { unbound: t.unbound } : {}),
      ...(t.against_refs ? { against_refs: t.against_refs } : {}), input_refs: [sel.id, t.id] })
  }
}

export const execute = async (c: Cand, sel: Row, pool: string[] = []): Promise<void> => {
  // A candidate of a kind the walk has no runner for never reaches another vessel, so its failure is the walk's own,
  // marked as such (kind unrunnable), not a callee's answer.
  if (!RUNNERS.has(c.kind)) {
    await writeRow({
      shape: FAILURE, kind: "unrunnable", call_id: crypto.randomUUID(), selection_ref: sel.id, status: 400, body: c.kind, input_refs: [sel.id],
    })
    return
  }
  const runner = RUNNERS.get(c.kind) as Runner
  await runner(c, sel, pool)
}
