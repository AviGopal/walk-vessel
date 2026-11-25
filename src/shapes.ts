// SPDX-License-Identifier: MIT
export const VESSEL_CAPABILITY = "vesselCapability"
// Discovery's read of what the serving vessels declare of their shapes (descriptions, inputs, and the shape each call
// answers with).
export const SHAPE_DESCRIPTIONS = "shapeDescriptions"
export const SELECTION = "selection"
export const HOP = "hop"
export const FAILURE = "failure"
export const POSTERIOR = "posterior"
export const RECORD_READ = "record_read"
export const RECORD_WRITE = "record_write"
export const RECORD_WAIT = "record_wait"
export const RECORD_WAIT_EXACT = "record_wait_exact"
export const ARM = "arm"
export const REQUEST = "request"
export const DUE = "due"
export const OUTCOME = "outcome"
export const ACTIVITY_TEMPLATE = "activity_template"
export const CHANNEL = "channel"
export const SHAPE_SCHEMA = "shape_schema"
// The owner's precondition on a call (records): {for, needs, where}.
export const REQUIRES = "requires"
export const WALK_HEARTBEAT = "walk_heartbeat"
export const PRODUCE = "produce"
export const CALL = "call"
export const RUN = "run"
export const WAIT_FOR = "wait-for"
export const WALK = "walk"
export const PERSON = "person"
export const OWNER = "owner"
export const DESCRIBED = "described"
// The owner's record of a span when a vessel was restarted; one that installed code names what it installed
// (installed: [{repo, commit, vessel}]).
export const INFRA_WINDOW = "infra_window"
// The owner's schedule for a template the walk runs when due (records shares it with the template it names).
export const RHYTHM = "rhythm"
// The owner's word on what makes a result news: for a shape, the fields whose values identify it (a diff's tree and its
// checks), so a result that differs only elsewhere (a test's timings) is not news. With none, all of it is compared.
export const NEWS_KEY = "news_key"
// The owner's word on which clone a root binds when it holds clones of more than one repo and a template names none: the
// repo field of the root's own newest row of the shapes it lists, in order (an ask's change_wanted.repo).
export const CLONE_BINDING = "clone_binding"
// The owner's word on when a root that has no move is said to be stalled: after how many store rows since its newest.
export const STALL_RULE = "stall_rule"
// The owner's word on what reaches a root of a kind (target) and by which call (by_call): a gap by a landing.
export const CREDITS = "credits"
// The walk's word (a failure's kind) for a root that sat with no move for the stall_rule's count: its own, as skip is.
export const STALL = "stall"
