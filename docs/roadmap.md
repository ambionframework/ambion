# The Roadmap

The vision, in one sentence:

> **A workspace is the home of ambient-aware, always-on agents — a place
> where agents live rather than run: holding files, tasks, and rooms; woken
> through sources by timers, events, and its own tasks; visited by humans
> who steer rather than operate.**

[`agent.md`](agent.md) is the shipped core. [`concepts.md`](concepts.md)
fixes _what_ the rest of Ambion is. This document fixes _when_. It states
what the next iteration builds, what waits, and, for each item that
waits, the seam through which it arrives.

## Order

There are fifteen items. The next iteration builds items 1 to 4. Two
separate arguments put the line there.

**Items 1 to 3 are foundation.** They deliver three things that
everything else stands on: a record that survives the process, a
workspace that holds a roster, and seats that know where they live.

**Item 4 is retrofit cost.** Almost every other concept can arrive later
at no cost. Law 7 makes everything downstream of the record rebuildable
and forbids it to write back. Compaction, entities, the consolidated
history, and accounting are all views, and a view can be built on the day
that it is needed. What is expensive later is the shape of what the
runtime writes. Provenance therefore goes in before durable records
exist to migrate, although nothing produces one yet.

Every item after 4 is scheduled behind what it needs, and names the seam
through which it arrives. No later item is blocked on a decision that the
first four foreclose.

| #   | Item                      | Of                                               | Needs     |
| --- | ------------------------- | ------------------------------------------------ | --------- |
| 1   | The record store          | the core — implemented                           | —         |
| 2   | The workspace             | the workspace — its roster                       | 1         |
| 3   | Instantiation             | the workspace — into seats                       | 2         |
| 4   | Provenance                | **the source**, **the channel** — their contract | 1         |
| 5   | The tree and the boundary | the workspace — its identity                     | 3         |
| 6   | Compaction                | the core — kept affordable                       | 1         |
| 7   | Entities and settings     | the workspace — its state                        | 1, 2      |
| 8   | Tasks                     | **the task**                                     | 7         |
| 9   | Sources                   | **the source**                                   | 4, 6      |
| 10  | Reaching humans           | **the channel**                                  | 4         |
| 11  | The consolidated history  | a merge over the records                         | 2         |
| 12  | Guardrails                | law 8 — the spent scope                          | 9, 10, 11 |
| 13  | Timers                    | the source — an instance                         | 8, 9      |
| 14  | Events                    | the source — an instance                         | 9         |
| 15  | Rooms without humans      | a consequence                                    | 8, 10, 12 |

---

## 1. The record store

**Ships.** A record that outlives the process. Durability flows through
one interface: Pi's `SessionRepo` and `SessionStorage`. Ambion re-exports
them and does not wrap them, so this item is an implementation and not an
API change. There are two deliverables. The first is a **SQLite storage
and repo** on Node's built-in `node:sqlite`. It is the first durable
backend and the one that local development uses. The second is
**reopening across processes**: a fresh process opens `'weekly'` and
finds the record and the per-seat run logs intact.

**The conformance suite already exists.** Pi ships one at
`@earendil-works/pi-agent-core/session/testing`. It holds thirty
runner-independent cases in five groups: entries and lanes, records and
log, queries and facts, validation and immutability, and repository and
forks. This item runs that suite rather than writes one. It then adds the
cases that the suite cannot know about: durability across a process
boundary, and the Durable Object rules below. A throwaway build of this
item held together, and SQLite passed all thirty cases against the
in-memory store as a control. The risk here is schedule, not feasibility.

**Durable Object rules.** The Cloudflare backend arrives with the edge
deployment. Its constraints are cheapest to meet before a second
implementation exists to migrate, so the added cases enforce them from
the first commit:

- **One session, one writer.** Pi's `open()` already acquires a writer
  claim on the backend, and that claim is what a Durable Object is. The
  repo returns one storage per session, and nothing that it writes
  assumes shared access.
- **No query spans sessions.** `findEntries` is per-session and stays
  that way. Anything that is workspace-wide is an index above the store
  (items 7 and 11), and never a capability of the store. Across Durable
  Objects such a query is a fan-out.
- **Append-only, with a monotonic `seq` per session.** The store
  guarantees order within one session only. Both backends can honor that.
