# The Agent

This document is the design contract for Ambion's core, and the core is
shipped. The whole runtime lives in
[`packages/ambion/src`](../packages/ambion/src) — definitions in
[`define.ts`](../packages/ambion/src/define.ts), the room in
[`session.ts`](../packages/ambion/src/session.ts), the public shapes in
[`types.ts`](../packages/ambion/src/types.ts).

Four functions build a room, and one sentence holds the whole of it:

> **`defineAgent` makes an agent, `defineHuman` names a person, `defineTool`
> gives agents hands, and `startSession` brings up a named room the agents
> work in and people visit — each agent deciding for itself whether to speak,
> to whom, and which colleague to call in.**

Two documents build on this core and are also shipped:
[`presence.md`](presence.md) puts people in a running room, and
[`assistant.md`](assistant.md) adds the assistant every person brings.

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
| **The session as a room**                 | **Ambion** |

Ambion owns two concerns. A third concern is a design failure: push it into
a dependency or drop it. The single extension point is Pi's own:
`startSession` accepts a `streamFn`. A scripted stream makes the room
deterministic — this is how [the tests](../packages/ambion/test/session.test.ts)
run — and a custom stream brings custom providers. Ambion keeps no model
registry of its own. Without a `streamFn`, models resolve as
`provider/model-id` from Pi's builtin catalog, and API keys come from
`<PROVIDER>_API_KEY` in the environment.

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

That is the entire surface. `name` identifies the agent inside a session and
on the record. `identity` is the public face: one or two sentences the whole
room reads, injected into every participant's context as part of the roster.
`instructions` are private. They are the agent's own voice, appended to the
runtime's system prompt, and they hold all of the agent's judgment —
including the judgment to say nothing. The runtime's prompt is always
present; instructions extend it.

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
receives the parsed parameters as its first argument, and it may return a
plain string or Pi's full content shape. A tool defined with Pi's own
`defineTool` works unchanged (`toPiTool` in `seat.ts` accepts both), so
learning Pi's format is the same as learning Ambion's. Tools are the
agent's only hands in this cut.

---

## 4. defineHuman

```ts
import { defineAgent, defineHuman } from '@ambionframework/ambion';

export const andrei = defineHuman({
  name: 'andrei',
  identity: 'Founder. Owns the weekly. Bring him blockers only.',
  assistant: defineAgent({
    name: 'andrei-assistant',
    identity: 'Holds how andrei reads.',
    model: 'anthropic/claude-sonnet-5',
    instructions: 'Lead with blockers. Four sentences at most.',
  }),
});
```

A human is a participant: on the roster like an agent, on the record like an
agent. `identity` is how the room knows them. A human has no instructions,
no tools, and no model, because humans are never run — a `say` directed at
one wakes nothing.

One required field goes with them: `assistant`, an agent that holds how its
person reads. It writes the one message they read when an exchange closes.
It is a seat at the narrow end of attention: nothing said reaches it, no message
activates it, and nothing it writes wakes anybody. [`assistant.md`](assistant.md) is
the contract for it.

A human is outside a room's composition, so `startSession` never takes one.
The value is what somebody visits as: `visitSession(session, andrei)`
returns a visit, the visit delivers, and the runtime stamps the record from
it. Who-said-what comes from the runtime's own observation, never from a
claim inside the content. One person holds one visit, several people visit
at once, and each one's presence is a fact the agents read.
[`presence.md`](presence.md) is the contract for that, and for the arrival
a visit puts on the record.

---

## 5. startSession

```ts
import {
  readSession,
  startSession,
  stopSession,
  visitSession,
  passive,
} from '@ambionframework/ambion';

const session = startSession({
  name: 'weekly',
  goal: 'Draft the weekly digest and flag what does not hold.',
  agents: [researcher, writer, passive(archivist)],
});

const unsubscribe = session.subscribe((event) => {
  if (event.type === 'message') console.log(`${event.message.from}: ...`);
});

const visit = await visitSession(session, andrei);
await visit.deliver({ text: 'Draft the weekly. Anything to flag?' });
await session.settled();

await stopSession(session);

// later, in any process, with no agents standing up
for (const message of await readSession('weekly').messages()) {
  console.log(`${message.from}: ${message.text}`);
}
```

Three verbs, and each does one thing:

