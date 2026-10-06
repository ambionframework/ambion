# Backlog

Everything that is not in [next.md](next.md). Each item names the
condition that brings it into a release. Nothing here blocks a release
until the item moves to that file.

**An item stays only when it meets one of four tests.** It is a defect
that someone reproduced. It waits on a decision of the owner. It closes a
gap in a room that runs unattended or in a restart that loses nothing. Or
it removes a duplicate that already breaks a rule. Git history keeps the
items that the pruning of 2026-10-03 removed.

**Each section holds only open work, except the guard lists.** Contract
pages own design details. Git history keeps completed plans, removed
findings, and prior reviews. [Considered and kept](#considered-and-kept)
and [Deferred by decision](#deferred-by-decision) stop a later review from
proposing the same change again.

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

**F2. A Pi wrapper stream receives a stub model.** `createExecutionServices`
in `packages/pi/src/services.ts` resolves every model to `stubModel` when
`stream` is set. A stream that wraps a real provider then gets a 1,000,000
token context window. Pi computes its compaction threshold from that
window, so it does not compact in time. Cost under-counts only when the
wrapper forwards the stub to a provider stream. Fix: an optional `model`
resolver beside `stream`; the stub applies only when `stream` is set and
`model` is not. **Condition:** a host passes a stream that reaches a real
provider.

## Release and CI

**R1. A billing failure reads as a billing failure.** Twenty-three red
live runs in a row had one cause, and each run read as a set of test
failures. Before the tests, each harness job makes one small request. A
billing or authentication refusal fails the job with an annotation that
names the provider error, and the tests do not run. **Condition:** the
next live run that fails on a provider refusal.

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
minutes adds about 1,000 returned says in a week. The first step, a render
rule for a closed exchange with no spoken message, is UR2 in
[the plan](next.md). The second step lets a seat write a summary over its
own range. **Condition:** a measured context cost from a self-scheduling
seat after UR2.

**The second step can make a close a message.** A close that routes to
the summary writer makes the summary an ordinary respond activation. The
`closed` activation source, `owed.ts`, `closedLeases`, `closeFor`, and
`summaryWriter` on the close then go, and the `assistant` option goes with them. Due work
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

## Supporting work

**These items stay outside 1.0.0.** Each enters a release only when its
condition holds.

**RC1. Range recall in the own room.** `recall` grows two selections:

```text
recall({ refs })              // as today, 1 to 16 refs
recall({ from, through? })    // a seq range; { from: 1 } reads the whole room
recall({ last })              // the N most recent messages
  + optional { kind?, by? }   // filters
```

A result has a byte cap and names the next `from` on its last line. The
authority does not change: a live lease, and a summary reads only through
its exchange. `room.view` takes the selection, so the Durable Object wire
changes. A long worker reads its own room past its window on every host,
Cloudflare included, with no mirror.

**Condition:** a measured need for own-room reads beyond the window.

**Evidence:** a test reads a range, the last N messages, and a filter
over a real journal. The export snapshot, the golden journals, and the
Cloudflare tests change in the same commit.

**SP1. The speaking text of the room core.** The room core states the
rule of silence about five ways, in about 720 tokens. It is the largest
block on a bare seat. Cut it to one statement of each fact. The guidance
review of #535 tuned this text against live runs, so one live run on the
ChatGPT login runs before the cut and one after.

**Condition:** a measured context cost that justifies provider spend.

**Evidence:** the token count of a bare seat before and after, and the
two live runs.

**V1. A remote viewer of the canvas.** A person watches a bench from
another machine or a phone. The canvas keeps its handles in one process,
and the workbench draws a terminal alone. A viewer reads the rooms, the
widgets, and their sources through a second reader of the storage (PR3 in
[the plan](next.md)), and the host owns the sign-in.

**Condition:** a person who must watch a room away from its host.

**C1. The canvas on Cloudflare.** The Cloudflare adapter runs a room and
its seats as Durable Objects, and no canvas store or bridge runs there.

**Condition:** a deployment that needs breakout rooms or widgets on
Cloudflare.

## Considered and kept

**Each of these looks like a duplicate and carries a meaning of its
own.** A later review does not propose them again.

- **Two owners close the forward cache.** The close in `dispose` stops
  pending forwards at once. The close in `withProcesses` waits for the
  processes.
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

- A `task()` or subagent tool; breakout rooms carry delegated work.
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
