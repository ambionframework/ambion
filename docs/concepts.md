# The Concepts

Three documents describe Ambion. [`agent.md`](agent.md) is the shipped
core: four primitives and one invariant. This document defines the
concepts that are still to arrive, and the laws that every later design
document must satisfy. [`roadmap.md`](roadmap.md) fixes the order in
which the concepts arrive.

Ambion is eight nouns and one rule. Four nouns are shipped: **agent**,
**human**, **tool**, and **session**. Four are to arrive:
**workspace**, **task**, **source**, and **channel**.

The rule is the invariant of the core. Nothing in this document changes
it:

> **An agent activates in exactly one way: a message is delivered into a
> session that the agent belongs to. Everything that Ambion adds is a new
> way in for deliveries, or a new place for deliveries to matter. It is
> never a second activation mechanism.**

## Why these four

Remove each one and something necessary fails:

- **Workspace** — agents have nowhere to persist, nothing to share, and
  no boundary to act inside.
- **Source** — nothing is ambient. The system acts only when a person
  speaks to it.
- **Channel** — the room cannot reach a person who is absent, and work
  completes unseen.
- **Task** — the workspace cannot represent work that outlives the
  conversation that started it.

The source and the channel are two nouns, not one. The runtime acts on
them differently. A source has a route and a quota. A channel has a
ladder and a presence report. Only the channel carries in two
directions.

Everything else that is planned is a convenience or a safeguard. It is
not a concept.

The examples below are pseudocode. Each concept's design document owns
the real surface.

---

## The workspace

> A workspace is a named place that agents live in. It holds a roster, a
> shared tree, an identity that bounds what the agents may touch, and
> state that starts on the records of its rooms.

**Roster.** The roster is fixed at construction. An opening seats the
whole roster by default, or a subset of it. An opening never adds a
participant. The set of participants that may speak is a property of the
workspace, not a property of an opening.

**Tree.** The tree is the shared filesystem. What one agent writes,
another agent reads, across sessions. The tree is the content half of
law 2. Law 9 makes the tree the memory of an agent.

**Identity.** The identity is the boundary. Every file access, command,
and tool call occurs as the workspace. Each one reaches only what the
workspace may reach.

**State.** State starts on the records and lives as entities. Settings,
source attachments, armed timers, and tasks all enter as typed acts. A
seated author writes an act, or an arrival comes through a source. Both
land on records that the rooms already keep. The workspace then holds
the current shape of each kind as an entity. An entity changes as the
related events land, any seat reads it directly, and the runtime can
rebuild it from the records. The records stay canonical (law 7).

The entity layer is a state store in the reducer mold. Typed messages
are its actions. Each kind has one pure reducer. Authored defaults are
the initial state. A rebuild is a replay of the log. One `reduce`
function serves the live dispatch and the replay, so a live entity
equals its rebuild by construction.

The store computes state. The store never acts. The runtime owns the
consequences: a due timer fires, and a change to a task wakes the
sessions that hold it. Both travel through sources.

The workspace keeps no record of its own. There is nothing to seat,
nothing that the runtime writes, and nothing to bootstrap. An entity
carries the consequences of state-typed messages. It does not carry the
conversation around them.

### Configuration

Configuration is three things. Each has one home:

| Kind         | Home                     | Changed by       |
| ------------ | ------------------------ | ---------------- |
| **Defaults** | the definition           | a redeploy       |
| **Settings** | an entity on the records | acts in rooms    |
| **Secrets**  | the host                 | the host's grant |

Defaults initialize the settings entity. They do not compete with it.
Acts change the entity from that seed, and the latest act wins. A
redeploy that changes a default re-initializes the entity and replays
the acts.

A definition never names a secret. The runtime derives what a workspace
needs from the roster, because every agent names its model. Model keys
are the only secrets that Ambion resolves. The secrets of a tool belong
to the author of that tool, who reads them in host code.

The host grants what a workspace may have. One workspace on a host
inherits the environment, which is Pi's `<PROVIDER>_API_KEY` convention.
Many workspaces each get a scope, so that no workspace resolves the keys
of a neighbour. A secret value never reaches a definition or a record.

**The tenant is not a concept of Ambion's.** The tenant is the host that
runs many workspaces. To mount, grant, and isolate those workspaces is
host work. Any part of that work that wants framework surface must first
satisfy law 3.

```ts
// pseudocode
const studio = defineWorkspace({
  name: 'studio',
  roster: [andrei, researcher, writer, passive(archivist)],
  // no keys: the roster names its models, and the host grants its environment
});

const weekly = studio.open('weekly'); // the full roster
const huddle = studio.open('huddle', { seats: [researcher] }); // a subset

await weekly.deliver({ from: andrei, text: 'What moved since Monday?' });
// instantiation is (definition, workspace) → seat: pure and repeatable
```