- **`startSession` sets up the context where the agents work.** It takes
  the room's composition and brings it to life: from here on the seats are
  live and a message activates them.
- **`stopSession` takes it down**: every activation in flight is aborted, every
  visit is closed, the write chain drains, and the handle refuses further
  use.
- **`readSession` reads a name and starts nothing**: the record, and who
  was in it, with no seat standing up and nothing to bill. You can read a
  room that is idle; you can only speak into a running one.

A person is the fourth verb and lives in [`presence.md`](presence.md):
`visitSession` puts them in a running room.

A session is a named entity that outlives any run of it. Three rules of
identity follow.

**The record belongs to the name.** What was said in `'weekly'` is there
whenever `'weekly'` is read, for as long as the storage lives, whether or
not anything is running.

**The run belongs to `startSession`.** The agents passed are the room's
composition for this run. A name can be started again with a different
roster, and the record still shows who said what, stamped at the time it
landed. A long-lived room is many runs over one record, and `readSession`
reaches the record between them.

**One run per name.** `startSession` refuses a name already running in this
process. Two live rooms over one record would each replay it, each append
to it, and diverge. Names are unique inside a roster too: `startSession`
refuses a duplicate, and so does `visitSession`, so `say({ to })` always
names exactly one participant.

`startSession` is synchronous and the room is usable at once; the replay it
needs is awaited by the first call that needs it. `stopSession` returns a
promise, because draining is the point of calling it.

The record holds one union (`Message` in `types.ts`): what a participant
said, what a person did, and what one exchange came to.

```ts
type Message =
  | {
      kind: 'said';
      seq: number; // monotonic, assigned at commit, strictly ordered
      at: string; // stamped by the runtime, at the moment it landed
      from: string; // a participant's name — stamped by the runtime, never claimed
      to?: string; // present when the delivery or say was directed
      text: string;
    }
  | {
      kind: 'arrived' | 'left';
      seq: number;
      at: string;
      from: string; // stamped from the visit the runtime observed
      identity?: string; // on 'arrived' alone: how the room knew them
    }
  | {
      kind: 'summary';
      seq: number;
      at: string;
      from: string; // the assistant that wrote it
      to: string; // the person whose question opened the exchange
      text: string;
      covers: { from: number; through: number }; // the range it stands for
    };
```

The second kind carries no `text`, because the person said nothing.
[`presence.md`](presence.md) specifies it. The third is written by an assistant
when an exchange closes, and nobody spoke it; [`assistant.md`](assistant.md)
specifies it. Every rule below applies to all three kinds unchanged, which
is why the record holds one union and one sequence.

Beyond identity, the mechanics are eight rules. The first six are the
room's routing and voice; all of the routing is one function, `dispatch` in
`session.ts`.

**1. Every message activates every idle agent, in parallel.** A human's
delivery, a person arriving, and a colleague's undirected `say` route
identically. Seats sit out when their attention is too narrow for the
message (rule 6); everyone else at rest evaluates at once, and replies land
on the record in arrival order. A reply that lands after colleagues went
idle wakes them again, so it is heard now and never waits for the next
delivery. With one agent this degenerates to ordinary chat: the room is the
general case, and the single assistant is its size-one instance.

A message
may also be directed: `visit.deliver({ to, text })` and `say({ to })`
activate exactly the named participant, waking it however narrowly it is
seated. `to` is a participant handle; directed at a human it addresses the
reader and wakes nothing.

**2. Whatever arrives mid-activation is steered in, and working views reset at
idle.** Replies and deliveries alike, directed or undirected: each arrival
is injected into every active agent's running activation at the next safe point,
so nobody finishes blind and answers stale. "Round" is deliberately a
soft-edged word: the room has no barrier, only quiet, and quiet is what
`settled` reports. Mid-flight, each agent may see the conversation in a
slightly different order than the record. Its working view is its own,
temporary by design: when the agent goes idle the view is discarded, and
the next activation reads the record itself. The record is canonical.

**3. Speaking is a tool; silence is the default.** An activated agent holds
one built-in tool, `say({ to?, text })` (`sayTool` in `session.ts`). Ending
an activation without calling it is declining. Declining leaves no mark on the
record — the way a colleague reads the room and keeps working. The tool
refuses an empty text for the same reason: a message with nothing in it
still takes a seq, renders in every context after it, and wakes whoever
hears it.

