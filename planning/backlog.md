# Backlog

Everything outside the scope files of the releases. [1.0.0](1.0.0.md)
holds the road. Each item names the condition that brings it into a
release. Nothing here blocks a release until the item moves to the scope
file of that release. [Accepted risks](#accepted-risks) holds the risks
that the road leaves open.

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

**D3. A fence on the process table.** A process runs until it ends, times
out, or gets a cancel ([Processes](../docs/processes.md)). The table has
no fence, so two runs of the host over one account adopt the same
processes. **Condition:** a placement that runs two hosts over one
account.

## Supporting work

**These items stay outside 1.0.0.** Each enters a release only when its
condition holds. Each one adds to an interface and breaks none.

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

**RA1. A `retry-after` header sets the next attempt.** A 429 with a
`retry-after` header waits the backoff of the room, which can be shorter
than the provider asks. The next attempt derives from the record, so the
delay needs an optional field on the `ended` body.

**Condition:** a provider that refuses retries inside its stated delay.

**V1. A remote viewer of the canvas.** A person watches a bench from
another machine or a phone. The canvas keeps its handles in one process,
and the workbench draws a terminal alone. A viewer reads the rooms, the
widgets, and their sources through a second reader of the storage (PR3 in
`0.12.0.md`), and the host owns the sign-in.

**Condition:** a person who must watch a room away from its host.

**C1. The canvas on Cloudflare.** The Cloudflare adapter runs a room and
its seats as Durable Objects, and no canvas store or bridge runs there.

**Condition:** a deployment that needs breakout rooms or widgets on
Cloudflare.

## Open proofs

**FP1. The rules that decide liveness and spend have no proof.** The
Dafny rules stop at the fold and the admissions. `routes`, `nextAlarm`,
`renewUntil`, the window of the view, `classifyCause`, and
`contributionMatches` run with tests alone. The robustness evaluation of
2026-10-05 listed them. **Condition:** a defect in one of these functions,
or a change of [0.9.0](0.9.0.md) that moves one of them into a
`*.verified.ts`.

## Accepted risks

**The owner accepted these risks on 2026-10-05, and the road leaves them
open.** Each one is a reproduced or code-verified gap on main at
`0d1aced`. The record holds under each one: the conditional append is
atomic, a fence refuses every stale write, and a retry under the same key
lands once. An entry leaves when a fix lands, or when it moves to the
scope file of a release.

**AR3. No budget bounds an exchange or a room.** Two seats that direct
messages at each other wrote 324 messages in 3 s inside 2 activations.
Only `limits.lease.deadline` ends an activation, and the next message
starts a new one with no attempts spent. A seat can also keep 4
scheduled says pending at a 60 s floor. **Today:** monitor usage on the
`ended` entries. [D1](#designs-with-a-shape) holds the design.

**AR11. A compose child process can outlive its host.** `processRuntime`
kills its children on the `exit` event of the host. A SIGTERM with no
handler or a SIGKILL skips that event. A child in a busy loop then runs
at full CPU with no end. Code: `compose/src/process.ts`. **Today:** use
`quickjsRuntime`, or run the host under a supervisor that kills its
process group.

**AR12. An SFTP call that never returns stalls the workspace.** A
workstation file call has no deadline and no abort. A `write` to a FIFO
can block the SFTP server, and every agent waits in the one workspace
queue. This comes from the code; a real sshd has not reproduced it.

**AR16. The failure classifier reads permanence from free text.** A
proxy error page that contains "unauthorized" ends an activation in one
attempt. Code: `execution/failure.ts`. UR1 in `0.9.0.md` does not change
this classifier.

**AR18. A storage call that never settles hangs the room.** `stop()`,
`read()`, and every write wait with no deadline, and the room name stays
taken. The shipped storages are synchronous, so only a custom async
storage or Durable Object storage reaches this.

**AR20. Replay cost grows faster than the record.** At 100,000 entries,
the projection replays in 13–16 s and holds about 170 MB. Each live
entry costs time in proportion to the history, because the projection
copies whole containers. No snapshot exists. A snapshot is a cache of
the projection, so it can follow 1.0.0 with no change of format.

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
- **`visit.send` and `room.post`.** A send has an author, and a system
  message has none.
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
