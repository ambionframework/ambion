# The Agent

This document is the design contract for Ambion's core, and the core is
shipped: the whole runtime lives in
[`packages/ambion/src`](../packages/ambion/src) — definitions in
[`define.ts`](../packages/ambion/src/define.ts), the room in
[`session.ts`](../packages/ambion/src/session.ts), the public shapes in
[`types.ts`](../packages/ambion/src/types.ts).

Four things to define and a session to put them in, and the whole of it fits
in one sentence:

> **`defineAgent` makes an agent, `defineHuman` names a person, `defineTool`
> gives agents hands, and `startSession` brings up a named room the agents
> work in and people visit — each agent deciding for itself whether to speak,
> to whom, and which colleague to call in.**

Everything Ambion intends beyond this — the virtual shell and workspace
filesystem, channels and their read/write contracts, timers, batching,
routing, the tenant — is deliberately out of scope for now, and will arrive
as its own documents. This one is the buildable core.

---

## 1. Nothing new under the loop

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

Two things. If a third appears, it is a design failure and should be pushed
back into a dependency or dropped. The single extension point is Pi's own:
`startSession` accepts a `streamFn` — a scripted stream makes the room
deterministic (this is how [the tests](../packages/ambion/test/session.test.ts)
run), a custom stream brings custom providers. There is no Ambion model
registry: without a `streamFn`, models resolve as `provider/model-id` from
Pi's builtin catalog, and API keys come from `<PROVIDER>_API_KEY` in the
environment.

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
on the record. `identity` is the public face — one or two sentences the whole
room reads, injected into every participant's context as part of the roster.
`instructions` are the private half: the agent's own voice, appended to the
runtime's system prompt, never replacing it, and the home of all judgment —
including the judgment to say nothing. `defineAgent` returns a value;
everything that refers to an agent refers to this value, not to a string.

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

A facade over Pi's tool shape, not a format of Ambion's own: the same
name-description-parameters-execute, with one convenience — `execute`
receives parsed parameters first and may return a plain string (or Pi's full
content shape). A tool defined with Pi's own `defineTool` works unchanged
(`toPiTool` in `session.ts` accepts both); learning Pi's is still learning
Ambion's. Tools are the agent's only hands in this cut.

---

## 4. defineHuman

```ts
import { defineHuman } from '@ambionframework/ambion';

export const andrei = defineHuman({
  name: 'andrei',
  identity: 'Founder. Owns the weekly. Bring him blockers, not status.',
});
```

A human is a participant, not an operator: on the roster like an agent, on
the record like an agent. `identity` is how the room knows them. What a human
never has: instructions, tools, or a model — humans are not run, and a `say`
directed at one wakes nothing.

One optional field goes with them: `aide`, an agent that holds their brief and
writes the one message they read when an exchange closes. It is a seat at the
narrow end of attention: nothing said reaches it, no message activates it, and
nothing it writes wakes anybody. [`aide.md`](aide.md) is the contract for it.

A human is not composition and is not passed to `startSession`. The value is
what somebody visits as: `visitSession(session, andrei)` returns a visit, the
visit delivers, and the runtime stamps the record from it — who-said-what is
never something the content claimed. One person holds one visit, several
people visit at once, and each one's presence is a fact the agents read. [`presence.md`](presence.md) is the contract for that,
and for the arrival a visit puts on the record.

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

Three verbs, and each does one thing. **`startSession` sets up the context
where the agents work.** It takes the room's composition and brings it to
life: from here on the seats are live and a message activates them.
**`stopSession` takes it down**: every active turn is aborted, every visit is
closed, the write chain drains, and the handle refuses further use. **`readSession` reads a name and starts
nothing** — the record, and who was in it, with no seat standing up and
nothing to bill. You can read a room that is not running; you cannot speak
into one. A person is the fourth verb and lives in
[`presence.md`](presence.md): `visitSession` puts them in a running room.

A session is a named entity that outlives any run of it. Three rules of
identity follow.

**The record belongs to the name.** What was said in `'weekly'` is there
whenever `'weekly'` is read, for as long as the storage lives, whether or not
anything is running.

**The run belongs to `startSession`.** The agents passed are the room's
composition for this run, so a name can be started again with a different
roster and the record still shows who said what, stamped then, not inferred
now. A long-lived room is many runs over one record, and `readSession`
reaches the record between them.

**One run per name.** `startSession` refuses a name already running in this
process, because two live rooms over one record would each replay it, each
append to it, and diverge. Names are unique inside a roster too —
`startSession` refuses a duplicate, and so does `visitSession` — rather than
letting `say({ to })` become ambiguous.