The runtime's prompt (`systemPrompt` in `session.ts`) sets the
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

**5. No one speaks over the room.** A message commits only against a record
its author has read in full. For a seat that is its `say`, checked against
the view it was handed plus every steer that has landed in its transcript
since (`viewSeq` in `seat.ts`). If the record moved past that, the say
fails without landing, and the failure carries the messages the seat
missed: the same steering contract, enforced at the tool boundary, where
delivery is guaranteed. The seat then decides again — speak because
something is still worth adding, or go quiet because the point stands;
rule 3's bar, now with the hearing enforced.

First to commit wins, ties are
impossible (the check and the commit share one tick), and a room with no
races pays nothing. The refusal shows on the stream as `conflict`, which
names the author: an assistant's summary is refused at the same boundary, for
the same reason. The guarantee is the point: every message on the record
was written by somebody who had read everything before it.

**6. A seat has a status and an attention, and they are different things.**
Status is runtime: `active` (taking an activation now) or `idle` (at rest).
Attention is a seating choice, and it is what rule 1 defers to when it says
who sits out — one widening scale, from the narrowest:

- `none` — nothing said in the room reaches it, and it cannot be addressed:
  the runtime refuses a directed say to it, so no message waits unread. The seat that is
  present and unreachable, waiting for something other than a message. An
  assistant sits here ([`assistant.md`](assistant.md)), woken by the close of its person's
  exchange and by nothing else.
- `named` — hears a message addressed to it, seated as `passive(archivist)`.
  The expert in the corner: hearing nothing, costing nothing, until someone
  asks.
- `broadcast` — also hears anything a participant said. The default, and
  what a bare agent in `agents` gets.
- `presence` — also wakes when somebody arrives or leaves, seated as
  `attentive(concierge)`.

**The scale is the mechanism; the words are shorthand for points on it.**
`seated(agent, attention)` is the general form, and `passive` and
`attentive` are one line each over it — the two points a room names often
enough to be worth a word. A bare agent takes the default. `none` is the
runtime's own point: it is where an assistant sits, and nothing in a room's
composition asks for it.

The routing is the scale, and reads as one line (`wakes` in `seat.ts`):
every message has a **reach** — `named` for a directed say, `broadcast` for
anything else said, `presence` for somebody arriving or leaving — and a
seat wakes when its attention is at least that wide. A directed message
additionally wakes the one it names and nobody else, which is what makes it
a focusing act.

Both are readable from `session.seats()`, so a seat that is `named` and
running is describable, which one enum could not do. Attention belongs to
the seating, and `defineAgent` knows nothing about it, so the same agent
can be the quiet corner in one room and the one who meets people in
another — and an assistant can be given a wider attention the day it is meant to
take part in the room, while staying the same kind of thing.

**7. Identity is injected; provenance is stamped.** Every agent's context
carries the session's goal, the time, and two rosters — the agents, with
their statuses spelled out so a seat knows a broadcast will never reach the
colleague seated `passive` in the corner, and the people, with how long
each one has been reading or gone. On the record, `from` is written by the
runtime: `say` is stamped with its agent, a delivery is stamped from the
live visit that made it, and an arrival is stamped from the visit the
runtime observed opening. No one self-reports who they are.

**8. The room hears what you said — and your keystrokes are kept aside.**
Each agent's tool calls belong to its own working context; other
participants see its `say`s only, because the record is all any view
renders. The hands are still auditable: every activation's full turns land
in the seat's own downstream Pi session — `<room>:<agent>`, parented to the
room's, named by `seats().sessionId`, listed by the same repo (`persistRun`
in `session.ts`) — so what an agent actually did can be replayed long after
its working view reset. The record is never rewritten for anyone.

### Observing the room

The observation surface is Pi's `Agent` API lifted one level: the same
`subscribe(listener)` returning an unsubscribe function, an event per fact,
and one property a room needs that a single agent does not — every event
names its seat. The stream carries room-level facts only (`SessionEvent` in
`types.ts`):