## The task

> A task is a durable goal that the runtime can act on. A person states
> it once. It has an owner. The sessions that work it hold it.

A task is not a session. A conversation ends, but the goal must not. A
task is also not a file, because of law 3. The runtime does three things
with a task that no file supports:

1. It routes a wake to the sessions that hold the task.
2. It injects a pulled task into the context of every seat, by contract.
3. It knows that an idle workspace with open tasks waits, and is not
   done.

A **holder** is a session that currently holds the task. Holders are
current state, not history. A hold adds a holder and a release removes
one. The records keep the history of who held the task and when.

```ts
// pseudocode — a task starts in the room that scopes it
// that room is its first holder
const digest = await weekly.tasks.create({
  goal: 'Ship the Q3 digest by Friday',
  owner: writer, // an act on the record of weekly, stamped like any other
});

await weekly.pull(digest); // weekly holds it. The goal is now pinned into
await weekly.remove(digest); // every seat's context until weekly releases it.

await studio.tasks.open(); // the task entity: any seat enumerates it
// changes to a task arrive through the tasks source
```

## The source

> A source is a named aperture. It speaks into the room, and nothing can
> speak back to it. It has a contract: a route and a policy. Sources
> belong to the workspace, and the workspace declares them with its
> roster.

An **aperture** is a named opening in the wall of a room. A source and a
channel are the two kinds. Ambion owns the aperture. The host or the
framework owns what stands behind it.

A source has no judgment. It has a contract. Nothing wakes a source, and
nothing addresses one: a `say` goes to seats only.

The far end of a source is never the room's. The systems of the world
connect as host adapters, such as a repository, a queue, or a webhook.
The framework supplies far ends of its own: the clock, the task store,
and its own notices. All of them use the same kind of aperture and the
same contract.

The contract has two parts:

- **A route.** It names a session, or the rule that opens one. It posts
  to the room, or directs the message at a seat.
- **A policy.** The policy is immediate, batched, debounced, coalesced,
  or quota-limited.

A firing lands as a delivery, and the runtime stamps it with the name of
the source. The invariant does not change: this is a new way in, not a
new pen.

### Provenance

**`from` names the author. `via` names the aperture that the message
came through.** The runtime stamps both. A participant never claims
either one.

```ts
type Via = { source: string } | { channel: string };

type Provenance =
  | { from: string; via?: Via } // a seat spoke, or a person answered on a channel
  | { from?: string; via: Via }; // an arrival, with or without a resolved author
```

The shape carries the rule. A message cannot come through two apertures,
and it cannot claim to have arrived through none. The rule is that a
message has an author, a `via`, or both, and never neither. The type
makes the other cases unwritable, so no runtime check is necessary.

A `say` from inside the room carries an author and no `via`. An arrival
always carries a `via`. It also carries an author when the far side
resolves to a seated participant. Ambion assumes strong authentication
at the far side and uses it.

An author never enters `from` from message content. The host vouches for
the author. A source resolves far-side authors against the identities
that the roster declares. That a Slack id belongs to jonah is a fact
about jonah. He states it once on his handle, and never per source.

The rule needs no exception for the runtime, because the runtime writes
no records. It stamps what seats and far ends produce, and it derives
the rest.

```ts
// pseudocode — the workspace declares its sources with its roster
const studio = defineWorkspace({
  name: 'studio',
  roster: [andrei, researcher, writer, passive(archivist)],
  sources: [
    source(github('ambionframework/ambion'), { session: 'weekly', batch: '15m' }),
    source(tasks, { route: { sessionsHolding: 'task' } }), // a route is data, never a function
  ],
});

arm_timer({ in: '2d', note: 'Recheck the claim in the digest.' });
// two days later, the firing arrives through the timer source:
//   deliver({ via: { source: 'timer' }, to: 'researcher', text: 'Recheck the claim…' })
```

## The channel

> A channel is the two-way aperture of one person. It carries the words
> of the room out, and it carries the answer of that person back in. The
> person declares their channels on their handle. The channels are
> sovereign: they travel to every workspace that seats the person, and no
> workspace may grant, mute, or remove one.

The far side separates a channel from a source. A source is a system. It
emits, and nothing can address it. A channel is a person. The room can
reach that person, and that person answers. Each aperture belongs to the
party whose side it is on.

