# The Agent

This document is the design contract for Ambion's core, and the core is
shipped. The whole runtime lives in
[`packages/ambion/src`](../packages/ambion/src) — definitions in
[`define.ts`](../packages/ambion/src/define.ts), the room in
[`room.ts`](../packages/ambion/src/room.ts), the public shapes in
[`types.ts`](../packages/ambion/src/types.ts).

Four functions build a room, and one sentence holds the whole of it:

> **`defineAgent` makes an agent, `defineHuman` names a person, `defineTool`
> gives agents tools, and `startRoom` brings up a named room the agents
> work in and people visit — each agent deciding for itself whether to speak,
> to whom, and which colleague to call in.**

The `assistant` option designates one agent for reserve selection and
summaries. Section 5 explains its relationship to attention.

Four documents build on this core and are also shipped:
[`exchange.md`](exchange.md) specifies the exchange, the room's own unit of
work; [`presence.md`](presence.md) puts people in a running room;
[`assistant.md`](assistant.md) adds the assistant every room seats; and
[`workspace.md`](workspace.md) gives an agent's tools a boundary to reach
into. A fifth, [`roster.md`](roster.md), lets the roster change while the
room runs: it changes two rules below and says which.

---

## 1. One dependency owns the loop

An agent needs a model, a tool-calling loop, streaming, cancellation,
retries, context compaction, and a durable transcript. All of it is solved
work, and the [Pi SDK](https://pi.dev/docs/latest/sdk) solves it well
(`@earendil-works/pi-agent-core`, the headless loop). Ambion writes none of
it.

| Concern                                   | Owner      |
| ----------------------------------------- | ---------- |
| Model catalog, providers, streaming       | Pi         |
| Tool-call loop, abort, retries            | Pi         |
| Steering a running turn                   | Pi         |
| Transcript storage, in-memory and durable | Pi         |
| Tool definition format                    | Pi         |
| **Participants as values**                | **Ambion** |
| **The room**                              | **Ambion** |

Ambion owns two concerns. A third concern is a design failure: push it into
a dependency or drop it. The single extension point is Pi's own:
`startRoom` accepts a `streamFn`. A scripted stream makes the room
deterministic — this is how [the tests](../packages/ambion/test/support/scripted.ts)
run — and a custom stream brings custom providers. Ambion keeps no model
registry of its own. Without a `streamFn`, models resolve as
`provider/model-id` from Pi's builtin catalog, and API keys come from
`<PROVIDER>_API_KEY` in the environment. The provider definitions and catalog
module load only when the first default model is resolved or streamed; a
scripted or custom `streamFn` does not load that catalog.

---

## 2. defineAgent

```ts
import { defineAgent } from '@ambionframework/ambion';

export const researcher = defineAgent({
  name: 'researcher',
  identity: 'Fact-checker. Keeps the digests; flags what does not hold.',
  instructions: `
    You verify claims against the digests you keep. Speak when a claim
    is wrong or unverified; otherwise stay quiet.
  `,
  model: 'anthropic/claude-sonnet-4-5',
  tools: [lookup], // optional
});
```

That is the entire surface. `name` identifies the agent inside a room and
on the record. `identity` is the public face: one or two sentences the whole
room reads, injected into every participant's context as part of the roster.
`instructions` are private. They are the agent's own voice, appended to the
runtime's system prompt, and they hold all of the agent's judgment —
including the judgment to say nothing. The runtime's prompt is always
present; instructions extend it. The optional `tools` field accepts ordinary
tools and tool bundles. [`workspace.md`](workspace.md) describes the bundle
that a workspace resource provides.

`defineAgent` returns a plain value. Everything that refers to an agent
refers to this value. Nothing refers to an agent through a bare string.

---

## 3. defineTool

```ts
import { defineTool } from '@ambionframework/ambion';
import { Type } from 'typebox';

const lookup = defineTool({
  name: 'lookup_order',
  description: 'Fetch an order by id.',
  parameters: Type.Object({ id: Type.String() }),
  execute: async ({ id }) => `Order ${id}: ${await orders.status(id)}`,
});
```

`defineTool` is a facade over Pi's own tool shape: the same
name-description-parameters-execute, with one convenience. `execute`
receives the parsed parameters as its first argument and a `ToolContext`
as its second. The context identifies the agent, carries `callId`, exposes
`onUpdate`, and carries Pi's abort signal as `ctx.signal`. It may return a plain
string or Pi's full content shape. A tool defined with Pi's own
`defineTool` works unchanged (`toPiTool` in `seat/tools.ts` accepts both), so
learning Pi's format is the same as learning Ambion's. A workspace resource
adds its tools through an ordinary bundle ([`workspace.md`](workspace.md)).

---

## 4. defineHuman

```ts
import { defineAgent, defineHuman } from '@ambionframework/ambion';

export const andrei = defineHuman({
  name: 'andrei',
  identity: 'Founder. Owns the weekly. Bring him blockers only.',
  preferences: 'Lead with blockers. Four sentences at most.',
});
```

A human is a participant: on the roster like an agent, on the record like an
agent. `identity` is how the room knows them. A human has no instructions,
no tools, and no model, because humans are never run — a `say` directed at
one wakes nothing.

One optional field goes with them: `preferences`, how they read. The room's
assistant reads it when it writes the one message they read at the close of
their exchange, and no other seat reads it. The assistant is seated by
`startRoom`, at the narrow end of attention: nothing said reaches it, no
message activates it, and nothing it writes wakes anybody.
[`assistant.md`](assistant.md) is the contract for it.

A human is outside a room's composition, so `startRoom` never takes one.
The value is what somebody visits as: `room.visit(andrei)`
returns a visit, the visit sends, and the runtime stamps the record from
it. Who-said-what comes from the runtime's own observation, never from a
claim inside the content. One person holds one visit, several people visit
at once, and each one's presence is a fact the agents read.
[`presence.md`](presence.md) is the contract for that, and for the arrival
a visit puts on the record.

---

## 5. startRoom

```ts
import { readRoom, startRoom, passive } from '@ambionframework/ambion';

const room = await startRoom({
  name: 'weekly',
  goal: 'Draft the weekly digest and flag what does not hold.',
  assistant: editor,
  agents: [researcher, writer, passive(archivist)],
});

const unsubscribe = room.subscribe((event) => {
  if (event.type === 'message') console.log(`${event.message.from}: ...`);
});

const visit = await room.visit(andrei);
const exchange = await visit.send({ text: 'Draft the weekly. Anything to flag?' });
const response = await exchange.response();
if (response) console.log(response.text);

await room.stop();

// later, in any process, with no agents standing up
const snapshot = await readRoom('weekly');
for (const message of snapshot.messages) {
  console.log(`${message.from}: ${message.text}`);
}
```

Three verbs, and each does one thing:

- **`startRoom` sets up the context where the agents work.** It takes
  the room's composition and brings it to life: from here on the seats are
  live and a message activates them.
- **`room.stop()` takes it down**: every activation in flight is aborted, every
  visit is closed, the write chain drains, and the handle refuses further
  use.
- **`readRoom` reads a name and starts nothing**: the record, and who
  was in it, with no seat standing up and nothing to bill. You can read a
  room that is idle; you can only speak into a running one.

A person visits through `room.visit(person)`, as described in
[`presence.md`](presence.md).

A room is a named entity that outlives any run of it. Three rules of
identity follow.

**The record belongs to the name.** What was said in `'weekly'` is there
whenever `'weekly'` is read, for as long as the storage lives, whether or
not anything is running.

**The run belongs to `startRoom`.** The assistant, the agents passed,
and the agents held in reserve are the room's composition for this run. A
name can be started again with a different composition, and the record
still shows who said what, stamped at the time it landed. A long-lived
room is many runs over one record, and `readRoom` reaches the record
between them. `agents` may be empty: a room that starts with the assistant
alone seats what a question needs from its reserve
([`roster.md`](roster.md) §1).

**One run per name.** `startRoom` refuses a name already running in this
process, and the journal fences a run in another process
([`durability.md`](durability.md) §1). Two live rooms over one record
would each replay it, each append to it, and diverge. A start the record
refuses frees the name: the handle answers every call with the refusal,
and the next start takes the name. Names are unique inside a roster too:
`startRoom` refuses a duplicate, and so does `room.visit`, so
`say({ to })` always names exactly one participant.

`startRoom` and `resumeRoom` return ready rooms. `readRoom` returns a ready
snapshot. No public room method waits for general inactivity.

The record holds one union (`Message` in `types.ts`): what a participant
said, what a person did, and what one exchange came to.

```ts
type Message =
  | {
      kind: 'said';
      seq: number; // monotonic, assigned at commit, strictly ordered
      key?: string; // the key the commit carried; a repeated key lands once
      activationId?: string; // the activation that wrote it; absent on a delivery
      wakes?: string[]; // the seats at rest the message wakes, written with it
      at: string; // stamped by the runtime, at the moment it landed
      from: string; // a participant's name — stamped by the runtime, never claimed
      to?: string; // present when the delivery or say was directed
      text: string;
    }
  | {
      kind: 'arrived' | 'left' | 'seated' | 'unseated';
      seq: number;
      key?: string;
      activationId?: string; // on a 'seated' the assistant wrote
      wakes?: string[];
      at: string;
      from: string; // the participant whose presence changed — stamped by the runtime
      identity?: string; // on 'arrived' and 'seated': how the room knew them
      by?: string; // on 'seated': the assistant, when it did the seating
      attention?: Attention; // on 'seated': what wakes the seat; absent means 'broadcast'
      preferences?: string; // on 'arrived': how the person reads, when they said so
    }
  | {
      kind: 'summary';
      seq: number;
      key?: string;
      activationId?: string;
      wakes?: string[];
      at: string;
      from: string; // the assistant, which wrote it
      to: string; // the person whose question opened the exchange
      text: string;
      covers: { from: number; through: number }; // the range it stands for
    };
```

Every kind carries `key`: the name of the commit that landed it. A seat's
say and the assistant's two tools take Pi's tool call id as the key; a
host's delivery takes the key it passes, or a fresh one. The record refuses
a second commit under a key it holds, and hands back the first.

The second kind carries no `text`, because the participant said nothing.
[`presence.md`](presence.md) specifies it for a person, and
[`roster.md`](roster.md) for an agent seated or unseated while the room
runs. The third is written by the assistant when an exchange closes, and
nobody spoke it; [`assistant.md`](assistant.md) specifies it. Every rule
below applies to all three kinds unchanged, which is why the record holds
one union and one sequence.

Beyond identity, the mechanics are eight rules. The first six are the
room's routing and voice; all of the routing is one file,
`room/routing.ts`, and it is written on the message: `wakes` names every
seat at rest the message wakes, so a message and its routing are one write. A seat
at work is steered once the write is confirmed (rule 2).

**1. Every message activates every idle agent, in parallel.** A human's
delivery, a person arriving, and a colleague's undirected `say` route
identically. Seats sit out when their attention is too narrow for the
message (rule 6); everyone else at rest evaluates at once, and replies land
on the record in arrival order. A reply that lands after colleagues went
idle wakes them again, so it is heard now and never waits for the next
delivery. With one agent this degenerates to ordinary chat: the room is the
general case, and the single assistant is its size-one instance.

A message may also be directed: `visit.send({ to, text })` and `say({ to })`
activate exactly the named participant, waking it however narrowly it is
seated. `to` is a participant handle; directed at a human it addresses the
reader and wakes nothing.

The routing excludes a message's author, and `from` is the author of every
kind. A presence message names its subject in `subject`: the person who
arrived, or the seat the room seated. On an arrival the two are one name,
because a person's presence is theirs to change. A seating the assistant
decided names the assistant in `from`; a seating the host decided has no
author, because the host is not a participant. The routing excludes the
author and wakes the subject ([`roster.md`](roster.md) §3).

**2. Whatever arrives mid-activation is steered in, and working views reset at
idle.** Replies and deliveries alike, directed or undirected: each arrival
is injected into every active agent's running activation at the next safe point,
so nobody finishes blind and answers stale. "Round" is deliberately a
soft-edged word: the room has no barrier between concurrent activations. Mid-flight, each agent may see the conversation in a
slightly different order than the record. Its working view is its own,
temporary by design: when the agent goes idle the view is discarded, and
the next activation reads the record itself. The record is canonical.

A steer is the room's word to a running activation, and the journal does not
record it. The journal says who was at work when the message landed: a lease
that holds a change before the message and ends, if it ends, after it. A
message such a lease heard is answered when the lease stands down, and
pending again when the lease expired or failed, so a run that dies while
the seat works loses nothing: the seat is woken for the message after the
backoff. A wake to a seat at rest is on the message, so a wake lost on
the way is sent again after the resend window, and the seat side runs a
wake sent twice once. A wake that lands while an activation is releasing
its lease is no steer: that activation reads nothing more, so the wake
runs as an activation of its own, after the release. The seat runs one
activation at a time and every wake that queued behind it in turn. A
claim or a release the seat never heard back on is sent again, up to
`runtime.call.attempts`: a claim of an id the room already runs is a
renewal, and a release of a lease that ended is answered stale. One
policy covers both, because the seat asks the same question of each
call — did it come back? When a pass ends,
the activation renews its lease, and the renewal says how far the record
reaches. An activation that heard less than that reads the room again
through a fresh view.

**3. Speaking is a tool; silence is the default.** An activated agent holds
one built-in tool, `say({ to?, text })` (`sayTool` in `seat/tools.ts`). Ending
an activation without calling it is declining. Declining leaves no mark on the
record — the way a colleague reads the room and keeps working. The tool
refuses an empty text for the same reason: a message with nothing in it
still takes a seq, renders in every context after it, and wakes whoever
hears it.

The runtime's prompt (`renderSystemPrompt` in `render.ts`) sets the
bar for every seat: a reply must add something the record does not already
hold — new information, a decision moved forward, or a genuinely different
perspective — and a point already made, even in other words, is met with
silence. Whether a reply clears the bar is judgment, and the judgment lives
in `instructions`; the runtime states the bar and leaves the decision to
the agent. Glances are still billed: a room of three costs three looks per
message, replies included — the honest price of a room, stated plainly.

The bar is also what keeps the room from echoing itself. Every reply wakes the
idle room (rule 1), so judgment is what prevents ping-pong: a woken seat
with nothing to add declines, and the lock (rule 5) refuses the duplicate
that slips through.

**4. A directed `say` focuses the room's attention.** An undirected `say`
speaks to everyone, like any message. `say({ to: 'writer' })` narrows it:
the named colleague is woken, however narrowly it is seated — the only way
a seat at `named` hears anything — and the rest of the idle room stays at
rest. Every escalation is explicit, on the record, and paid for on purpose.
Directed at a human, it addresses the reader and wakes nothing. The
runtime's prompt pairs this with a rule against rehearsal: a question only
one participant can answer is asked with one directed `say`, never posed to
the room first. A `say` is a message the whole room pays for.

**5. No one speaks over the room.** Ordinary speech commits only against a record
its author has read in full. For a seat that is its `say`, checked against
the view it was handed plus every steer that has landed in its transcript
since (`readThrough` in `seat/activation.ts`). If the record moved past that, the say
fails without landing, and the failure carries the messages the seat
missed: the same steering contract, enforced at the tool boundary, where
delivery is guaranteed. The seat then decides again — speak because
something is still worth adding, or go quiet because the point stands;
rule 3's bar, now with the hearing enforced.

First to commit wins, and ties are impossible: a commit is one operation
on the room's commit queue, the check and the write run inside that one
operation, and nothing observes a message before its write is confirmed
(`RoomJournal.commit`, over `@ambionframework/journal`). A room with no races pays nothing. The refusal shows on the stream as `conflict`, which
names the author. Every ordinary say includes the preceding messages in its
author's view. A summary publishes a closed exchange's result with its fixed
range and recipient. Later messages do not invalidate that input
([`assistant.md`](assistant.md) §5).

The room requires `readThrough` for ordinary speech, including custom
executor calls. It refuses missing, non-integer, negative, or future
positions. A valid older position returns the messages the executor missed.
The executor remains responsible for reporting what it actually consumed.

**6. A seat has a status and an attention, and they are different things.**
Status is runtime: `active` (taking an activation now) or `idle` (at rest).
Attention is a seating choice, and it is what rule 1 defers to when it says
who sits out — one widening scale, from the narrowest:

- `none` — nothing said in the room reaches it, and it cannot be addressed:
  the runtime refuses a directed say to it, so no message waits unread. The seat that is
  present and unreachable, waiting for something other than a message. The
  assistant sits here ([`assistant.md`](assistant.md)), woken by the open
  and the close of an exchange and by nothing else.
- `named` — hears a message addressed to it, seated as `passive(archivist)`.
  The expert in the corner: hearing nothing, costing nothing, until someone
  asks.
- `broadcast` — also hears anything a participant said. The default, and
  what a bare agent in `agents` gets.
- `presence` — also wakes when somebody arrives or leaves, seated as
  `attentive(concierge)`.

**The scale is the mechanism; the words are shorthand for points on it.**
`seated(agent, { attention })` is the general form, and `passive` and
`attentive` are one line each over it — the two points a room names often
enough to be worth a word. A bare agent takes the default. `none` is where
the assistant sits: it wakes for exchange events and for nothing said.

The routing is the scale, and reads as one line (`wakes` in `room/routing.ts`):
every message has a **reach** — `named` for a directed say, `broadcast` for
anything else said, `presence` for somebody arriving or leaving, or a
colleague seated or unseated — and a seat wakes when its attention is at
least that wide. A message that names a seat additionally wakes that seat,
however narrowly it is seated: a directed say names the one it addresses
and wakes nobody else, which is what makes it a focusing act, and a seating
names the seat it seats ([`roster.md`](roster.md) §3).

Both are readable from `room.seats()`, so a seat that is `named` and
running is describable, which one enum could not do. Attention belongs to
the seating, and `defineAgent` knows nothing about it, so the same agent
can be the quiet corner in one room and the one who meets people in
another.

**The room designates one assistant.** `startRoom({ assistant })` seats
that agent at attention `none` and records its name in the composition.
The assistant policy selects reserve agents when an exchange opens and
consolidates multiple agent messages when it closes.

```ts
await startRoom({
  name: 'weekly',
  agents: [researcher, writer],
  assistant: editor,
});
```

An opening activation holds only `seat`; a closing activation holds only
`summarise`. The assistant remains an ordinary agent with its own definition,
model session, and activation history. A room without an assistant closes
exchanges without selecting reserve agents or producing summaries.

**7. Identity is injected; provenance is stamped.** Every agent's context
carries the room's goal, the time, and two rosters — the agents, with
their statuses spelled out so a seat knows a broadcast will never reach the
colleague seated `passive` in the corner, and the people, with how long
each one has been reading or gone. On the record, `from` is written by the
runtime: `say` is stamped with its agent, a message from a visit is stamped from the
live visit that made it, and an arrival is stamped from the visit the
runtime observed opening. No one self-reports who they are.

**8. The room hears what you said — and your keystrokes are kept aside.**
Each agent's tool calls belong to its own working context; other
participants see its `say`s only, because the record is all any view
renders. The tools are still auditable: every activation's full turns land
in the seat's own downstream Pi session, named by `seats().sessionId` and
opened through the runtime's transcript opener
(`persistTurns` in `seat/activation.ts`) — so what an agent actually did can be replayed long after
its working view reset. The record is never rewritten for anyone.

### Observing the room

The observation surface is Pi's `Agent` API lifted one level: the same
`subscribe(listener)` returning an unsubscribe function, an event per fact,
and one property a room needs that a single agent does not — every event
names its seat. The stream carries room-level facts only (`RoomNotification` in
`types.ts`):

```ts
type RoomNotification =
  | { type: 'message'; message: Message }
  | { type: 'activation_start'; agent: string }
  | { type: 'conflict'; author: string; missed: Message[] }
  | { type: 'tool_execution_start'; agent: string; toolName: string }
  | { type: 'tool_execution_end'; agent: string; toolName: string }
  | { type: 'activation_end'; agent: string; spoke: boolean }
  | { type: 'error'; agent: string; error: Error }
  | { type: 'abandoned'; agent: string; activation: string }
  | { type: 'exchange_opened'; exchange: Exchange }
  | { type: 'exchange_closed'; exchange: ClosedExchange }
  | { type: 'quiet' }
  | { type: 'superseded' };
```

**One message on the record, one `message` event.** What a person
delivered, what an agent said, a person arriving or leaving, and the
summary an assistant wrote all reach the host the same way, because they are the
same thing: an entry the room committed. Who wrote it is `message.from`,
which the roster already names, so the stream does not split by author. The
event is atomic as the record is: one event, the whole message, exactly as
it landed.

`activation_start` and `activation_end` belong to the room. Pi emits an
`agent_start` per _run_ — one `prompt()` — and an activation covers one or
more runs, because a message landing mid-activation rebuilds it against the
record as it now stands. Pi's `tool_execution_*` do pass through,
with the seat named. Pi's `message_*`
granularity — streaming deltas, partial turns — is deliberately left out of
the stream: finer visibility is the seat's own layer, reached through Pi's
hooks on the seat's downstream session. The room forwards only messages it
committed.

**Three spans, and two of them are ours.** Pi has a _turn_: one request to a
provider and the tools it calls. Pi has a _run_: one `prompt()`, and the turns
inside it. Ambion has an **activation** — the room waking a seat, which is one
or more runs — and an **exchange**, a person's question and every activation
until the room goes quiet. [`exchange.md`](exchange.md) is the contract for
the exchange. The two words this document uses are `activation` and
`exchange`; `turn` in these pages is Pi's, or plain English in a sentence a
model reads.

Three events are the room's own:

- `message`;
- `conflict` — rule 5's lock refusing a message that raced past the
  record, so the host sees every race the lock caught;
- `error`, which distinguishes a failed activation from a quiet one.

**Silence is a decision; an error is an event.** A crashed tool or a refused model call
never masquerades as declining: it reaches the host on the stream, and
leaves no mark on the record.

One distinction keeps rule 8 honest: the event stream serves the host, and
the host holds no seat at the table. Participants' contexts never see each
other's tool executions. The stream sees them, because the host operating
the room is the code that owns it, and debugging a room means watching
tool calls as well as hearing voices.

### The exchange: the room's own unit of work

A room is a sequence of exchanges. A person's question opens one, and
quiescence closes it. Messages that land while it is open steer the seats
already working. [`exchange.md`](exchange.md) specifies the exchange shape,
its rules, and its completion handle.

An exchange handle gives callers durable completion without a room-wide wait:

- **`visit.send()`** waits for the delivery to commit, then returns the exchange
  handle. A repeated key returns the same handle.
- **`exchange.messages()`** waits for the durable close and returns the fixed
  conversation in its inclusive range, excluding summary messages.
- **`exchange.response()`** waits for the assistant response, or returns
  `undefined` when the assistant deliberately stays silent. Failed work rejects.

**`abort()`** revokes every lease in flight and every wake still pending. The
room writes `ended` with reason `revoked` and cuts the seat side with Pi's abort.
The room keeps running afterwards.

**`room.stop()`** ends the run. It revokes work, closes visits, cancels the
alarm, and spends the room handle. A later run writes its own composition and
closes an exchange that remained open.

**`resumeRoom(name, { runtime, agents })`** brings a name back over its journal.
It resolves every recorded seat through the supplied bindings. The room
reconciles at once, so pending work and open exchanges continue after restart.
A dropped room writes nothing, and its handle accepts no new work.

**A room captures its definitions.** `defineAgent` copies and freezes its
tool array, tool records, and plain schema records. Functions, workspace
handles, and other nonplain resources keep their identity. A started room
binds each agent name once for that run. Another room can use the same name
with another definition. A resume receives its bindings explicitly. It
refuses a missing or repeated binding before it writes its fence.

`messages()` and `seats()` are the pull side; the stream is the push side.
A listener learns nothing the pulls cannot tell it — it only learns it
sooner.

`readRoom(name, { runtime })` returns a plain `RoomSnapshot` with readonly
`messages`, `seats`, and the current `exchange`. It is a pull read and starts
no room or subscription, so a caller can inspect a stopped room without
accidentally creating a run.

One file per concern, in layers an import points down through, and
`room.ts` is the room that composes them ([`toolchain.md`](toolchain.md)
§1 names the layers, and Biome holds them): the
journal in [`journal.ts`](../packages/journal/src/journal.ts), the rules it writes
by in [`rules.verified.ts`](../packages/journal/src/rules.verified.ts),
every fact folded
over it in [`fold.ts`](../packages/ambion/src/room/fold.ts), the step the
room takes in [`reconcile.ts`](../packages/ambion/src/room/reconcile.ts),
who is here in [`presence.ts`](../packages/ambion/src/room/presence.ts), a
seat, what wakes it and the seat's side of the wire in
[`seat.ts`](../packages/ambion/src/seat/seat.ts), one activation in
[`activation.ts`](../packages/ambion/src/seat/activation.ts), the hands it
holds in [`tools.ts`](../packages/ambion/src/seat/tools.ts), an activation's
id and lease in [`lease.ts`](../packages/ambion/src/room/lease.ts), the rules
the fold decides by in
[`rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts), the exchange in
[`exchange.ts`](../packages/ambion/src/room/exchange.ts), what the assistant
writes in [`assistant.ts`](../packages/ambion/src/assistant.ts), what
crosses between a seat and its room in
[`wire.ts`](../packages/ambion/src/wire.ts), what an activation is given
in [`view.ts`](../packages/ambion/src/room/view.ts), what an
agent's tools reach into in
[`workspace.ts`](../packages/ambion/src/tools/workspace.ts), what a host
owns in [`runtime.ts`](../packages/ambion/src/host/runtime.ts), and what
any of them reads in [`render.ts`](../packages/ambion/src/render.ts).

**The journal is the truth, and the room moves by reconciling.** Every fact
about the room is a fold over the journal and the clock: the roster, the
reserve, the people, the open exchange, the closes, the leases, the wakes
still pending and the summaries still owed
([`fold.ts`](../packages/ambion/src/room/fold.ts)). `reconcile()` folds
the journal, decides, writes what it decided, and sends
([`reconcile.ts`](../packages/ambion/src/room/reconcile.ts)). It runs
after every commit, every lease change, every alarm and every wake, and
running it twice writes nothing. Four kinds of entry hold it all in the
room journal: `message`, `lease`, `close`, and `composition`. Every entry
takes its place from one counter, so
a seq names one entry of any kind and the messages are not contiguous. The
room holds one cache beside the journal: when it last sent each wake, which
a resumed room starts empty.

**A seat is seated for the run. An activation lasts seconds.** An
activation's id is derived from the journal: what caused it, where the
cause sits, the seat and the attempt. Three things cause one, and the id
names which: a message the room delivered (`message:4:product:1`), the
question that opened an exchange (`opened:2:assistant:1`), and a close
that owes a summary (`closed:9:assistant:1`). Nothing mints an id, so a wake is safe
to send twice, a retried commit lands once, and every message an
activation writes carries its `activationId`. An activation holds a
lease: `running`, claimed and renewed with an expiry, then `ended`, with
a reason — `released`, `failed`, `refused`, `revoked`, `expired` or
`abandoned`. A
request from an activation whose lease ended is refused as `stale`. A
running lease that stops renewing expires on the room's alarm: the room
reports the expiry as an `error` event, and the seat's next request is
refused. No lease runs past `runtime.wake.deadline` from its claim, ten
minutes by default: the room caps every claim and every renewal there,
the seat cuts the activation when a renewal moves the expiry nowhere,
and the room counts an activation that runs on as one that came to
nothing. What landed while an activation worked and whether it left a
mark belong to the activation and end with it. Rule 5's `readThrough` is
an activation's fact.

**A completed lease answers context that the executor acknowledged.**
A message reaches seats named in its `wakes` and seats working when it lands.
A running lease holds that work while the executor runs. Renewal extends
the lease and records only explicitly reported `readThrough` progress.
The journal position of a renewal does not acknowledge context.

`readThrough` is the highest contiguous record position whose context entered
a provider request. A successful ordinary commit also acknowledges its own
message. Steers carry the previous message position and their own position.
The [Pi context adapter](../packages/ambion/src/seat/pi.ts) connects each
consumed input to that range through structured metadata. A dropped or
reordered steer cannot advance acknowledgment past missing context.
Context returned by a freshness refusal counts when its tool result enters
a provider request.

The executor reports its final position when releasing the lease. Unread
messages remain pending, including messages arriving between the last
renewal and release. A fresh view recovers context that steering did not
deliver. An incomplete attempt cannot reuse an ended activation identifier.
Revocation cancels its named work without claiming that the executor read it.

A lease that expires or fails answers no work. Its words remain on the
record, and the next attempt reads them. Unsuccessful attempts count toward
`runtime.retry`: three attempts by default, with increasing backoff.
At the cap, the room records an `abandoned` activation and stops retrying
its work. Pending activations keep the exchange open until it closes.

**A fold reads the journal's complete history.** Messages and administrative
entries remain ordered and durable together. A resumed room derives the same
state from that record, including lease attempts, pending work, and
idempotency keys.

The record uses `JournalStorage` on the runtime's `storage`. The storage
reads ordered entries and atomically appends only at an expected position.
The default runtime uses one in-memory backend. `sqliteJournals(sql)` opens
named storage in one database. A host wraps its SQLite driver through `Sql`.

The runtime derives its room journals and Pi sessions from that one backend.
Each view uses its own namespaced name. Pi holds transcripts only. A Pi
adapter opens its session through the native journal storage and uses its
atomic append operation.

Two runs may write to one SQLite at once. SQLite compares the storage
position and inserts one next position in one statement. A writer that
races gets no row and reads again. The journal stamps its separate `seq`
inside that stored entry.

**Storage must refuse a moved append.** Every journal storage takes the
position its read returned. It appends at the next storage position or
writes nothing and returns `undefined`. A run fenced while its write waits
is refused before it acknowledges, so the write it held is no loss. SQLite
does this in one `INSERT ... RETURNING` statement. Pi sessions use the same
native storage through their namespaced transcript facade.

**One specification defines each activation.** The room compiles
`ActivationSpec` from the recorded cause and the assistant designation.
The specification names the seat, attempt, input, and granted tool.
`ActivationView` carries this specification with the model and rendered
context. The executor binds its tools from that value.

**The room checks the grant where it commits.** A live lease alone does
not authorize a room action. The transition derives the specification again
and refuses intents outside its grant. Summarising grants a fixed exchange result; composing
grants seating from the reserve; ordinary speech requires a current view.

**What crosses between a seat and its room is JSON.** The seat uses `view`,
`commit`, and `lease`; the room uses `wake` and `cut`. A `CommitRequest`
receives a `CommitResult`. A `LeaseRequest` names `claim`, `renew`, or
`release`. Renewal requires an existing live lease. A repeated claim for
a live activation remains safe.

Every request and response survives a round trip through `JSON.stringify`
unchanged ([`wire.ts`](../packages/ambion/src/wire.ts)). In-process and
Cloudflare hosts implement the same calls.

Lease renewals can carry `readThrough`; omitting it extends liveness without
advancing acknowledgment. Releases report final progress. `expiresAt` names
an absolute time in lease entries, folded state, and responses.
`runtime.wake.expiry` remains a duration. A steer includes `after`, the
preceding message position, so the executor can detect missing context.

**A cut is the room's word, and the record is written before it.** The
room ends every lease the seat holds as `revoked`, and then it cuts. A
seat that never hears the cut is refused whatever it writes, because its
lease ended. A seat that hears it aborts the activation and moves on to
the wake that queued behind it. A model call that ignores the abort
finishes on its own, past a seat that has moved on. A renewal the room
refuses cuts the activation the same way, and a renewal that never
reached the room leaves the lease to expire where it stands: the seat
cuts the activation at that expiry, when the room expires the lease.

**A cut reaches a seat the run never woke.** A run that resumes over a
live lease holds no wire to the seat that took it. The room opens one to
say the cut, so a seat that still runs the activation stops.

**A host owns a `Runtime`.** It holds the clock, the session opener, the
model call, and the policy for wakes and retries: how long a lease
lasts between renewals, how long a wake waits before it is sent again, and
how many drafts the assistant is given
([`runtime.ts`](../packages/ambion/src/host/runtime.ts)). `startRoom`,
`readRoom` and `resumeRoom` take one as an option and default to
`defaultRuntime`, one value per process. Two runtimes in one process share
nothing: one name runs in both, and neither reads the other. "One run per
name" above holds per runtime.

---

## 6. What proves it

The milestone tests live in
[`packages/ambion/test/room.test.ts`](../packages/ambion/test/room.test.ts),
one per claim this document makes loudly:

- parallel activation with mid-activation steering, and a reply waking the idle
  room (rules 1–2, 4);
- working views reset at idle (rule 2);
- silence leaves no mark (rule 3);
- a directed wake reaching a seat at `named`, and a broadcast never
  reaching one (rules 1, 4, 6);
- a racing say refused with what it missed — retry commits, standing down
  leaves no mark (rule 5);
- provenance stamped and the roster injected (rule 7);
- the name opening back into its record;
- events in order, errors as events, abort quieting the room — including
  an abort with a steer still queued;
- a wake lost on the way is sent again, a wake sent twice runs once, a
  release lost on the way expires, and a request under a lease that ended
  is refused ([`lease.test.ts`](../packages/ambion/test/lease.test.ts));
- a room resumed over its journal continues where the last run stopped, on
  every storage ([`restart.test.ts`](../packages/ambion/test/restart.test.ts));
- `decide` writes nothing the second time
  ([`reconcile.test.ts`](../packages/ambion/test/reconcile.test.ts)).

What a crash leaves is proved in
[`chaos.test.ts`](../packages/ambion/test/chaos.test.ts): the room crashes
at every write its journal takes, before and after the entry lands, and is
killed from outside mid-activation, and a host that resumes it and retries
under the same key reaches the same record every time.
[`toolchain.md`](toolchain.md) §8 says how the sweep runs and how to widen
it.

All in-process, in vitest, on a scripted stream where determinism matters.

A second tier, [`test/live`](../packages/ambion/test/live), runs the same
room on a real model with a real key. It proves what a script cannot:

- the model resolves from Pi's catalog (§1), and a refused call is an
  `error` event: silence is a decision, an error is an event;
- a seat with nothing to add declines, and a directed say wakes a seat at
  `named` (rules 3, 4, 6);
- three seats race under the lock, and the room still goes quiet (rule 5,
  and the gap in §7);
- the assistant writes in the person's shape and seats from the reserve;
- a second run of a name reads the first run's record;
- the built-in tools reach a workspace on a real provider;
- `abort()` ends a request in flight, and the room keeps running.

`pnpm test:live` runs it, and [`toolchain.md`](toolchain.md) §8 says when
CI does.

What the exchange adds to these rules is proved in
[`assistant.test.ts`](../packages/ambion/test/assistant.test.ts), listed in
[`exchange.md`](exchange.md) §9. What a person entering and leaving adds is
proved beside them, in
[`presence.test.ts`](../packages/ambion/test/presence.test.ts), and what
the assistant a room seats adds is proved in
[`assistant.test.ts`](../packages/ambion/test/assistant.test.ts).

The runnable proof is [`examples/site`](../examples/site): a construction
management suite where each product is an agent — a time tracker, a task
list seated `attentive` so it meets people at the door, and a materials
tracker — shared by three people who come and go, and one assistant that
writes for each of them. Every rule above is observable by hand there, and the products
hold state they change.

---

## 7. A gap the core has

**An exchange has no end the room enforces.** Two agents that keep
answering each other keep waking each other, and nothing stops them. The
say lock (rule 5) and the bar on speaking (rule 3) push against it, and
that is pressure without a hard bound. [`exchange.md`](exchange.md) §8
records the gap and what is built on top of it.

---

## 8. The measure

Ambion ships a multi-agent runtime and writes no agent loop: two definition
helpers, a facade, and a room. If that ratio ever inverts — if Ambion finds
itself owning retries or context windows or a tool format — the wrapper has
become a reimplementation, and the right response is to delete Ambion's
version.

Four things to define. One dependency that does the rest.
