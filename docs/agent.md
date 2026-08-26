# The Agent

This document specifies Ambion's core. It is a design contract, not a
description of shipped code: nothing below exists yet in `packages/ambion`.

Four primitives, and the whole of it fits in one sentence:

> **`defineAgent` makes an agent, `defineHuman` seats a person, `defineTool`
> gives agents hands, and `openSession` opens a named room where all of them
> meet — each agent deciding for itself whether to speak, to whom, and which
> colleague to call in.**

Everything Ambion intends beyond this — the virtual shell and workspace
filesystem, channels and their read/write contracts, timers, batching,
routing, the tenant — is deliberately out of scope for now, and will arrive
as its own documents. This one is the buildable core.

---

## 1. Nothing new under the loop

An agent needs a model, a tool-calling loop, streaming, cancellation, retries,
context compaction, and a durable transcript. All of it is solved work, and
the [Pi SDK](https://pi.dev/docs/latest/sdk) solves it well
(`@earendil-works/pi-agent-core` — the headless loop, without the terminal).
Ambion writes none of it.

| Concern                                   | Owner      |
| ----------------------------------------- | ---------- |
| Model catalog, routing, fallback          | Pi         |
| Tool-call loop, parallel calls, abort     | Pi         |
| Streaming events, retries, compaction     | Pi         |
| Steering a running turn                   | Pi         |
| Transcript storage, in-memory and durable | Pi         |
| Tool definition format                    | Pi         |
| **Participants as values**                | **Ambion** |
| **The session as a room**                 | **Ambion** |

Two things. If a third appears, it is a design failure and should be pushed
back into a dependency or dropped.

Inspection of the shipped package (v0.84) confirms the seams: the main entry
carries zero Node built-ins (the Node adapter lives behind a separate `./node`
export), `AgentHarness` takes `session`, `tools`, `toolContext` and
`systemPrompt` as plain options with `steer` and `followUp` as queue verbs,
and `SessionStorage` is an interface with `InMemorySessionStorage` shipped
beside it.

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
on the record. `identity` is the agent's public face — one or two sentences
the whole room reads, injected into every participant's context as part of
the roster. `instructions` are the private half: the agent's own voice,
appended to the Ambion system prompt, never replacing it, and the home of all
judgment — including the judgment to say nothing. `model` is a Pi model
identifier. `defineAgent` returns a value; everything that refers to an agent
refers to this value, not to a string.

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

`defineTool` is a facade over Pi's, not a format of Ambion's own: the same
name-description-parameters-execute shape, re-exported so that an Ambion
project imports one package, with one convenience — `execute` returns a
string (or Pi's full content shape when needed) and receives parsed
parameters first. A tool defined with Pi's `defineTool` works unchanged;
learning Pi's is still learning Ambion's. Tools are the agent's only hands in
this cut: what an agent can do beyond speaking is exactly what its author
gave it.

---

## 4. defineHuman

```ts
import { defineHuman } from '@ambionframework/ambion';

export const andrei = defineHuman({
  name: 'andrei',
  identity: 'Founder. Owns the weekly. Bring him blockers, not status.',
});
```

A human is a participant, not an operator: seated in a session like an agent,
part of the roster like an agent, on the record like an agent. `identity` is
how the room knows them — agents read it and address them accordingly. A
session can seat several humans.

What a human never has: instructions, tools, or a model — humans are not run.
A `say` directed at one wakes nothing; it addresses the reader. What a human
handle is for: delivering. The host proxies the people it has authenticated
by delivering with their handle as `from`, and the runtime stamps the record
from the handle — so who-said-what on the record is never something the
content claimed, for humans and agents alike.

---

## 5. openSession

```ts
import { openSession, passive } from '@ambionframework/ambion';

const session = openSession({
  name: 'weekly',
  participants: [andrei, researcher, writer, passive(archivist)],
});

const unsubscribe = session.subscribe((event) => {
  if (event.type === 'say_update') process.stdout.write(event.delta);
});

await session.deliver({ from: andrei, text: 'Draft the weekly. Anything to flag?' });
await session.settled();

for (const message of await session.messages()) {
  console.log(`${message.from}: ${message.text}`);
}
```

A session is a named entity, and the verb is honest about it: `openSession`
opens, it does not create. Open a name that has never been opened and the
room is empty; open it again and you are back in it, record intact — like a
file, not like an object. Two rules of identity follow. **The record belongs
to the name**: what was said in `'weekly'` is there whenever `'weekly'` is
opened, for as long as the storage lives. **The seats belong to the
opening**: the participants passed to `openSession` are who is in the room
this time, so a session can be reopened with a different roster and the
record still shows exactly who said what, stamped then, not inferred now.
Names are unique across the roster — human or agent, one name names one
participant, and `openSession` refuses a duplicate rather than letting
`say({ to })` become ambiguous.

What the record holds is one shape:

```ts
interface Message {
  from: string; // a participant's name — stamped by the runtime, never claimed
  to?: string; // present when the delivery or say was directed
  text: string;
  at: string; // stamped by the runtime, at the moment it landed
}
```

Beyond identity, the mechanics are seven rules:

**1. A delivery activates every idle agent, in parallel.** Passive seats sit
out (rule 5); everyone else evaluates at once, and replies land on the record
in arrival order. With one agent this degenerates to ordinary chat: the room
is the general case, the assistant its size-one instance.

A delivery may also be directed: `deliver({ from, to, text })` activates
exactly the named participant, waking it idle or passive — the same addressing
`say` gives agents (rule 4), at the host's door, and the way a human reaches
the expert in the corner. `to` is a participant handle, typed like everything
else at this door; directed at a human it is an address for the reader and
wakes nothing.

**2. Whatever arrives mid-turn is steered in — and working views reset at
idle.** Replies and deliveries alike: as each one arrives it is injected into
any active agent's running turn at the next safe point, typically beside the
next tool result, so nobody finishes blind and answers stale. A delivery thus
does both at once — it wakes the idle and steers the active — and "round" is
deliberately a soft-edged word: the room has no barrier, only quiet, and
quiet is what `settled` reports. Mid-flight, each agent may therefore
see the conversation in a slightly different order than the record: its
working view is its own. That view is scaffolding, not state — when the agent
goes idle it is discarded, and the next activation reads the record itself,
projected to its seat. The record is canonical; working views are ephemeral.

**3. Speaking is a tool; silence is the default.** An activated agent holds
one built-in tool:

```ts
say({ to?: string; text: string });
```

Ending a turn without calling `say` is declining — it leaves no mark on the
record, the way a colleague reads the room and keeps working. The judgment
lives in `instructions`; the runtime never decides for the agent. Glances are
still billed — a room of three costs three looks per delivery — which is the
honest price of a room, stated rather than hidden.

**4. A directed `say` is the deliberate act.** An undirected `say` speaks to
the room: it steers colleagues still at work and wakes no one who has gone
idle — so agents cannot ping-pong by accident. `say({ to: 'writer' })` speaks
_and_ wakes the named colleague, idle or passive; every escalation is
explicit, on the record, and paid for on purpose. Directed at a human, it
addresses the reader and wakes nothing, since humans are not run.

**5. An agent's status is `active`, `idle`, or `passive`.** Active: taking a
turn now. Idle: at rest, woken by any delivery. Passive: at rest, woken only
when named — by a colleague's directed `say` or a directed delivery — seated
as `passive(archivist)`, and readable, like all statuses, from
`session.seats()`. A passive seat is the expert in the corner: hearing
nothing, costing nothing, until someone asks.

**6. Identity is injected; provenance is stamped.** Every agent's context
carries the roster — each participant's name, kind, identity and status — so
the room always knows who is in it and how to address them. On the record,
`from` is written by the runtime from the seated handle: the host delivers as
a defined human, `say` is stamped with its agent, and only participants
speak. No one self-reports who they are.

**7. The room hears what you said, not your keystrokes — and the keystrokes
are kept.** Each agent's tool calls belong to its own working context; other
participants see its `say`s only. Pi's context projection hooks
(`entryProjectors`, `toProviderMessages`) carry this, so a shared room costs a
projection rule, not a second storage shape. The same line settles compaction:
Pi compacts working context, and working context is the per-seat projection —
one agent's context pressure compacts its own view of the room, and the record
is never rewritten for anyone. The hands are auditable after the fact, not
only live: every activation's full turns land in the seat's own downstream Pi
session — `<room>:<agent>`, parented to the room's session, named by
`seats()`, listed by the same repo — so what an agent actually did can be
replayed long after its working view reset.

### Observing the room

The session's observation surface is Pi's `Agent` API lifted one level: the
same `subscribe(listener)` returning an unsubscribe function, the same event
grammar, with one addition a room needs and a single agent does not — every
event names its seat.

```ts
type SessionEvent =
  | { type: 'delivery'; message: Message }
  | { type: 'agent_start'; agent: string }
  | { type: 'say_start'; agent: string; to?: string }
  | { type: 'say_update'; agent: string; delta: string }
  | { type: 'say_end'; agent: string; message: Message }
  | { type: 'tool_execution_start'; agent: string; toolName: string }
  | { type: 'tool_execution_end'; agent: string; toolName: string }
  | { type: 'agent_end'; agent: string; spoke: boolean }
  | { type: 'error'; agent: string; error: Error }
  | { type: 'settled' };
```

The mapping is deliberate, so anyone who knows Pi already knows this: Pi's
`agent_start`/`agent_end` are these, attributed; Pi's
`message_start`/`message_update`/`message_end` surface here as
`say_start`/`say_update`/`say_end`, streaming deltas and all, emitted only
for `say` output; Pi's `tool_execution_*` pass through with the seat named.
Three events are the room's own: `delivery`, `settled` — the moment no agent
is active and nothing is queued — and `error`, which is how a failed turn is
distinguished from a quiet one. **Silence is a decision; an error is an
event.** A crashed tool or a refused model call never masquerades as
declining: it reaches the host on the stream, and leaves no mark on the
record.

One distinction keeps rule 7 honest: the event stream is the host's
instrument panel, not a seat at the table. Participants' contexts never see
each other's tool executions; the stream sees everything, because the host
operating the room is the tenant's own code, and debugging a room means
watching hands as well as hearing voices.

Two completion signals, for the two things a host waits on. `deliver()`
resolves on acceptance — the message is on the record and activations are
dispatched — never on completion, because a parallel round has no single
caller to return to. The round's end is `settled()`: a promise that resolves
when the room is quiet, which is also the moment a host learns that nobody
chose to speak.

And one control: `abort()`. It cancels every active turn — Pi's own abort,
fanned out — and the room settles. What was already said stays on the record;
what was mid-flight ends without speaking, and the stream shows each seat's
`agent_end`. Steering is for changing an agent's mind; `abort` is for when
there is no time to. `messages()` and `seats()` are the pull side — the record and
the roster with statuses — and the stream is the push side; there is nothing
a listener can learn that the pulls cannot, only sooner.

Storage is Pi's, not an invention of Ambion's. The record lives in a Pi
session — each message a custom entry — obtained from Pi's own `SessionRepo`,
which `openSession` accepts and defaults to Pi's `InMemorySessionRepo`, so
names live as long as the process. A name that outlives the process is a
durable `SessionRepo` implementation, not a new abstraction: Ambion re-exports
Pi's storage surface and adds no storage layer of its own.

---

## 6. The milestone

**What lands.** The four primitives, one example under `examples/` driven by
the CI smoke test, and nothing else — an abstraction nobody can run is a
proposal.

**What proves it.** Seven tests, one per claim this document makes loudly:

- a delivery activates the idle agents in parallel, and a reply arriving
  while a colleague still works is steered into that colleague's turn — while
  an agent already idle is not re-activated by it (rules 1–2, 4);
- after going idle, an agent's next activation reads the record, not its
  previous turn's working view (rule 2);
- an agent that does not call `say` leaves no mark on the record (rule 3);
- a directed `say` or directed delivery wakes exactly its target, passive
  included; a broadcast never wakes a passive seat (rules 1, 4–5);
- `from` is what the runtime stamped from the seated handle, regardless of
  what the content claimed, and each agent's context carries the roster with
  identities (rule 6);
- opening the same name twice yields the same record, and a fresh name yields
  an empty one;
- a subscriber sees `delivery`, `agent_start`, `say` deltas, `agent_end` and
  `settled` in order; a turn that throws emits `error` — never a silent
  decline — and `abort()` quiets an active room, keeping what was already
  said (§5, Observing the room).

All in-process, in vitest, with a scripted model where determinism matters
and a real one where it does not.

---

## 7. Later

Each of these is designed to sit on top of this core without changing it:
the virtual shell and workspace filesystem (just-bash behind Pi's
`ExecutionEnv`); channels, with their read/write contracts, batching, timers
and routing; durable sessions that survive teardown; the workspace and the
tenant; tasks. They arrive one document at a time, in that rough order, each
earning its way in against the same test: does it add a second way to do
something that has one?

---

## 8. The measure

Ambion ships a multi-agent runtime and writes no agent loop: two definition
helpers, a facade, and a room. If that ratio ever inverts — if Ambion finds
itself owning retries or context windows or a tool format — the wrapper has
become a reimplementation, and the right response is to delete Ambion's
version.

Four primitives. One dependency that does the rest.