A directed `say` at a person who is not watching rides one channel out.
The far end is the host's: a push notification, a pager, or email. An
authenticated answer re-enters as a delivery from that person, with both
`from` and `via` set. An owner who steers from a distance is still an
owner who steers, and no breaker stands between them.

The `say` goes to the seat in both cases. An agent never speaks into a
channel, and an escalation stays an act on the record.

**Selection.** The **ladder** is the ordered list of channels of one
person. The runtime consults the ladder against **presence**.

A **surface** reports presence. A surface renders the record to a
person, authenticates that person, and delivers what they type. A web
client, a mobile application, and a terminal are surfaces. A surface is
not an aperture and stamps no `via`: a person at a surface is simply in
the room. One device is often both a surface and a channel.

The presence report is per session and graded. It states which room the
person watches now, and when the person was last active. Presence is
ephemeral and is never state on the record. If the person watches the
room, they read the record and nothing rides out. If the person was
active a moment ago, the gentlest channel carries. If the person has
been absent for a long time, the ladder climbs.

**Correlation.** A reply follows its provocation. A **provocation** is
the `say` that the runtime carried out. The runtime remembers the
session that the `say` left from and the channel that it rode, so the
answer routes home. An unprompted message on a channel is the design
document's to route.

The same correlation lets the workspace present the consolidated
history: seats, sources and channels, provocations and replies, and
every room in one order. The audience is the host and its people. A seat
reads its rooms and the entities of the workspace. A seat does not read
the consolidated history.

**Carriage.** Carriage is the delivery of a `say` to a far end. Carriage
is at-least-once. The runtime hands the message to the adapter the way
that law 4 hands deliveries to the record. Adapters own their
idempotency, as tool authors do.

A channel that fails produces a runtime notice. The record is the floor
under all of it. A notice starts on the record, arrives through the
runtime's own source, and only then rides a channel. A ladder that runs
out of rungs loses the carry. It does not lose the fact.

**Visibility.** Visibility is at seat level. The roster that an agent
reads shows each person with their channels. The session shows its own
sources.

**Configuration.** Sources follow the configuration trichotomy in full.
A definition that declares a source declares a default. An agent that
arms a timer at runtime writes an act on the record of the acting room.
State then holds data only. A route on a record is a rule from a
declared vocabulary. The vocabulary holds the name of a session, the
sessions that hold a task, and the target that the arming act names. A
route is never a function.

A channel takes the first limb only, and that is what sovereignty means
in mechanism. A person declares a channel on their handle. There is no
runtime path that attaches, mutes, or retargets one.

```ts
// pseudocode — channels and identities belong to the person, on the handle
const andrei = defineHuman({
  name: 'andrei',
  identity: 'Founder. Owns the weekly. Bring him blockers, not status.',
  identities: { slack: 'U-ANDREI' }, // far-side facts, for sources that resolve authors
  channels: [push(mobile), pager(oncall)], // the ladder, in order
});

say({ to: 'andrei', text: 'Blocker: the Q3 numbers do not reconcile.' });
// watching: he reads it. Active recently: push. Absent: the pager.

// when he answers from the pager, the channel resolves him — author and via:
//   deliver({ from: 'andrei', via: { channel: 'pager' }, text: 'Hold until Monday.' })
```

---

## How they connect

The loop runs once around:

1. **A source admits a firing.** Its policy batches the firing and its
   route directs it. The firing lands on a record.
2. **The room wakes.** The delivery lands, and the idle seats evaluate.
   The tasks that the room holds state what the wake is for.
3. **Work advances.** Agents speak or stay silent, call tools, run
   commands in the tree, and move tasks. The runtime stamps every act
   onto a record.
4. **Results settle.** Products land in the tree and decisions land on
   the records. The entities change in response.
5. **The runtime reaches a person.** A directed `say` at an absent
   person rides one of their channels. Presence and recency choose it.
6. **A person steers.** They deliver back into the session, at a surface
   or on a channel. This is the one activation mechanism, as always.
7. **An agent arms the future.** A timer that an agent arms today fires
   through the timer source tomorrow, and the loop closes.

The relations are these:

- **The workspace contains** the roster, the tree, the sessions, the
  tasks, the sources, and the state that starts on the records of its
  rooms. It is the unit of residence, of identity, and of durability.
- **A session opens in a workspace.** The workspace is the place. A
  session is a moment in it.
- **The workspace instantiates an agent** — _(definition, workspace) →
  seat_. The same definition seated twice produces two residents.
- **A task belongs to the workspace, and sessions hold it.** To hold is
  current state. The records keep the history.
- **A source opens the room to the world.** It carries in one direction,
  under a route and a policy, and nothing can address it.