```ts
type SessionEvent =
  | { type: 'message'; message: Message }
  | { type: 'activation_start'; agent: string }
  | { type: 'conflict'; author: string; missed: Message[] }
  | { type: 'tool_execution_start'; agent: string; toolName: string }
  | { type: 'tool_execution_end'; agent: string; toolName: string }
  | { type: 'activation_end'; agent: string; spoke: boolean }
  | { type: 'error'; agent: string; error: Error }
  | { type: 'exchange_opened'; exchange: Exchange }
  | { type: 'exchange_closed'; exchange: ClosedExchange }
  | { type: 'quiet' };
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
until the room goes quiet. The two words this document uses are `activation`
and `exchange`; `turn` in these pages is Pi's, or plain English in a sentence
a model reads.

Three events are the room's own:

- `message`;
- `conflict` — rule 5's lock refusing a message that raced past the
  record, so the host sees every race the lock caught;
- `error`, which distinguishes a failed activation from a quiet one.

`settled()` is a promise with no event beside it: it resolves at the
moment no agent is active, and the window between `settled()` and `quiet`
is the one place a caller can act while a summary is drafted. **Silence is
a decision; an error is an event.** A crashed tool or a refused model call
never masquerades as declining: it reaches the host on the stream, and
leaves no mark on the record.

One distinction keeps rule 8 honest: the event stream serves the host, and
the host holds no seat at the table. Participants' contexts never see each
other's tool executions. The stream sees them, because the host operating
the room is the code that owns it, and debugging a room means watching
hands as well as hearing voices.

### The exchange: the room's own unit of work

A room is a sequence of exchanges, and the exchanges have one shape. **A person
asks something, several agents wake and work it out between them, and the
room goes quiet again.** That shape is the exchange, and it belongs to the
room itself, ahead of any one feature
([`exchange.ts`](../packages/ambion/src/exchange.ts)):

```ts
interface Exchange {
  /** The person whose question opened it, and who owns what follows. */
  owner: string;
  /** The seq of that question: where the exchange starts. */
  from: Seq;
  at: string;
}