- **No transaction spans sessions.**

**Sizing.** The unit of storage is the session, not the room. Per-seat
run logs (`<room>:<agent>`) are sessions too. A workspace with four rooms
and eight seats is therefore twenty sessions, and on the edge it is
twenty Durable Objects. Meet that number deliberately.

**Cost, and where the backend lives.** Pi's storage is a mutation log
with a derived index. That index covers lanes, branch walks, open
operations, and stats. Pi does not export it. An out-of-tree backend
therefore reimplements about three hundred lines of query semantics that
already exist upstream. The SQL and the schema are under a hundred.
That ratio is the first decision of this item. Either contribute the
backend to Pi beside its jsonl store, or carry a transcription of an
internal shape that can drift. The recommendation is to contribute it
upstream.

**Law 4 belongs here.** At-least-once is a property of the storage before
it is a property of the runtime. Pi's `findOpenOperations(lane, { limit:
2 })` already carries the semantics: zero results mean idle, one means
suspended, and two mean corruption. The added cases kill a process in
mid-turn against every backend.

**Note.** Node 22 still flags `node:sqlite` as experimental and warns on
import.

## 2. The workspace

**Ships.** `defineWorkspace({ name, roster })` and `open(name, seats?)`.
The roster is fixed at construction. An opening seats the whole roster or
a subset of it, and never adds a participant. Names become unique across
the workspace rather than across one opening, so a directed `say` means
the same colleague in every room. Explicit participants remain the
general case for a standalone session. The workspace form draws its
participants from the roster.

**Why now.** Every later item attaches to this noun, and at this size the
item is cheap. A product with eight seats and four rooms runs on the
shipped primitives today, and roster enforcement is the only addition.

## 3. Instantiation

**Ships.** _(definition, workspace) → seat_. Each seat starts with
knowledge of its home, and it starts deterministically, so a test can
exercise instantiation the way it already exercises the room. For the
mind of the agent, the runtime injects workspace facts the way it already
injects the roster (rule 7 of the room). For the hands of the agent, the
runtime reifies the seat as the context argument of every tool execution.
`execute(params, signal)` becomes `execute(params, ctx)`, and the signal
rides in the context.

**`ctx` ships open.** It arrives with `agent`, `session`, `workspace`,
and `signal`. `tree` (item 5) and `settings` (item 7) join it later. They
grow an object and never change a signature. That openness is the seam
through which two later items arrive.

**This item also owes a builtin-tool extension point.** `say` is builtin.
`arm_timer` and `pull_task` belong beside it (items 13 and 8). Without a
seam, each one becomes a per-agent tool that an author wires into every
definition by hand.

**Why now.** This item turns `defineAgent` values into residents. The
same definition seated in two workspaces produces two inhabitants with
different homes, keys, and reach. It also closes the sharpest gap in the
shipped surface: a tool that cannot name its own session cannot write a
correct idempotency key, and law 4 makes idempotency the job of the tool
author.

## 4. Provenance

**Ships.** The message shape of the record, amended once, before durable
records exist to migrate. `Message` carries provenance as a union whose
members overlap in nothing writable:

```ts
type Via = { source: string } | { channel: string };

