# Decisions

A log of calls a branch already made, and why. [`backlog.md`](backlog.md)
holds work still open; this file holds work that is closed. An open question
moves here once a branch answers it, with the answer and the alternative it
rejected.

Each entry names the date, the decision, the reason, and what it rejected.
Nobody edits an entry after the branch that made it merges. A later decision
that reverses an earlier one adds a new entry; it does not rewrite the old
one.

## 2026-09-03 — Track forward-looking work under `planning/`

**Decision.** Move `FOLLOW_WORK.md` into `planning/backlog.md`, and add
`planning/decisions.md` and `planning/changelog.md` beside it.

**Why.** The backlog, the decisions a branch has already made, and the
record of what shipped are three different spans of time — open, closed, and
released — and each had no fixed home. One folder gives each span its own
file and keeps `docs/` for design contracts only, per
[`CLAUDE.md`](../CLAUDE.md).

**Rejected.** Keeping `FOLLOW_WORK.md` at the repository root and adding the
other two files beside it. Rejected because a root file competes with
`README.md` and `CLAUDE.md` for a reader's first look, and none of the three
is a design contract or a build instruction.
