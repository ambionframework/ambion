# Backlog

Everything that is not in [next.md](next.md). Each item names the
condition that brings it into a release. Nothing here blocks a release
until the item moves to that file.

**An item stays only when it meets one of four tests.** It is a defect
that someone reproduced. It waits on a decision of the owner. It closes a
gap in a room that runs unattended or in a restart that loses nothing. Or
it removes a duplicate that already breaks a rule. Git history keeps the
items that the pruning of 2026-10-03 removed.

**The sections come in the order of their priority.** Inside a section,
the first item comes first. An item whose condition holds moves to the
top of its section.

| Section                                       | Items  | First item                               |
| --------------------------------------------- | ------ | ---------------------------------------- |
| [The 0.7.0 theme](#the-070-theme)             | B1     | B1, breakout rooms                       |
| [Pending decisions](#pending-decisions)       | Q1, Q2 | Q1, the `assistant` option               |
| [Known defects](#known-defects)               | F1     | F1, the allow-list of the SQL guard      |
| [Release and CI](#release-and-ci)             | R1     | R1, a billing failure reads as one       |
| [Rules and proofs](#rules-and-proofs)         | P1     | P1, `returnable` into the verified rules |
| [Simplification](#simplification)             | S1–S7  | S1, one name rule                        |
| [Designs with a shape](#designs-with-a-shape) | D1–D4  | D1, bounds on unattended work            |
| [Considered and kept](#considered-and-kept)   | None   | None                                     |
| [Deferred by decision](#deferred-by-decision) | None   | None                                     |

## The 0.7.0 theme

**B1 is the likely theme of 0.7.0.** The owner named it on 2026-10-03. It
moves to [next.md](next.md) when 0.7.0 planning starts.

**B1. Breakout rooms.** An agent opens a room for background work. A
person can visit the room and read its exchanges. The room is the room
equivalent of a background `bash` process, with messages in both
directions.

**The executors' native subagents stay off.** Claude runs with `tools:
[]`, so it has no `Task` tool (`packages/claude/src/options.ts`). Codex
runs with `multi_agent` off and no `spawn_agent` tool
(`packages/codex/src/catalog.ts`). A native subagent lives in the vendor
session and writes no entry. A crash loses it, and the host cannot see
or bound its spend.

**A worker seat in the same room costs every other seat.** Its directed
says are entries of the parent room. They fill the window of each seat,
and the undirected ones wake each `broadcast` seat. A breakout room keeps
the work in a journal of its own. That journal is durable, replays, and
takes visits.

**The kernel holds every part except the open.**

| Need                    | Part that exists                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Make the room           | The host makes rooms. The workbench does.                                                                                 |
| Seat the workers        | `room.seat` from the reserve                                                                                              |
| Send the goal and notes | `room.post` with `to` and `key` wakes or steers the target and lands once across a restart                                |
| Read the exchanges      | [The room mirror](../docs/workspace.md#mirror-a-rooms-messages) on a shared workspace. `recall` reads its own room alone. |
| Return the result       | The host posts a line for each closed exchange of the breakout room into the parent room, with a ref to its range         |

**[Breakout rooms](../docs/breakout.md) states the design.** The first
step is a host tool bundle with no change to the kernel.
`breakout({ goal, agents })` opens a room, seats the agents, and posts the
goal. `tell({ room, text })` posts to a room that the caller opened. The
mirror serves reads. Each journal holds its own entries, and the posts
carry the refs between them.

**Two decisions come first:**

1. **Who may open a breakout room.** An open is spend, so the host bounds
   it: the count, the depth, and the agents that a breakout room may
   seat. D1 holds the accounting.
2. **A post has no author.** A seat in the breakout room tells the parent
   agent from another source by a label in the text. An author across
   rooms is a new trust surface, and the first step adds none.

**Condition:** the owner starts 0.7.0 planning.

## Pending decisions

**Each item waits on a decision of the owner.** It joins a release only
when the owner says yes.

**Q1. The `assistant` room option.** `normalizeAssistant` in
`packages/ambion/src/room.ts` turns the option into an `agents` entry, a
`broadcast` seat, and the `summaryWriter`. The kernel then holds a role
that it otherwise treats as ordinary. The question: does the option go,
with a helper in `@ambionframework/assistant` that returns the three
options? The executor of the assistant is settled: `defineAssistant`
takes an `executor` function. A close as a message (D2) removes the
option with it.

**Q2. Sensors fail the test that the actuator page states.** The sensor
path adds `connect`, `disconnect`, `observe`, and a versioned wire API,
about 2,100 lines of `packages/workspace`. [Actuators](../docs/actuators.md)
runs a controller as an ordinary `bash` process, and `curl` and
`snapshot` give the same bytes as `observe`. The question: does the
sensor path shrink to the actuator pattern?

## Known defects

**F1. An agent that runs SQL can lift the append-only guard.** The guard
of `sqliteBackend` refuses the statements that it names: `CREATE
TRIGGER`, a DROP or ALTER of a guarded table, `ATTACH`, and the PRAGMAs
`recursive_triggers`, `writable_schema`, and `query_only`. A statement
that it does not name can still lift it. On 2026-09-29 a review lifted it
on Node 22 and Node 26 with `PRAGMA temp_store`, which drops the TEMP
triggers of the guard at compile time. An allow-list closes the class: an
agent call runs only a fixed set of statement kinds, and only the PRAGMAs
that read. Node 22 has no `setAuthorizer`, so the allow-list reads the
text there. **Condition:** a room that gives the `sql` tool to an agent
that the owner does not trust, or a second bypass in use.

## Release and CI

**R1. A billing failure reads as a billing failure.** Twenty-three red
live runs in a row had one cause, and each run read as a set of test
failures. Before the tests, each harness job makes one small request. A
billing or authentication refusal fails the job with an annotation that
names the provider error, and the tests do not run. **Condition:** the
next live run that fails on a provider refusal.

## Rules and proofs

[docs/formal.md](../docs/formal.md) states the mechanism and the line a
proof must pay for.

**P1. `returnable` moves into the verified rules.** The rule decides when
the room returns a scheduled say, and `reconcile.ts` and `returning` call
it. It lives in `packages/ambion/src/room/scheduled.ts`, outside
`room/rules.verified.ts`, so it has no contract and no binding case.
**Condition:** none.

## Simplification

**This section lists the concepts that the repository holds twice.** A
concept goes when another concept already carries its meaning. The rank is
the concepts removed times the confidence (high 3, medium 2, low 1).
Twenty-six reductions and W5 have landed. The changelog and the git
history record them.

| ID  | Finding                                                            | Evidence                                                                                                                                                                                         | Rank |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| S1  | One name rule is written fourteen times                            | Core: `NAME_PATTERN`, `SEAT`. Workspace: nine literals in seven sensor files, `NAMESPACE`. Workstation: the serve pattern. Workbench: `ROOM_NAME`, with a bound of 48 that the core does not set | 12   |
| S2  | The close rule is written three times                              | `reconcile.ts` plans it with `admitsClose`, `transition.ts` checks it again, and `room-run/control.ts` writes its complement. `decide` can return written, not owed, or plan again               | 6    |
| S3  | The publication tail keeps caches because it lacks the prior state | `heardLeases`, `heardCloses`, and `seedHeard` in `room-run/`. A step that hands the hearer the state before the entry derives both                                                               | 6    |
| S4  | One in-doubt append is written four times                          | Cancel, arrival, departure, and stop each keep a promise and a key in `room-run/`. One keyed single-flight helper serves all four                                                                | 6    |
| S5  | A package import sets the default execution of its kind            | `defaults` in `execution/route.ts` is module state, and resolution reads three tiers. The one value in the definitions that is not a value                                                       | 6    |
| S6  | `resources.md` overlaps `workspace.md` and states a false count    | `resources.md` says "two bindings"; seven backend factories exist                                                                                                                                | 3    |
| S7  | "Envelope" has three meanings                                      | `envelope.md`, `durability.md`, `formal.md`                                                                                                                                                      | 3    |

**S2, S3, and S4 change nothing that a host sees.** They stay inside
`room-run/` and `reconcile`, and one change can carry all three. S5
changes the quickstart. S6 and S7 change only pages.

## Designs with a shape

**Rooms that run unattended come first.** A room that stays available
between interactions runs on the room's clock with no person present.
These designs bound, fold, and recover such a room.

**D1. Bounds on unattended work.** The former SK1 proposal did not define
its accounting or admission contract. A design states what it bounds,
how concurrent work counts, and what happens at the boundary. It covers
three bounds:

- **Spend and quotas** for an exchange.
- **The work of an exchange**, as a kernel-enforced bound.
- **A chain of scheduled says.** A returned say can lead to another
  scheduled say. The schedule limits bound one delay and the pending
  count, and nothing bounds the chain.

**Condition:** an application requires a kernel-enforced bound.

**D2. Compaction with no person.** A summary goes to a person, so an
exchange where no person spoke never folds. A monitor that ticks each ten
minutes adds about 1,000 returned says in a week. The first step is a
render rule: a closed exchange with no spoken message shows as one line,
and `recall` still reads it. A later step lets a seat write a summary over
its own range. **Condition:** a measured context cost from a
self-scheduling seat.

**The second step can make a close a message.** A close that routes to
the summary writer makes the summary an ordinary respond activation. The
`closed` activation source, `owed.ts`, `closedLeases`, `closeFor`, and
`summaryWriter` on the close then go, and Q1 goes with them. Due work
becomes one list, and a scheduled say becomes one entry. The review of
2026-10-02 priced the change:

- **The purpose moves into a rule.** A summary reads to its close, reads
  the preferences of the person, and writes one summary for each person.
  These become rules on the kind of the message that woke the writer.
- **A close must not wake the writer in a loop.** A close routes to the
  writer only when a person spoke in its range, as `summaryVerdict` says
  today.
- **The tools still branch.** A summary `say` drops `readThrough`, holds no
  agent tools, and ends after the last recipient.
- **`fixed` stays** unless a close can reach a writer that has no seat.

**D3. A fence on the process table.** A process runs until it ends, times
out, or gets a cancel ([Processes](../docs/processes.md)). The table has
no fence, so two runs of the host over one account adopt the same
processes. **Condition:** a placement that runs two hosts over one
account.

**D4. One stored source for the roster.** A composition seeds the roster
from its `agents`, and each seating and unseating changes it. A
recomposition resets the roster, so it drops a seating that a seat made.
The change writes one seating for each seat at a start and drops `agents`
from the composition. **Condition:** a recomposition that must keep a
seating that a seat made.

## Considered and kept

**Each of these looks like a duplicate and carries a meaning of its
own.** A later review does not propose them again.

- **Two owners close the sensor connections.** The close in `dispose`
  stops pending connects at once. The close in `withProcesses` waits for
  the processes.
- **The simulator keeps `deadlineSignal`, and the workbench keeps its
  usage formatter.** A test pins the reason of the timeout.
- **`pi()` and `piExecution()`.** One definition runs on different
  executions.
- **The unions that `rules.verified.ts` declares again.** LemmaScript
  lowers only the types of its own file.
- **`startRoom` and `resumeRoom`.** A start writes a composition, and a
  resume keeps the recorded one.
- **`visit.send` and `room.post`.** A send has an author, and a post is a
  message of the system.
- **`sqlite.ts` and `sqlite-guard.ts`.** They are one concept in two files.
- **The port suite and the executor suite.** Cloudflare runs the port
  suite.
- **The record line.** The core has one `renderLine`, and
  `execution/render.ts` calls it. The simulator's `messageLine` writes
  `[seq]` and quotes the text as JSON, so a newline cannot start a false
  line in the judge input.
- **`localExecution`.** A host needs one execution of a kind that is not a
  family.
- **The scripts in `scripts/`.** Each holds one concern.
- **Presence and the roster.** Two folds of a like shape carry two
  meanings. A person opens an exchange and receives a summary, and a seat
  does neither.
- **The journal package and its generics.** Its proofs read no meaning of
  the room, and SQLite and Durable Objects satisfy its port.
- **The `compose` tool in the core.** It uses what the core owns: the
  signal, the deadline, the `parent` step, `callId`, and `ToolContext`. A
  separate package would import all of them.

## Deferred by decision

- Hot-loaded definitions; the definition set is fixed per run.
- Multiple simultaneous discussions within one room; separate rooms.
- Per-tab presence tokens and automatic departures; hosts reconcile.
- Distributed workspace ownership; one owner per resource.
- Automatic summary skipping by message count; manual summary retry.
- Agent source retrieval and pagination under the shared summary policy.
- Browser-only execution, a managed service, arbitrary edge platforms,
  turnkey deployment commands, multiple terminal clients.
- A `SeatObject` class rename in the Cloudflare adapter; it needs Durable
  Object migration evidence.
- A provider-neutral plugin ecosystem beyond the executor contract.
- A second live-tier provider job. Add one only if a provider-specific
  defect turns up.