type Provenance = { from: string; via?: Via } | { from?: string; via: Via };
```

There is one field for the aperture, tagged by kind, and at least one of
the two fields is always present. A message that came through two
apertures, or that claims to have arrived through none, is
unrepresentable rather than merely forbidden. `defineHuman` gains
`identities` in the same pass: they are the far-side facts against which
a source resolves an author. `channels` waits for item 10.

**Nothing produces one yet.** The item goes in on evidence. When `from`
is mandatory, an attempt to land an arrival forces every source to be
seated as a courier "human" in every room. That resurrects, at the level
of the type system, the sources-as-seats design that
[`concepts.md`](concepts.md) rejects. A shape that makes the wrong design
the only expressible one should not wait.

**This item does not need typed state entries.** They already exist in
the storage contract. Pi's records carry custom entries with a
`customType` and arbitrary data, and query them by type with cursors and
ordering. Ambion's own messages already live there. The storage half of
law 2 is satisfied today, and later items owe a vocabulary of entry
types, not a change to storage.

## 5. The tree and the boundary

**Ships.** The two remaining facets of the workspace, together, because
the second makes the first safe. The tree is a shared filesystem per
workspace, and a sandboxed shell acts on it through Pi's `ExecutionEnv`.
Every file access, command, and tool call occurs as the workspace and
reaches only what the workspace may reach. Secrets stay with the host.
The runtime derives what a workspace needs from the roster, the host
grants it, and no value lands on a definition or a record.

**Seam.** `ctx.tree`, on the object that `ctx` was built to grow.

**Owes.** An answer for concurrent writers, where two sessions write one
file, before parallel rooms share a tree.

**Why it waits.** This is the largest lift in the design, and a product
with eight seats exercised the concepts without it. All of that work
moved through tools and the record. That is a fact about order, not a
demotion: the tree is still what makes a workspace a place rather than a
label.

## 6. Compaction

**Ships.** Per-seat context management over a long conversation. A seat
that wakes into month twelve of `'weekly'` reads a compacted working view
that the runtime builds at activation. The record is never rewritten.

**Seam.** Law 7. A working view is downstream of the record and never
writes back to it.

**This item is mostly adoption.** Pi already exports the machinery:
`compact`, `shouldCompact`, `prepareCompaction`, `findCutPoint`,
`calculateContextTokens`, and `DEFAULT_COMPACTION_SETTINGS`.
`CompactionEntry` is already an entry type. The part that belongs to
Ambion is the per-seat policy and the wiring into activation, not a
compactor.

**Why here.** Nothing grows a record faster than a person types until
sources exist. Compaction is therefore the gate in front of item 9, and
not an early item.

## 7. Entities and settings

**Ships.** State changes that start as typed entries on records that
already exist. The workspace then holds the current shape of each kind as
a native entity. The entity layer is a store in the reducer mold.
Authored defaults are the initial state, and a rebuild is a replay. One
`reduce` function serves the live dispatch and the replay, so a live
entity equals its rebuild by construction. Settings are the first kind
and the proof of the pattern.

**Seam.** Custom typed entries already exist in the storage contract, as
item 4 explains. This item adds a vocabulary and a reducer.

**Owes.** A rebuild that covers the workspace reads many sessions, and
the store guarantees order within one session only (item 1). This item
therefore owes the cross-record ordering rule, which is a deterministic
tie-break above the store. It also owes reducer purity as an enforced
discipline. The Durable Object constraint and this obligation are the
same fact, seen twice.

## 8. Tasks

**Ships.** Create and close as acts on the record of the creating room. A
task starts in the session that scopes it, and that session is its first
holder. Hold and release are acts on the record of the pulling room. The
task index is a native entity, and any seat enumerates it. A pulled task
is pinned into the context of every seat, and compaction does not touch
it, until the room releases it.

**Seam.** Acts as typed entries plus one entity (item 7), and the
context-injection seam for pinning. That seam is the one piece of new
runtime surface that this item needs.

**Owes.** The goal, the lifecycle, and the holders. The holders are the
sessions that currently hold a task; that set shrinks on release, and the
records keep the history. This item also owes the shape of the change
events of a task, which flow through the tasks source once item 9 exists.

**Why it matters.** Work must be representable while nobody talks about
it. An idle workspace with open tasks waits, and is not done. Tasks are
what an ambient wake is about.

## 9. Sources

**Ships.** A source that admits the world into a session under its
contract. The contract is a route and a policy. The route posts to the
room or directs the message at a seat. The policy is immediate, batched,
debounced, coalesced, or quota-limited. A firing lands as a delivery and
carries the
provenance of item 4. A source is never a participant, and nothing can
address it. Authored sources are defaults. Runtime attachments are acts
on the record of the acting room, and their routes are data from a
declared vocabulary. Of the policy, the quota alone is the granted scope
of law 8. Far ends are host adapters or the framework's own built-ins:
the clock, the task store, and its own notices. Each far end is an
abstraction with a scripted implementation, and time enters through an
injected clock (law 6).

**Seam.** The `via` field of `Message` already types the arrival. A
source is a caller of `deliver` under a contract.

**Owes.** The author list of the invariant gains the aperture. Law 4 also
imposes one requirement on a route that opens a session: the name of a
bootstrapped room derives from the dedup key of the arrival,
deterministically. Otherwise a redelivery founds a duplicate room.

**Why it matters.** Timers, events, and the tasks of the workspace are
all sources or ride one. Each inherits routing, policy, quotas, and
durability from this one design.

## 10. Reaching humans

**Ships.** `defineHuman` gains `channels` beside the `identities` that
item 4 shipped. The channels are sovereign: they travel to every
workspace that seats the person, all of them are allowed, and no
workspace may grant, mute, or remove one. A directed `say` at a person
who is not watching rides one channel out. An authenticated reply
re-enters as a delivery from that person, with both `from` and `via` set,
and follows its provocation home. The ladder of the person selects the
channel, and the runtime consults it against presence. The presence
report belongs to the host. It is per session and graded, it is
ephemeral, and it is never state on the record.

**Seam.** No runtime change. Carriage is host code over the session
stream: watch for a `say` that is directed at an absent person, carry it,
and remember the provocation. It works on the shipped surface today,
which is why this item sits late without blocking anything.

**Owes.** The carriage contract: at-least-once to the far end, failures
that surface as runtime notices which start on the record, and adapters
that own their idempotency. Whether a seat sees presence itself. Where an
unprompted or ambiguous reply routes. Whether a `say` at a person
resolves against the seats of the room or against the roster of the
workspace. A subset room that omits its founder cannot page her today. And the distinction between a surface and a channel, since one
device is often both.

## 11. The consolidated history

**Ships.** Every message across every record, in one order. Arrivals
carry the aperture that stamped them, and acts carry the seat. The
history attributes each message and correlates a reply to its
provocation. Accounting rides alongside, derived the same way rather than
stored as an entity: which aperture, which session, which seat, and what
it cost. The audience is the host and its people. A seat reads its rooms
and the entities of the workspace, and not the whole history.

**Seam.** A merge, not a mechanism. Pi's per-session log is already
ordered and queryable, and `getStats()` already keeps per-session usage
in tokens and cost. Law 7 makes the result a view that never writes back.

**Why it matters.** The history is the audit trail of the boundary and
the meter of the budget. It is the only record of why a given agent woke
when it did.

## 12. Guardrails

**Ships.** The spent scope of law 8. The runtime meters activations and
spend, per session and per workspace, against declared budgets, and it
measures them from the accounting of item 11. A budget that a workspace
crosses pauses ambient wakes, emits a circuit-breaker event, and
escalates through item 10. A delivery from a person always goes through.

**Owes.** The first decision is the reach of the breaker: either source
arrivals only, or every activation that does not descend from a delivery
by a person. The founding case involves no source. A mis-ordered guard
loops `say` after `say` inside one room, and nothing mechanical stops it.
That case reproduces on the shipped core today, which argues for the
wider reach.

## 13. Timers

**Ships.** The first instance of the source. To arm a timer is a tool
call on the record of the arming room, and the timer entity changes in
response. The firing arrives through the timer source as a delivery. It
lands in the session that the timer is tied to, or it bootstraps a new
session, usually around a task. A workspace that slept through three
ticks wakes once if the policy coalesces.

**Why it matters.** A timer is an agent that manages its own attention in
time. That is the difference between an agent that waits to be spoken to
and one that decides when the future speaks.

## 14. Events

**Ships.** The second instance: the changes of the world through event
sources, such as webhooks, queues, and streams from the systems of the
tenant. The runtime ingests them at-least-once, with dedup keys in the
contract, and batching is the headline policy. An adapter to a particular
system lives in host code or a thin package, and never in the core.

**Why it matters.** Cost then scales with events as the policy batches
them, and not with the raw chatter of the world.

## 15. Rooms without humans

**Ships.** A consequence, blessed. Nothing in the core ever required a
person in the room. What ships is last-mile confidence: guardrails on,
egress wired, and the history of the workspace visible. The example
proves it. An initiative room works the weekly before the person arrives,
escalates the blockers, and files everything else.

**Why it matters.** If every session needs a person present, the agents
are not ambient. They are on call.

---

## The measure

Each item becomes a design document. Each document becomes the smallest
mechanism that keeps its promise. Every mechanism answers to the laws,
and to law 3 first. The order exists so that each document lands on
ground that is already settled.