interface ClosedExchange extends Exchange {
  /** The last seq on the record when the room went quiet. */
  through: Seq;
}
```

Three sentences hold the whole rule.

**A person's question opens one, when no exchange is open.** Nothing else
does. An agent speaking into a quiet room opens nothing, because a room
that talks to itself is answering nobody; arriving and leaving open
nothing, because nobody asked anything by opening a workspace. The clause
is written on the exchange itself, for the case where the room is busy and
has no owner: somebody arrives, the seat that watches the door wakes, and a
question lands on top of work nobody asked for. That question still owns
what follows.

**Quiescence closes it.** The room settles when no agent is active, and a
room that settles has finished: a seat that says something wakes its
readers inside its own `say`, before its own activation ends, so the room is
never briefly empty in the middle of a burst. What is running is read off the
seats — a seat holds the activation it is taking — so there is no count beside
them to keep in step. `through` is the record as it stood at that moment, so a
closed exchange names the range it turned out to hold.

**What lands while it is open steers it and changes nothing** — the owner,
the range, and who the answer belongs to all stay fixed. A second question
from the same person, or a word from somebody else, reaches the seats
already working (rule 2) and starts nothing new.

`exchange()` reads the open one, and the stream carries both edges. An
exchange is run state: a restart begins with none, because the record keeps
what was said and nobody is mid-question after a restart.

**What reads it.** A person's assistant is a seat that a closed exchange wakes,
and the one message it writes stands for that exchange ([`assistant.md`](assistant.md)).
A client folds the working under the question it answered and shows the
exchange as a thinking state — which it can do from these two events alone,
whether or not the assistant writes anything for this particular one (it may
not: [`assistant.md`](assistant.md) §4). A host that measures what a room
costs measures it per exchange, because that is what somebody asked for. A
later room-level compactor stands over a stretch of closed exchanges.

Two completion signals, for the two things a host waits on, and two
controls:

- **`deliver()`** resolves on acceptance — the message is on the record
  and activations are dispatched. It never waits for completion, because activations run in
  parallel and have no single caller to return to.
- **`settled()`** is the exchange's end: a promise that resolves when the
  seats stop, which is also the moment a host learns that nobody chose to
  speak. It reports that no seat which speaks for itself is taking an
  activation.
  An assistant writing about an exchange is not the room still working on it, so
  the room is never held busy while one writes.
- **`quiet()`** is the second moment — no agent at all is taking an activation —
  for a host that wants the one message a person reads
  ([`assistant.md`](assistant.md) §14). The two differ because an assistant is a seat
  like any other, and its activation counts. That difference keeps an
  exchange's end fixed when somebody brings one. The order at the end of an
  exchange is fixed: `settled()` resolves, then `exchange_closed`, then
  whatever is written about it, then `quiet`.
- **`abort()`** cancels every activation in flight — Pi's own abort, fanned
  out —
  and the room settles. What was said stays, what was mid-flight ends
  without speaking, and an aborted activation stays cancelled even if a steer
  was still queued against it. The room is still running afterwards.
- **`stopSession`** is the one that ends it, and it is `abort()` plus
  everything else a run holds: the visits close, the writes drain, and the
  handle is spent.

`messages()` and `seats()` are the pull side; the stream is the push side.
A listener learns nothing the pulls cannot tell it — it only learns it
sooner.

`readSession(name, { repo })` returns the pull side alone — `messages()`,
`seats()`, `subscribe()` — and `Session` extends it, so code that only
reads takes the narrower type and cannot start anything by accident.

One file per concern, and `session.ts` is the room that composes them: the
record in [`record.ts`](../packages/ambion/src/record.ts), who is here in
[`presence.ts`](../packages/ambion/src/presence.ts), a seat and what wakes it
in [`seat.ts`](../packages/ambion/src/seat.ts), one activation in
[`activation.ts`](../packages/ambion/src/activation.ts), the exchange in
[`exchange.ts`](../packages/ambion/src/exchange.ts), what a person's assistant
writes in [`assistant.ts`](../packages/ambion/src/assistant.ts), and what any of them
reads in [`render.ts`](../packages/ambion/src/render.ts).

**A seat is seated for the run. An activation lasts seconds.** What an
activation has heard, what landed while it worked, and whether it left a mark
belong to the activation and end with it. Rule 5's `readThrough` is an
activation's fact.

Storage is Pi's. The record lives in a Pi session — each message a custom
entry, replayed in `seq` order on reopen — obtained from Pi's own
`SessionRepo`, which `startSession` and `readSession` accept and default to
an in-process `InMemorySessionRepo`. A name that outlives the process is a
durable `SessionRepo` implementation; the API stays the same.
[`index.ts`](../packages/ambion/src/index.ts) re-exports Pi's storage
surface, and Ambion adds no storage layer of its own.

---

## 6. What proves it

The milestone tests live in
[`packages/ambion/test/session.test.ts`](../packages/ambion/test/session.test.ts),
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
  an abort with a steer still queued.

The exchange is proved beside the assistant that first reads one, in
[`assistant.test.ts`](../packages/ambion/test/assistant.test.ts): a question opens a
exchange and quiescence closes it, holding the range it covered; an arrival
opens none and a second message into an open one changes nothing; and an
exchange closes before anything is written about it. All in-process, in
vitest, on a scripted stream where determinism matters. What a person
entering and leaving adds to these rules is proved beside them, in
[`presence.test.ts`](../packages/ambion/test/presence.test.ts), and what
the assistant a person brings adds is proved in
[`assistant.test.ts`](../packages/ambion/test/assistant.test.ts).

The runnable proof is [`examples/site`](../examples/site): a construction
management suite where each product is an agent — a time tracker, a task
list seated `attentive` so it meets people at the door, and a materials
tracker — shared by three people who come and go, each bringing an assistant of
their own. Every rule above is observable by hand there, and the products
hold state they change.

---

## 7. A gap the core has

**An exchange has no end the room enforces.** Two agents that keep
answering each other keep waking each other, and nothing stops them. The
say lock pushes against it — a seat that speaks late is refused and told to
reconsider, and rule 3 tells it to stand down — but that is pressure
without a hard bound. No run has hit it. It is written down because a room
that waits for months will meet it eventually, and because anything built
on quiescence assumes it does not happen. [`assistant.md`](assistant.md) is built on
it: an assistant writes when the room goes quiet, so a room that never goes
quiet never gets its one message.

---

## 8. The measure

Ambion ships a multi-agent runtime and writes no agent loop: two definition
helpers, a facade, and a room. If that ratio ever inverts — if Ambion finds
itself owning retries or context windows or a tool format — the wrapper has
become a reimplementation, and the right response is to delete Ambion's
version.

Four things to define. One dependency that does the rest.
