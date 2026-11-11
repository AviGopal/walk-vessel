// SPDX-License-Identifier: MIT
// The rows the walk writes but does not serve, and what each is. Registration gives them to discovery as writes, so
// every reader of these rows (a producer reading the walk's pool, the template extractor) finds what they are through
// the shapeDescriptions read, without any of them becoming a shape anyone can call.
import { FAILURE, HOP, SELECTION } from "./shapes"

export const WRITTEN: Record<string, string> = {
  [HOP]: "The record of one call the walk made, not a shape to call. pointer_type is the shape it called; kind (produce, " +
    "call, run or wait-for; wait-until on older rows) is how the walk chose the call, never a shape to call. Also phase (started or " +
    "ended), selection_ref, until on a wait (the deadline it waited by) and, on ended, output: what came back.",
  [SELECTION]: "The walk's choice at one step: the candidates it had (cands) with their posteriors, the one it chose (a), " +
    "its cell and context, arm (treated or control, which decides whether a grade credits it), and pool_refs, the rows " +
    "it saw.",
  [FAILURE]: "A call that did not end well, with the status and body the producer answered; or, with kind skip, a " +
    "template the walk did not run because a shape it calls (unserved) is served by nothing (template_ref); or, with kind " +
    "too_big, an answer not kept as a row of its shape (unrecorded) because it was bytes long.",
}