`startSession` is synchronous and the room is usable at once; the replay it
needs is awaited by the first call that needs it. `stopSession` returns a
promise, because draining is the point of calling it.

What the record holds is one union (`Message` in `types.ts`): what a
participant said, what a person did, and what one exchange came to.

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
      from: string; // the aide that wrote it
      to: string; // the person whose question opened the exchange
      text: string;
      covers: { from: number; through: number }; // the range it stands for
    };
```

The second kind carries no `text`, because the person said nothing.
[`presence.md`](presence.md) specifies it. The third is written by an aide
when an exchange closes, and nobody spoke it; [`aide.md`](aide.md) specifies
it. Every rule below applies to all three kinds unchanged, which is why it is
one union and not three records.

Beyond identity, the mechanics are eight rules. The first six are the room's
routing and voice; all of the routing is one function, `dispatch` in
`session.ts`.

**1. Every message activates every idle agent, in parallel.** A human's
delivery, a person arriving and a colleague's undirected `say` route
identically: seats sit out when their attention is too narrow for it (rule 6);
everyone else at rest evaluates at once, and replies land
on the record in arrival order — so a reply that lands after colleagues went
idle is still heard, not stranded until the next delivery. With one agent
this degenerates to ordinary chat: the room is the general case, the
assistant its size-one instance. A message may also be directed:
`visit.deliver({ to, text })` and `say({ to })` activate exactly the named
participant, waking it however narrowly it is seated. `to` is a participant handle;
directed at a human it is an address for the reader and wakes nothing.

**2. Whatever arrives mid-turn is steered in — and working views reset at
idle.** Replies and deliveries alike, directed or not: each arrival is
injected into every active agent's running turn at the next safe point, so
nobody finishes blind and answers stale. "Round" is deliberately a soft-edged
word — the room has no barrier, only quiet, and quiet is what `settled`
reports. Mid-flight, each agent may see the conversation in a slightly
different order than the record: its working view is its own, scaffolding
rather than state. When the agent goes idle the view is discarded, and the
next activation reads the record itself. The record is canonical; working
views are ephemeral.

**3. Speaking is a tool; silence is the default.** An activated agent holds
one built-in tool, `say({ to?, text })` (`sayTool` in `session.ts`). Ending a
turn without calling it is declining — no mark on the record, the way a
colleague reads the room and keeps working. Saying nothing is also declining:
the tool refuses an empty text, because a message with nothing in it still
takes a seq, renders in every context after it, and wakes whoever hears it. The runtime's prompt
(`systemPrompt` in `session.ts`) sets the bar for every seat: a reply must
add something the record does not already hold — new information, a decision
moved forward, or a genuinely different perspective — and a point already
made, even in other words, is met with silence. Whether a reply clears the
bar is judgment, and the judgment lives in `instructions`; the runtime states
the bar but never decides for the agent. Glances are still billed — a room of
three costs three looks per message, replies included — the honest price of a
room, stated rather than hidden. The bar is also what keeps the room from
echoing itself: every reply wakes the idle room (rule 1), so what prevents
ping-pong is not routing but judgment — a woken seat with nothing to add
declines, and the lock (rule 5) refuses the duplicate that slips through.

**4. A directed `say` focuses the room's attention.** An undirected `say`
speaks to everyone, like any message. `say({ to: 'writer' })` narrows it: the
named colleague is woken, however narrowly it is seated — the only way a
seat at `named` hears
anything — and the rest of the idle room stays at rest; every escalation is
explicit, on the record, and paid for on purpose. Directed at a human, it
addresses the reader and wakes nothing. The runtime's prompt pairs this with
a rule against rehearsal: a question only one participant can answer is asked
with one directed `say`, never posed to the room first — a `say` is a
message, not a thought.

**5. No one speaks over the room.** A message commits only against a record
its author has read in full. For a seat that is its `say`, against the view it
was handed plus every steer that has landed in its transcript since (`viewSeq`
in `session.ts`). If the record
moved past that, the say fails without landing, and the failure carries the
messages the seat missed: the same steering contract, enforced at the tool
boundary, where delivery is guaranteed rather than best-effort. The seat then
decides again — speak because something is still worth adding, or go quiet
because the point stands; rule 3's bar, now with the hearing enforced. First
to commit wins, ties are impossible (the check and the commit share one
tick), and a room with no races pays nothing. The refusal shows on the stream
as `conflict`, which names the author rather than the seat: an aide's summary
is refused at the same boundary, for the same reason. The guarantee is the
point: every message on the record was written by somebody who had read
everything before it.

**6. A seat has a status and an attention, and they are different things.**
Status is runtime: `active` (taking a turn now) or `idle` (at rest).
Attention is a seating choice, and it is what rule 1 defers to when it says
who sits out — one widening scale, from the narrowest:

- `none` — nothing said in the room reaches it, and it cannot be addressed:
  a directed say to it is refused rather than left unread. The seat that is
  present and unreachable, waiting for something other than a message. An
  aide sits here ([`aide.md`](aide.md)), woken by the close of its person's
  exchange and by nothing else.
- `named` — hears a message addressed to it, seated as `passive(archivist)`.
  The expert in the corner: hearing nothing, costing nothing, until someone
  asks.
- `broadcast` — also hears anything a participant said. The default, and what
  a bare agent in `agents` gets.
- `presence` — also wakes when somebody arrives or leaves, seated as
  `attentive(concierge)`.

**The scale is the mechanism; the words are shorthand for points on it.**
`seated(agent, attention)` is the general form, and `passive` and `attentive`
are one line each over it — the two points a room names often enough to be
worth a word. A bare agent takes the default, and `none` is the runtime's own:
it is where an aide sits, and nothing in a room's composition asks for it.

The routing is the scale, and reads as one line (`wakes` in `session.ts`):
every message has a **reach** — `named` for a directed say, `broadcast` for
anything else said, `presence` for somebody arriving or leaving — and a seat
wakes when its attention is at least that wide. A directed message
additionally wakes the one it names and nobody else, which is what makes it a
focusing act rather than a louder one.

Both are readable from `session.seats()`, so a seat that is `named` and
running is describable, which one enum could not do. Attention belongs to the
seating rather than to `defineAgent`, so the same agent can be the quiet
corner in one room and the one who meets people in another — and an aide can
be given a wider one the day it is meant to take part in the room, without
becoming a different kind of thing.

**7. Identity is injected; provenance is stamped.** Every agent's context
carries the session's goal, the time, and two rosters — the agents, with
their statuses spelled out so a seat knows a broadcast will not reach the
colleague seated `passive` in the corner, and the people, with how long each one has
been reading or gone. On the record, `from` is written by the runtime: `say`
is stamped with its agent, a delivery is stamped from the live visit that
made it, and an arrival is stamped from the visit the runtime observed
opening. No one self-reports who they are.

**8. The room hears what you said, not your keystrokes — and the keystrokes
are kept.** Each agent's tool calls belong to its own working context; other
participants see its `say`s only, because the record is all any view renders.
The hands are still auditable: every activation's full turns land in the
seat's own downstream Pi session — `<room>:<agent>`, parented to the room's,
named by `seats().sessionId`, listed by the same repo (`persistRun` in
`session.ts`) — so what an agent actually did can be replayed long after its
working view reset. Compaction, when it comes, is per-seat working context;
the record is never rewritten for anyone.

### Observing the room

The observation surface is Pi's `Agent` API lifted one level: the same
`subscribe(listener)` returning an unsubscribe function, an event per fact,
and one property a room needs that a single agent does not — every event
names its seat. The stream carries room-level facts only (`SessionEvent` in
`types.ts`):

```ts
type SessionEvent =
  | { type: 'message'; message: Message }
  | { type: 'agent_start'; agent: string }
  | { type: 'conflict'; author: string; missed: Message[] }
  | { type: 'tool_execution_start'; agent: string; toolName: string }
  | { type: 'tool_execution_end'; agent: string; toolName: string }
  | { type: 'agent_end'; agent: string; spoke: boolean }
  | { type: 'error'; agent: string; error: Error }
  | { type: 'exchange_opened'; exchange: Exchange }
  | { type: 'exchange_closed'; exchange: ClosedExchange }
  | { type: 'quiet' };
