// SPDX-License-Identifier: MIT
// The rows the walk writes but does not serve, and what each is. Registration gives them to discovery as writes, so
// every reader of these rows (a producer reading the walk's pool, the template extractor) finds what they are through
// the shapeDescriptions read, without any of them becoming a shape anyone can call.
import { REQUEST_ACTS } from "./acts"
import { FAILURE, HOP, SELECTION } from "./shapes"

export const WRITTEN: Record<string, string> = {
  [REQUEST_ACTS]: "What a request has already done, from its own rows: acts (each call of a tool the owner gates on a " +
    "wanted change: tool, ok, at_seq, and path, repo or sha when its answer gave one) and not_called (those tools never " +
    "called on it). Only those tools, the ones that change something: reads and other calls are not listed. A " +
    "template (activity_template) is a plan for the request that wrote it, never an act on another. repeats: a step it " +
    "keeps repeating with the same result over the same inputs (the same failure, or a tree graded the same), " +
    "n times, nothing new since: a person's or the owner's row, or an answer the step takes in. gated: each gated " +
    "call not yet allowed here and what it needs (a need \"for the target the call names\" holds per target). frontier: " +
    "its newest made row {id, shape}; calls: the calls whose requires take it, an offer (another stays callable, its " +
    "selection marked out_of_scope); frontier_widened: none takes it. Written by the walk when it changes.",
  [HOP]: "The record of one call the walk made, not a shape to call. pointer_type is the shape it called; kind (produce, " +
    "call, run or wait-for; wait-until on older rows) is how the walk chose the call, never a shape to call. Also phase (started or " +
    "ended), selection_ref, until on a wait (the deadline it waited by) and, on ended, output: what came back, and " +
    "unrecorded {shape, why} when that answer's shape is one no vessel serves, so it was kept only here, not as a row of it.",
  [SELECTION]: "The walk's choice at one step: the candidates it had (cands) with their posteriors, the one it chose (a), " +
    "its cell and context, arm (treated or control, which decides whether a grade credits it), pool_refs, the rows " +
    "it saw, and timing: how long the tick's parts took (ms) and how many tries each read needed. Timing is never a key. " +
    "frontier, calls and frontier_widened: the chosen root's newest made row and the calls that take it, as " +
    "request_acts says them; out_of_scope: the call chosen is not one of the calls its request's frontier is taken by.",
  [FAILURE]: "A call that did not end well, with the status and body the producer answered; or, with kind skip, a " +
    "template the walk did not run because a shape it calls (unserved) is served by nothing or not yet allowed " +
    "(template_ref), or a request whose call the owner's preconditions do not yet allow (request_ref, unserved naming " +
    "what it requires); or, with kind " +
    "too_big, an answer not kept as a row of its shape (unrecorded) because it was bytes long, its body saying what " +
    "follows (what requires that shape is not met by this call; read it in parts), and, for a request's call, the " +
    "request (request_ref) with that reason in unserved, so its producer is shown it; or, with kind " +
    "unrunnable, a move of a kind the walk cannot run; or, with status 0 and body saying so, a call the walk was " +
    "stopped in the middle of.",
}
