# Next

Five changes, in the order to do them. Each one makes the ones after it a
smaller diff. The aim is one thing: the library should read as simply as
it is described. `README.md` promises five primitives, and the package
exports about 110 names. Nothing here removes a capability. Every item
removes a concept, a boundary that is not real, or a place where the same
idea is written twice.

Numbers in brackets refer to [`backlog.md`](backlog.md).

## 1. Name the room's lifecycle, in place of three booleans

**What.** `SessionImpl` holds `replayed`, `stopped` and `evicted`, and
`gone()` reads two of them. A fourth state, superseded, is a method that
sets one of the three. The room is really in one of five states, and the
type says it can be in any combination of eight.

**Why first.** It is the smallest change here, and the next items move
this code. A split that carries three booleans into four modules spreads
the problem; a split that carries one state field does not. It also ends
a class of fault this project has already met twice: work that runs on a
room that is gone.

**Done when.** One `phase` field holds a union of the named states, and
every guard reads it. No code asks two questions to learn one fact.

## 2. Take the workspace out of the core

**What.** `src/tools/` is 704 lines: a virtual filesystem, a shell, and
the four hands an agent holds over them. `bash-env.ts` and
`just-bash.ts` mention no message, no seq and no room. `workspace.ts`
mentions the room once.

**Why.** It is a whole subject with no tie to this one. It is the
largest part of the core that a reader must skip to understand a room,
and it carries most of what stops the package bundling for a runtime
with no disk [44]. A room needs the idea of a workspace, and it does not
need a filesystem.

**Done when.** `@ambionframework/workspace` holds the backends and the
hands. The core keeps `defineWorkspace` and the handle a seat is given,
and names the backend through a port. The main entry imports no
`node:fs`.

## 3. Take the record out of the core

**What.** `src/log/` and `src/host/sqlite.ts` are 791 lines: an
append-only record over pluggable storage, fenced by run, checkpointed,
and honest about a write it is in doubt about. They import two type
modules and nothing else.

**Why.** It is the part of this project with the strongest claims and
the least to do with agents. It already has its own contract
(`docs/durability.md`), its own proofs (`rules.verified.ts`) and its own
test tiers. Nothing in it knows what a seat is. Out on its own it can be
read, trusted and reused; inside, it reads as plumbing for rooms.

**Done when.** `@ambionframework/record` holds the log, the fence, the
checkpoint and the storages. The room depends on it the way it depends
on Pi: for one concern, through one interface.

**Watch for.** The lease rules (`room/lease.ts`, `room/reconcile.ts`)
are a second candidate: work owed, attempts, backoff and expiry over a
log is a durable scheduler and nothing else. Decide that after this one,
because the two share a shape and moving both at once hides whether the
shape is right.

## 4. Split `session.ts` [3]

**What.** One class, 1439 lines, about 70 members and 18 fields. It is
the room's lifecycle, the host's API, the seat's three calls, the write
path, the reaction to every log entry, the reconcile loop, and the
waiters, in one place.

**Why now.** Items 2 and 3 take two subjects out of its reach, and item
1 gives it one state to carry. What is left is one subject seen from
three sides: a host drives a room, a seat asks it for work, and the room
answers its own log. Those are the seams, and they are already named as
three interfaces.

**Done when.** A `Room` value holds the log, the fold and the clock. The
three faces are thin modules of functions over that value:
`answers.ts` for the seat's `view`, `commit` and `lease`; the host's API;
and the reconcile loop. No module is over 400 lines, and the imperative
shell is functions over an explicit value rather than methods over
hidden fields.

## 5. Collapse the names, and publish the five

**What.** About 110 exported names for five primitives. Twelve of them
start with `Seat`. Eleven describe a session or its storage. Four
describe one room seen from a different side: `Session`, `SessionView`,
`RunningRoom`, `SeatRoom`. One is an alias of another with no difference
at all: `LeaseState` is `LeaseHold`.

**Why last.** Items 2 and 3 take whole families out with their modules,
so the pass that remains is short and the answer is clear. Doing it
first would move names that are about to leave.

**Done when.** The package's main entry exports what a host needs to
build a room and nothing else, and every other shape reaches a reader
through a named subpath. A reader who has met the five primitives can
name every export they see.