```

**One message on the record, one `message` event.** What a person delivered,
what an agent said, a person arriving or leaving, and the summary an aide
wrote all reach the host the same way, because they are the same thing: an
entry the room committed. Who
wrote it is `message.from`, which the roster already names, so the stream does
not split by author. The event is atomic as the record is: one event, the
whole message, exactly as it landed.

Pi's `agent_start`/`agent_end` are these, attributed; Pi's `tool_execution_*`
pass through with the seat named. Pi's
`message_*` granularity — streaming deltas, partial turns — is deliberately
not re-broadcast: finer visibility is the seat's own layer, reached through
Pi's hooks on the seat's downstream session, not the room forwarding messages
it did not speak. Four events are the room's own: `message`; `settled` — the
moment no agent is active; `conflict` — rule 5's lock refusing a message that
raced past the record, so the host sees races caught, not silently retried;
and `error`, which distinguishes a failed turn from a quiet one. **Silence is
a decision; an error is an event.** A crashed tool or a refused model call
never masquerades as declining: it reaches the host on the stream, and leaves
no mark on the record.

One distinction keeps rule 8 honest: the event stream is the host's
instrument panel, not a seat at the table. Participants' contexts never see
each other's tool executions; the stream sees them, because the host
operating the room is the tenant's own code, and debugging a room means
watching hands as well as hearing voices.

### The exchange: the room's own round

A room is not a stream of unrelated messages. **A person asks something,
several agents wake and work it out between them, and the room goes quiet
again.** That shape is the exchange, and it is the room's, not any one
feature's ([`exchange.ts`](../packages/ambion/src/exchange.ts)):

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
does. An agent speaking into a quiet room opens nothing, because a room that
talks to itself is not answering anybody; arriving and leaving open nothing,
because nobody asked anything by opening a workspace. The clause is written on
the exchange rather than on the room's status, for the case that is busy and
has no owner: somebody arrives, the seat that watches the door wakes, and a
question lands on top of work nobody asked for. That question still owns what
follows.

**Quiescence closes it.** The room settles when no agent is active, and a room
that settles has finished: a seat that says something wakes its readers inside
its own `say`, before its own turn ends, so the active count never dips to
zero in the middle of a burst. `through` is the record as it stood at that
moment, so a closed exchange names the range it turned out to hold.

**What lands while it is open steers it and changes nothing** — not the owner,
not the range, not who the answer belongs to. A second question from the same
person, or a word from somebody else, reaches the seats already working
(rule 2) and starts nothing new.

`exchange()` reads the open one, and the stream carries both edges. It is run
state: a restart begins with none, because the record keeps what was said and
nobody is mid-question after a restart.

**What reads it.** The aide is the first thing and not the last: its person's
aide is a seat that a closed exchange wakes, and the one message it writes
stands for that round ([`aide.md`](aide.md)). A client folds the working under
the question it answered and shows the round as a thinking state — which it
can do from these two events alone, in a room where nobody brought an aide. A
host that measures what a room costs measures it per round, because a round is
what somebody asked for. A later room-level compactor stands over a stretch of
closed exchanges rather than over a message count.

Two completion signals, for the two things a host waits on. `deliver()`
resolves on acceptance — the message is on the record and activations are
dispatched — never on completion, because a parallel round has no single
caller to return to. The round's end is `settled()`: a promise that resolves
when the seats stop, which is also the moment a host learns that nobody chose
to speak. It reports that no seat which speaks for itself is taking a turn:
an aide writing about a round is not the room still working on it, so the room
is never held busy while one writes. `quiet()` is the second moment — no agent
at all is taking a turn — for a host that wants the one message a person reads
([`aide.md`](aide.md) §14). The two differ because an aide is a seat like any
other and its turn is a turn, and the difference is what keeps a round's end
from moving when somebody brings one. The window between the two is the only
place a caller can act while a summary is being drafted, which is why
`settled()` is a promise and not an event. The order at the end of a round is
fixed: `settled()` resolves, then `exchange_closed`, then whatever is written
about it, then `quiet`. And two controls. `abort()` cancels every active turn — Pi's
own abort, fanned out — and the room settles; what was said stays, what was
mid-flight ends without speaking, and an aborted turn stays cancelled even if
a steer was still queued against it. The room is still running afterwards.
`stopSession` is the one that ends it, and it is `abort()` plus everything
else a run holds: the visits close, the writes drain, and the handle is
spent. `messages()` and `seats()` are the pull side; the stream
is the push side — nothing a listener can learn that the pulls cannot, only
sooner.

`readSession(name, { repo })` returns the pull side alone — `messages()`,
`seats()`, `subscribe()` — and `Session` extends it, so code that only reads
takes the narrower type and cannot start anything by accident.

One file per concern, and `session.ts` is the room that composes them: the
record in [`record.ts`](../packages/ambion/src/record.ts), who is here in
[`presence.ts`](../packages/ambion/src/presence.ts), a seat and what wakes it
in [`seat.ts`](../packages/ambion/src/seat.ts), the round in
[`exchange.ts`](../packages/ambion/src/exchange.ts), what a person's aide
writes in [`aide.ts`](../packages/ambion/src/aide.ts), and what any of them
reads in [`render.ts`](../packages/ambion/src/render.ts).

Storage is Pi's, not an invention of Ambion's. The record lives in a Pi
session — each message a custom entry, replayed in `seq` order on reopen —
obtained from Pi's own `SessionRepo`, which `startSession` and `readSession`
accept and default to an in-process `InMemorySessionRepo`. A name that outlives the
process is a durable `SessionRepo` implementation, not a new abstraction:
[`index.ts`](../packages/ambion/src/index.ts) re-exports Pi's storage surface
and Ambion adds no storage layer of its own.

---

## 6. What proves it

The milestone tests live in
[`packages/ambion/test/session.test.ts`](../packages/ambion/test/session.test.ts),
one per claim this document makes loudly: parallel activation with mid-turn
steering, and a reply waking the idle room (rules 1–2, 4); working views reset
at idle (rule 2); silence leaves no mark (rule 3); a directed wake reaching a
seat at `named`, and a broadcast never reaching one (rules 1, 4, 6); a
racing say refused with what it missed — retry commits, standing down leaves
no mark (rule 5); provenance stamped and the roster injected (rule 7); the
name opening back into its record; events in order, errors as events, abort
quieting the room — including an abort with a steer still queued. The exchange
is proved beside the aide that first reads one, in
[`aide.test.ts`](../packages/ambion/test/aide.test.ts): a question opens a
round and quiescence closes it, holding the range it covered; an arrival opens
none and a second message into an open one changes nothing; and a round closes
before anything is written about it. All
in-process, in vitest, on a scripted stream where determinism matters. What a
person entering and leaving adds to these rules is proved beside them, in
[`presence.test.ts`](../packages/ambion/test/presence.test.ts), and what the
aide a person brings adds is proved in
[`aide.test.ts`](../packages/ambion/test/aide.test.ts).

The runnable proof is [`examples/site`](../examples/site): a construction
management suite where each product is an agent — a time tracker, a task list
seated `attentive` so it meets people at the door, and a materials tracker —
shared by three people who come and go, each bringing an aide of their own.
Every rule above is observable by hand there, and the products hold state they
change.

---

## 7. A gap the core has

**An exchange has no end the room enforces.** Two agents that keep answering
each other keep waking each other, and nothing stops them. The say lock pushes
against it — a seat that speaks late is refused and told to reconsider, and
rule 3 tells it to stand down — but that is pressure, not a bound. No run has
hit it. It is written down because a room that waits for months will meet it
eventually, and because anything built on quiescence assumes it does not
happen. [`aide.md`](aide.md) is built on it: an aide writes when the room goes
quiet, so a room that never goes quiet never gets its one message.

The fix belongs here, in the core, not in whatever notices the absence: a
limit on how much work one message may cause, applied where rule 1 activates
a seat.

---

## 8. Later

Each of these is designed to sit on top of this core without changing it:
the virtual shell and workspace filesystem (just-bash behind Pi's
`ExecutionEnv`); channels, with their read/write contracts, batching, timers
and routing; durable sessions that survive teardown; per-seat compaction of
long records; the workspace and the tenant; tasks. They arrive one document
at a time, each earning its way in against the same test: does it add a
second way to do something that has one?

Two of them are built. [`presence.md`](presence.md) takes people out of the
room's composition and gives them a verb of their own. A run seats agents; a
person visits and leaves, several at once, and arriving is a message like any
other — so rule 1 activates the room when somebody walks in, and an agent that
knows the session's goal tells them what they missed.

[`aide.md`](aide.md) is the second, and it hangs on the quiet at the end of a
round rather than on an activation. A person may bring an aide; when an
exchange closes and the agents said more than one thing into it, that aide
writes the one message its person reads, and from the next activation the
seats read it in place of the range. It adds one optional field, one kind of
message and no verb, and it breaks no rule above: rule 5's lock refuses a
summary exactly as it refuses a say, and rule 1 never activates a seat because
an aide wrote something.

Both reach into this core rather than sitting on top of it, and the shapes
above carry the result.

---

## 9. The measure

Ambion ships a multi-agent runtime and writes no agent loop: two definition
helpers, a facade, and a room. If that ratio ever inverts — if Ambion finds
itself owning retries or context windows or a tool format — the wrapper has
become a reimplementation, and the right response is to delete Ambion's
version.

Four things to define. One dependency that does the rest.