- **A channel reaches a person, who answers.** The person declares it on
  their handle, beyond the reach of any workspace. The `say` goes to the
  seat. Presence and recency choose the channel.

### The lifecycle contract

A definition cannot hold a reference to a workspace. Authors write
definitions before any workspace exists, and definitions outlive every
workspace. The same definition seated twice must produce two residents,
not one confused resident. The contract therefore has three moments:

- **A definition holds nothing situated.** An author may close over host
  code. An author may never close over a workspace, a session, or a
  seat.
- **Instantiation binds** — _(definition, workspace) → seat_. The seat
  holds the situated references.
- **Execution resolves.** Every tool execution receives the context as
  its second argument.

The resolution must be late for a reason beyond convenience. The runtime
stamps acts that a tool makes through the context with the provenance of
the seat. Only the runtime knows, at execution time, which seat acts. A
reference that binds early acts as nobody, or as the wrong seat.

```ts
// pseudocode — at definition time no workspace exists, and none is named
const digest = defineTool({
  name: 'digest_file',
  description: 'Summarize a file from the workspace tree.',
  parameters: Type.Object({ path: Type.String() }),
  execute: async ({ path }, ctx) => {
    // ctx is the seat: agent, session, workspace, tree, settings, signal
    const text = await ctx.tree.read(path);
    return summarize(text); // host closures stay welcome, because that is host code
  },
});
```

The context carries the resources of the seat. It does not carry the acts
of the agent. To speak, to arm a timer, and to pull a task are builtin
tools. The agent takes those decisions on the record, and a custom tool
cannot take them for the agent.

The shipped surface is `execute(params, signal)`. The context absorbs
the signal when the workspace arrives.

---

## The laws

There are nine laws. Every design document starts from them.

1. **One activation mechanism.** Sources and channels are ways in for
   deliveries. They are never a second way to wake an agent. No document
   may add one.
2. **State starts as messages. Content is files.** Every state change
   enters as a typed message on a record that already exists. A setting,
   a source attachment, an armed timer, and a task all work this way.
   That entry is the provenance of the change and its audit. The
   workspace holds the current shape of each kind as an entity, and the
   runtime can rebuild that entity from the records. When an entity and
   the records disagree, the records win. Entities are pure reducers
   over typed messages: they compute state and never act. Accounting
   derives the same way, from the seat run logs that the core already
   keeps. The runtime writes no records. It stamps what seats and far
   ends produce, and it maintains what those messages imply. Entities
   serve the state kinds of the runtime, which law 3 keeps to a closed
   set. Entities never serve application state, which belongs to tools
   and to the tree. Nothing canonical exists outside the records and the
   tree. Secrets are neither.
3. **The razor.** A thing earns a primitive only when the runtime must
   act on it. A thing that only agents act on is a file. This law admits
   the task and keeps memory in the tree.
4. **At-least-once.** A delivery that the record accepts happens, across
   crashes. If an activation dies in mid-turn, the runtime redelivers,
   and the seat evaluates the record again. Authors of tools that have
   side effects own idempotency.
5. **Names bind late.** Durable state references names. Every wake
   resolves those names against the deployed code. A reference that
   dangles is an error event and an escalation. It is never a crash and
   never a silent drop. A rename is a migration. The same lateness
   governs code: a definition holds no situated reference, instantiation
   binds it, and execution resolves it.
6. **Time is injected.** Clocks and the far ends of sources and channels
   are abstractions with scripted implementations. Tests stay
   deterministic as the framework grows.
7. **The record is never rewritten.** Everything downstream of the record
   is rebuildable from it and never writes back to it. The compacted
   working view of a seat, the current shape of an entity, and the
   consolidated history all work this way. Compaction and entity
   maintenance are different machineries under this one law. When
   anything downstream disagrees with the record, the record wins.
8. **Attention has one budget at two scopes.** This is one concept, not
   two mechanisms: a budget on wakes and spend. The runtime applies it at
   two scopes. Attention is granted at the quota of a source. Attention
   is spent at the meter of the workspace. The rest of a source's policy
   shapes the contract and not the budget: batching, debouncing, and
   coalescing are policy. A breaker that trips stops
   ambient wakes and emits an event. It never stops a delivery from a
   person, by hand or on their channels.
9. **Files are memory, for now.** What an agent keeps in the tree is its
   continuity. A memory primitive must first out-argue the filesystem
   under law 3.

---

## The measure

Eight nouns, one rule, nine laws. A later document may implement a
concept, realize one facet of a concept, add an instance of one, or
preserve a law under new load. It may not add a ninth noun until it
retires one of the arguments above. The first argument that it meets is
law 3.
