// SPDX-License-Identifier: MIT
// The rows the walk writes but does not serve, and what each is. Registration gives them to discovery as writes, so
// every reader of these rows (a producer reading the walk's pool, the template extractor) finds what they are through
// the shapeDescriptions read, without any of them becoming a shape anyone can call.
import { FAILURE, HOP, SELECTION } from "./shapes"

export const WRITTEN: Record<string, string> = {
  [HOP]: "The record of one call the walk made, not a shape to call: phase started or ended, kind (produce, call, run, " +
    "wait-for or wait-until), pointer_type (the shape it called) and selection_ref; on ended, output is what came back.",
  [SELECTION]: "The walk's choice at one step: the candidates it had (cands) with their posteriors, the one it chose (a), " +
    "its cell and context, and pool_refs, the rows it saw.",
  [FAILURE]: "A call that did not end well, with the status and body the producer answered; or, with kind skip, a " +
    "template the walk did not run because a shape it calls (unserved) is served by nothing (template_ref).",
}
