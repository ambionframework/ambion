# Presence

This document is a proposal. Nothing in it is built. The runtime today
seats a human with `openSession`, alongside the agents, and keeps them
seated for the life of the opening.

It answers one question the core leaves open. A session is persistent and
ambient: agents wait in it, and a delivery activates them. A person opens
the same session to read what happened and to steer what happens next.
Those are not the same act, they do not have the same lifetime, and the
runtime cannot tell them apart.

> **`openSession` opens a room of agents. `enter` puts a person in it.**
> Agents belong to the session. People visit it.

Several people can visit one room at once. Each attaches on their own, acts
on their own, and stops paying attention on their own.

Presence adds no store and no second kind of thing. **Arriving is a
message.** You walk into a meeting without saying a word, and the room knows
something it did not know before — who is here, how long they were gone,
what they have not heard. Everything else in this document is read back out
of the record that message lands on.

---

## 1. The distinction

The core has one list, and it holds two kinds of thing:

```ts
const session = openSession({
  name: 'initiative',
  participants: [andrei, lead, designer, passive(planner)],
});
await session.deliver({ from: andrei, text: 'Draft the weekly.' });
```

`andrei` and `lead` sit in the same array, and the array is wrong about
both of them. Three failures follow.

**The two have different lifetimes.** An agent belongs to the room. It is
the room's composition, it is the same on every opening, and it waits there
between activations — this is the whole thesis of an ambient runtime. A
person is not composition. They arrive, read, steer, and go. Putting the
two in one list says they are the same kind of member, and every question
after that gets harder: is a person who is asleep still in the room? Does
reopening the session bring them back?

**The roster lies.** An agent reads `andrei (human)` in its context and
reasonably directs a `say` at him. Nobody reads it for six hours. The agent
had no way to know, because the value proves nothing about attention. It is
a definition, not a person.

**Arrival is invisible.** Andrei opens the room after three days away. The
record does not move, no agent looks, and nothing tells the planner that the
person who owns the headcount decision is finally reading. In a meeting that
is the most informative thing that happens all hour.

The proposal takes people out of `openSession`, gives them a verb, and makes
what the verb does a message.

---

## 2. openSession: agents and a goal

```ts
const session = openSession({
  name: 'initiative',
  goal: `
    Ship payments v2 this quarter. Decide scope, sequence the work, and keep
    the plan of record current.
  `,
  agents: [lead, designer, product, passive(planner)],
});
```

`participants` becomes `agents`, because that is what the field now holds.
The type stays a union of the two ways to seat an agent:

```ts
export type AgentSeat = AgentDefinition | PassiveSeat;
```

`Participant` survives as a narrower thing — who may be addressed by name:

```ts
export type Participant = AgentDefinition | HumanDefinition;
```

`goal` is new, and §9 is why. An agent knows its own instructions and it
knows the roster. It does not know what the room is for. Without that, an
arrival is a fact an agent cannot judge: it can see that Andrei is here and
has no way to decide whether that matters. `goal` is to a session what
`identity` is to an agent — one or two sentences, public, in every
participant's context.

`goal` is optional, and what it gates is deliberate: **a room with no goal
does not ask its agents to judge arrivals.** §9's paragraph about who to
speak to when somebody walks in renders only when a goal is set. Presence
still lands on the record and still shows in the roster, and the agents
still read it — they are simply not told to act on it, because without a
purpose there is nothing to weigh the arrival against. That is honest
degradation rather than a feature that appears to work and judges badly.

Everything else about `openSession` is unchanged — the identity rules, the
duplicate-name refusal, `streamFn`, `repo`, the storage — all of it holds as
`docs/agent.md` states it. The goal belongs to the opening, as the seats do:
reopen the name with a different goal and the record is intact under a new
purpose.

The room runs whether or not anybody is watching. This is the normal case,
not the edge case: agents wait, a colleague's directed `say` wakes another
colleague, and the record fills up with nobody reading it.

---

## 3. Entering

```ts
const visit = await session.enter(andrei, { idleTimeout: 15 * 60_000 });

await visit.deliver({ text: 'Draft the weekly. Anything to flag?' });
await visit.deliver({ to: lead, text: 'What does this cost us in engineers?' });

visit.acted(); // the host reports a keystroke, a scroll, a click
await visit.leave();
```

`deliver` moves from the session to the visit. That is the point of the
change, not a side effect of it. **You cannot speak into a room you have
not entered.** Provenance stops being a check the runtime performs on a
handle it was passed and becomes a property of the handle the host holds. A
host that wants to deliver as Andrei must hold a live visit for Andrei, and
the visit ends when Andrei leaves.

Reading stays on the session. `messages()`, `seats()` and `subscribe()`
answer whether or not anybody is present, because a host renders an
unattended room the same way it renders one with three people in it.
Reviewing is not acting, and a dashboard is not a visitor.

Anybody may enter. There is no guest list, because there is no longer a
place to put one — and the room does not need it. The host authenticates
the person and vouches for the name and identity it passes; Ambion never
sees a credential and adds no user store. The name is the person, and it is
the name a returning visitor is matched on, so a host that gives two people
one name gives them one seat and one history. `enter` refuses exactly one
thing: a name an agent already holds, because the room addresses
participants by name and two claimants make `say({ to })` ambiguous.

---

## 4. The visit

One person, many visits. One visit, one attachment.

A person who opens the room in a terminal and in a browser has two visits.
They are one person with one name on the record. This is the whole of the
multi-attachment answer: the runtime counts visits and derives the person's
status from them, so closing one tab does not make somebody absent who is
still reading in the other.

```ts
export interface EnterOptions {
  /** Milliseconds without an act, after which the visit turns away.
   *  Defaults to fifteen minutes. `Infinity` means never. */
  idleTimeout?: number;
  /** A label the host chooses — 'terminal', 'web', a device id. The runtime stores
   *  it and gives it back. It changes nothing. */
  via?: string;
}

export interface Visit {
  readonly human: HumanDefinition;
  /** This attachment, not this person. Opaque, stable, unique in the session. */
  readonly id: string;
  readonly status: VisitStatus;
  /** A live read, not a snapshot: the seq of this person's most recent
   *  `away` or `left` message, or `undefined` when the record holds none.
   *  It moves when they stop reading and holds while they read. See §8. */
  readonly since: Seq | undefined;
  deliver(input: { to?: Participant; text: string }): Promise<void>;
  /** The host reports that the person acted. Returns an away visit to present. */
  acted(): void;
  /** Idempotent: a host that closes a socket twice is not an error. */
  leave(): Promise<void>;
}
```

`acted()` names the fact the host reports, not a command to the runtime. It
replaces `touch()`, which is a metaphor. It stays synchronous even when it
returns somebody from away and commits a `returned` message: the message
takes its seq in the same tick and persists on the same write chain as every
other entry, which is what `commit` already does for a say.

The id is `<name>#<n>` — `andrei#1`, `andrei#2` — counted per session. It is
readable in a log and deterministic in a test. Treat it as opaque.

`deliver` and `acted()` on a visit that left throw. A handle to a finished
visit is a stale handle, and the runtime says so rather than accepting a
message from a person who is gone.

Two visits by one name are the same person. A second `enter` with the same
name and the same identity attaches another visit to that person. A second
`enter` with the same name and a different identity is refused: one name is
one identity for the life of the opening, and the alternative is a roster
that changes under the agents reading it.

---

## 5. Arriving is a message

A person arriving is a thing that happened in the room, caused by a person,
that the other participants would want to know. That is what a message is.
So it is one, and the record keeps one kind of entry:

```ts
/** Monotonic, assigned when the message commits, strictly ordered, never reused. */
export type Seq = number;

interface Spoken {
  kind: 'said';
  seq: Seq;
  at: string; // ISO, stamped by the runtime at the moment it landed
  from: string; // a participant's name — stamped by the runtime, never claimed
  to?: string; // present when the delivery or say was directed
  text: string;
}

interface Presence {
  kind: 'arrived' | 'away' | 'returned' | 'left';
  seq: Seq;
  at: string;
  from: string;
}

export type Message = Spoken | Presence;
```

Every rule of the core applies to a presence message unchanged, and that is
the whole argument for this shape.

**Rule 1 holds exactly.** There is still one activation mechanism: a message
delivered into a session activates every idle agent. Arriving delivers a
message. Nothing is special-cased, and nothing had to be weakened to let a
door count.

**Rule 5 holds exactly.** A `say` commits only against a record its seat has
heard in full, and an arrival is part of that record. An agent composing a
reply when Andrei walks in has its say refused and is told what it missed —
which is correct, because it should reconsider now that he is here. It costs
a retry, the same retry two racing says already cost. It also solves the
obvious failure of this design: five agents that all wake to greet the
arrival cannot all speak. The first commits and the rest are told the room
moved, which is precisely when rule 3 tells them to stand down.

**Rule 7 holds, and gets stronger.** `from` is stamped by the runtime from
the live visit. A presence message is the one entry on the record the
runtime observed itself rather than took somebody's word for.

**Provenance without content.** A presence message has no `text`, because the
person said nothing. Writing one with text like `"(entered the room)"` would
put words in their mouth under their name, which rule 7 exists to prevent.

Two of the four kinds come from a deliberate act and two from a clock.
`arrived` and `left` follow `enter()` and `leave()`. `away` follows a timer
and `returned` follows `acted()`. All four activate, and §7 states what that
costs and how to not pay it.

The seq counts from 1, is monotonic, is assigned when the message commits,
and is strictly ordered. A cursor is exclusive: `since` names a message the
reader has, and the read starts after it. The core already needs this and
approximates it with `record.length`; naming it is what lets a cursor
survive. It is not Pi's storage seq — that stays Pi's, and `openStore` keeps
sorting replayed entries by it.

Records written before this change carry neither field. `openStore` reads a
missing `kind` as `'said'` and assigns a missing `seq` from replay order,
which is the order those messages already had.

---

## 6. Presence

A visit has two states. A person has three.

```ts
export type VisitStatus = 'present' | 'away';
export type PresenceStatus = VisitStatus | 'absent';
```

- **present** — they acted within the timeout. They are reading.
- **away** — they are attached and have not acted for longer than the
  timeout. They read this later.
- **absent** — the record has seen them and they hold no live visit. They
  are not in the room.

A person's presence derives from their visits, and the rule is one
sentence:

> Somebody is **present** if any of their visits is present, **away** if
> they have visits and all of them are away, and **absent** if they have
> none.

That rule is what "tracked correctly" means. A presence message marks a
change of status, so four of these seven cases write nothing at all:

1. A second visit opens while the person is present — no message, because
   their status did not change. Only the first `enter` of a stretch writes
   `arrived`.
2. Two visits, one leaves — the person stays present, and again nothing.
3. The last visit leaves — the person turns absent and `left` commits.
4. One visit turns away, another is present — the person stays present, and
   again nothing.
5. Every visit turns away — the person turns away and `away` commits.
6. An away visit delivers — that visit returns to present, so does the
   person, and `returned` commits before the delivery it came with.
   Delivering is acting.
7. A person who left is still addressable. A `say` directed at them lands on
   the record and waits; they read it when they come back.

Case 7 needs the room to know the name, and the record is where it knows it
from. **A room learns every name in its record, and a record does not
forget.** An agent that reads `andrei (present)` and calls
`say({ to: 'andrei' })` two seconds after Andrei closed his laptop still
lands the message. So does an agent in a session reopened next week, because
replaying the record replays the arrivals.

Presence itself is live — it is a fact about attachments, and attachments
die with the process. What survives is the record of how it changed, and
that is enough to rebuild everything this document needs: who has ever been
here, who was here last, when, and where each of them stopped reading.

---

## 7. The inactivity timeout

`idleTimeout` is milliseconds without an act, and it **defaults to fifteen
minutes**. `enter` takes it per visit, because the host knows the medium — a
terminal, a tab, a webhook — and one room can hold all three. `openSession`
takes it too, as the house default for the visits that do not set their own.

`Infinity` turns it off: the visit stays present until it leaves, and no
`away` or `returned` message is ever written for it. It needs no special
case in the rule below — `now - lastActedAt < Infinity` is always true — and
exactly one in the timer, which is armed only for a finite timeout.

Two acts reset it: `deliver` and `acted()`. Reading does not. A host that
polls `messages()` every second is not a person paying attention, and the
runtime cannot tell the two apart from the inside. **Attention is claimed,
not inferred.** `acted()` is the seam through which the host — which knows
what a real keystroke is — makes the claim.

The mechanism is a pure function and a timer, in that order:

```
status(visit, now) = now - visit.lastActedAt < visit.idleTimeout ? 'present' : 'away'
```

`seats()` and `visits()` compute it on read. The timer only makes the change
observable on time, and makes the message land when it happened: one timer
per present visit, armed at `enter`, cleared and armed again on each act,
cleared when the visit turns away or leaves. An away visit holds no timer.
The timer is `unref`'d, so a room full of idle people never keeps Node alive.

Deriving the status rather than storing it is what keeps the answer right
when the timer is wrong. A suspended laptop fires its timers late. `seats()`
still reports away, because it subtracts two numbers.

### What presence costs

Every presence message wakes every idle agent, because it is a message. The
core prices this honestly for what is said and this document prices it the
same way: a room of three costs three looks when somebody arrives. Most of
those looks produce silence, and silence is still billed.

Because `idleTimeout` has a default, **a room pays for presence unless it
opts out**. This is the deliberate choice and it is worth stating without
softening: call `enter` and do nothing else, and four kinds of message can
wake every idle seat.

One thing bounds it and two turn it off. **Away fires at most once per
stretch of attention**, because an away visit holds no timer — a person in
and out all day writes a few messages, not one per tick. **`Infinity`**
removes the two clock-driven kinds entirely, leaving only the arrivals and
departures a person causes deliberately. And **`passive`** removes the
glance rather than the message: a passive seat hears no broadcast, so it
hears no arrival either, until somebody names it, while the record keeps
everything.

One combination is worth avoiding, and it is the one a host falls into by
doing nothing. A room with no `goal` still activates on all four kinds, and
its agents are not told what to do with an arrival (§2) — so it pays the
full price of presence for judgement it never asked for. A room without a
goal should pass `idleTimeout: Infinity`, or state a goal.

The timeout does not touch `settled()`. `settled()` reports that no agent is
active. Whether anybody is watching is a different fact.

---

## 8. Catch-up

The record already holds when each person stopped reading, in strict order
with everything else. The cursor a catch-up needs is not a number kept
somewhere; it is a message.

```ts
const visit = await session.enter(andrei);
const missed = await session.messages({ since: visit.since });
```

`visit.since` is the seq of this person's most recent `away` or `left`
message. `messages({ since })` returns everything after it. `since` is
`undefined` when the record holds neither — they have not been here
before — and the host says welcome and shows the tail instead of "you missed
four thousand messages".

**The anchor is where they stopped reading, not where they left.** Away and
absent are one fact here: nobody is looking. A person whose visit turns away
at 14:00 and acts again at 16:00 gets the two hours they missed, exactly
like a person who closed the tab and came back.

**The anchor holds while they read.** `since` is a live read of the record,
so it moves the moment an `away` or `left` message lands and then holds until
the next one. It does not move when they act, when a message lands, or when
a second visit opens. The divider a host draws in the transcript stays where
it was drawn for the whole stretch of attention.

Three things this buys that a bookmark kept beside the record did not:

**Ordering is exact.** An anchor and the messages past it are the same kind
of thing in one sequence on one commit path. There is no window in which a
message lands between a person going away and a mark being written, because
there is no second write.

**Durability is free.** The record persists through Pi's `SessionRepo`
already, and `openStore` already replays it. Nothing new is stored, so
nothing new can be lost, and `JsonlSessionRepo` makes this real today.

**What you missed includes who was here.** Arrivals and departures come back
interleaved with what was said, because they are the same record. A person
reads that the room went quiet at 15:00 because everybody left.

One failure stays, and it fails in the safe direction. If the process dies
while somebody is present, no `left` is written, because nothing observed
them leaving. On reopen their anchor is their previous `away` or `left`, so
they are shown more than they missed rather than less.

What catch-up does not cover is what the agents did. The record holds what
was said and who was here. The turns and tool calls in between are in each
seat's own downstream session, where rule 8 of the core puts them.

---

## 9. What agents see

An arrival is only worth waking for if an agent can judge it, and judging it
takes three things the core does not currently give: what the room is for,
what time it is, and how long this person has been gone. With those, the
context an agent reads on Andrei's arrival is enough to act on:

```
The session 'initiative' exists to: Ship payments v2 this quarter. Decide
scope, sequence the work, and keep the plan of record current.

The time is 2026-08-27 16:04 UTC.

The agents (active: taking a turn now; idle: hears every message; passive:
hears only a say directed at them):
- lead (idle): Tech lead. Owns feasibility, estimates, and sequencing.
- designer (idle): Product designer. Guards the user experience.
- planner (passive): Project manager. Keeps the plan of record.

The people (present: reading now; away: here, not reading; absent: gone):
- andrei (present, arrived just now, last here 3 days ago): Founder. Owns
  the weekly. Bring him blockers, not status.
- mara (absent, last here 20 minutes ago): Design lead.

The record so far:
[andrei] Draft the weekly. Anything to flag?              3 days ago
[lead → andrei] Two engineers for three weeks, assuming
                the migration holds.                      3 days ago
· andrei left                                             3 days ago
[exec] Approved two more engineers for the quarter.       1 day ago
[designer] Cutting that flow costs a step nobody counted. 4 hours ago
· andrei arrived                                          just now

Take your turn, planner: say something, or end your turn to stay silent.
```

Three additions, each pulling its weight. **The goal** comes from
`openSession` and tells an agent what the room is trying to do, which is what
makes "does this arrival matter" answerable at all. **The time**, absolute at
the top and relative on each line, is what a persistent ambient room has
always needed and never had: without it an agent cannot tell a three-day gap
from a three-minute one. **The gap** — `last here 3 days ago` — is derived
from the record, not stored, because the arrivals are on it.

The system prompt gains one paragraph, and most of it is about not speaking.
It renders only when the session has a goal (§2) — an agent with nothing to
weigh an arrival against is not asked to weigh one:

> An arrival is a message like any other and the bar for speaking is the
> same. Most arrivals need nothing said. Speak to somebody who has just
> arrived when the record holds something that is theirs to decide, or when
> what changed while they were away changes what they do next — say what
> changed and what you need from them, in one message. Do not greet, do not
> say that you noticed them, and do not summarise the room to somebody who
> was here for all of it. When nobody is in the room, work for the record:
> state what you decided and why, and do not wait for an answer that nobody
> is there to give.

The planner reading the context above has something worth saying: Andrei owns
the headcount call, the exec approved two engineers a day after he left, and
he has not seen it. That is the behaviour this document is for — you walk
into the room and somebody tells you the one thing you missed.

Presence enters an agent's context at activation, with the rest of the
record. This is rule 2 of the core, unchanged: working views reset at idle.

---

## 10. What does not change

Four things stay exactly as they are, and each one is a decision.

**Activation.** One mechanism, unweakened: a message delivered into a session
activates every idle agent. Arriving is delivering a message.

**Routing.** `dispatch` is unchanged. A presence message routes like any
broadcast — passive seats sit out, everyone else at rest evaluates. A `say`
directed at a person still wakes nothing; it is an address for a reader.

**Provenance.** `from` is stamped by the runtime and never claimed, and a
presence message is stamped from a visit the runtime observed.

**Storage.** Nothing is added. The record is one Pi session's custom entries,
as it is today, of the one `customType` it already uses.

---

## 11. Observing presence

`messages()` keeps its name, because the record still holds messages. An
earlier draft renamed it `record()`, on the reasoning that a method called
`messages` should not return things nobody said. Making an arrival a message
removes the problem the rename was solving.

```ts
session.messages(options?: { since?: Seq }): Promise<Message[]>;
session.visits(): VisitInfo[];
```

The stream keeps attachment granularity, which the record deliberately does
not carry:

```ts
type SessionEvent =
  | /* … the nine events of the core, unchanged … */
  | { type: 'visit_enter';  human: string; visit: string; presence: PresenceStatus }
  | { type: 'visit_away';   human: string; visit: string; presence: PresenceStatus }
  | { type: 'visit_return'; human: string; visit: string; presence: PresenceStatus }
  | { type: 'visit_leave';  human: string; visit: string; presence: PresenceStatus };
```

The four `visit_*` events fire on every attachment change and name the
person's status afterwards. A presence message that reaches the record
arrives on the existing `delivery` event, because that is what it is. When
Andrei's first tab goes idle and his second is live, `visit_away` fires with
`presence: 'present'` and no delivery follows, because Andrei is still
reading.

This is the core's own distinction, held: the event stream is the host's
instrument panel, and the record is what participants read.

```ts
export interface VisitInfo {
  id: string;
  human: string;
  status: VisitStatus;
  via?: string;
  enteredAt: string; // ISO, stamped by the runtime
  lastActedAt: string; // ISO, stamped by the runtime
  since: Seq | undefined;
}
```

`seats()` answers who is in the room, and `SeatInfo` becomes a discriminated
union, because an agent seat and a person no longer carry the same fields:

```ts
export type SeatInfo =
  | { kind: 'agent'; name: string; identity: string; status: SeatStatus; sessionId: string }
  | { kind: 'human'; name: string; identity: string; presence: PresenceStatus; visits: number };
```

This breaks `seat.status` for callers that read it without narrowing —
`examples/room` is one, and it is two lines.

---

## 12. What this changes in the contract

`docs/agent.md` is the contract for shipped code, and four parts of it stop
being true when this lands.

**§4, `defineHuman`.** "A human is a participant, not an operator: seated
like an agent, on the roster like an agent, on the record like an agent." On
the record: more true than before — a person now lands on it by arriving.
Seated like an agent: no. A person is not seated by `openSession` at all.

**§5, `openSession`.** The example seats `andrei` in `participants` and calls
`session.deliver`. Both change, and `goal` is added.

**§5, "What the record holds is one shape".** One shape becomes one union.
The four fields of a spoken message are unchanged; `kind` and `seq` are
added, and a presence message carries no `text`.

**§5, rule 7, "Identity is injected."** The context carries two lists, a
goal, and the time. The rule's other half — provenance is stamped, never
self-reported — gets stronger.

Rules 1 through 6 and rule 8 are untouched, and rules 1 and 5 are untouched
precisely because an arrival is a message rather than an exception to one.

---

## 13. The change in the code

Fifteen edits, all in `packages/ambion/src`. The runtime keeps its two
concerns: participants as values, and the session as a room. Presence is part
of the room — who is in it — and it introduces no store, no transport, no
authentication, and no user directory.

| File         | Change                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `define.ts`  | `defineHuman` unchanged; its comment stops calling the value a participant                                    |
| `types.ts`   | `Seq`; `Message` becomes a union of `Spoken` and `Presence`                                                   |
| `types.ts`   | `AgentSeat`; `Participant` narrows to agent-or-human                                                          |
| `types.ts`   | `VisitStatus`, `PresenceStatus`, `VisitInfo`; `SeatInfo` becomes a union                                      |
| `types.ts`   | Four `visit_*` events on `SessionEvent`                                                                       |
| `session.ts` | `participants` becomes `agents`; `goal` is added; `seat()` drops its human branch                             |
| `session.ts` | `commit()` assigns the seq and takes a presence message as well as a spoken one                               |
| `session.ts` | `openStore` replays both kinds, restores the seq counter, and rebuilds the known names                        |
| `session.ts` | `VisitRuntime` per attachment; `Map<string, VisitRuntime[]>` keyed by name                                    |
| `session.ts` | `enter()`, and `Visit` with `deliver`, `acted`, `leave`, and `since` as a getter                              |
| `session.ts` | `deliver` moves off `Session`; the body is reused, `from` comes from the visit                                |
| `session.ts` | `presenceOf()` and `visitStatus()` — pure, both read by `seats()`                                             |
| `session.ts` | One `unref`'d timer per present visit, armed only for a finite timeout; the default is fifteen minutes        |
| `session.ts` | `messages()` takes `{ since }`; `renderContext` renders the goal, the time, relative ages, and presence lines |
| `session.ts` | `systemPrompt` renders the two lists, and the goal and §9's paragraph only when a goal is set                 |
| `index.ts`   | Export the new types, and re-export Pi's `JsonlSessionRepo`                                                   |

`dispatch` and `sayTool` need no change of behaviour, which is the point of
making an arrival a message. `sayTool` keeps one dependency worth naming: its
`to` lookup reads the map of known names, which `openStore` must now fill
from the replayed arrivals rather than from `openSession`. Miss that and a
reopened room refuses every say addressed to somebody who was in it
yesterday.

Hosts migrate in three lines:

```ts
// before
const session = openSession({ name: 'initiative', participants: [andrei, lead, designer] });
await session.deliver({ from: andrei, text: 'Draft the weekly.' });

// after
const session = openSession({ name: 'initiative', goal: '…', agents: [lead, designer] });
const visit = await session.enter(andrei);
await visit.deliver({ text: 'Draft the weekly.' });
```

`session.deliver` is removed rather than deprecated. The core's own test for
a new feature is whether it adds a second way to do something that has one,
and two ways to speak into a room would fail it.

Tests use vitest's fake timers. The clock is not a new option on
`openSession`: the core has one extension point, Pi's `streamFn`, and a
second one would cost more than it buys.

---

## 14. What would prove it

One milestone test per claim this document makes loudly, in the style of
`packages/ambion/test/session.test.ts`:

1. A room of agents alone opens, runs a full exchange, and settles with
   nobody present.
2. `enter` commits an `arrived` message and activates every idle agent, and a
   passive seat sits out.
3. An agent replies to an arrival with a directed say, and the arrival
   carries no `text`.
4. An arrival landing mid-turn refuses the say that turn commits, and the
   failure names the arrival.
5. Two people enter, both deliver, and the record stamps each from their own
   visit.
6. One person, two visits: the second `enter` commits nothing, the first
   visit leaving commits nothing, and the second leaving commits `left`.
7. A visit turns away fifteen minutes after its last act with no
   `idleTimeout` given, and `away` commits at the right seq; with
   `idleTimeout: Infinity` no timer is armed and it never does.
8. One of two visits turns away and nothing commits; both turn away and
   `away` does.
9. An away visit delivers, `returned` commits before the delivery, and both
   route normally.
10. A person leaves, and an agent's directed `say` still lands on the record
    addressed to them.
11. `deliver` and `acted()` on a left visit throw; `leave()` twice does not.
12. `enter` refuses a name an agent holds, and refuses a second identity for
    a name already in the room.
13. `since` is `undefined` on a first visit, and the seq of the `left`
    message on the next one.
14. `since` does not move while a person reads, and moves when they turn
    away — read from the same visit, before and after.
15. `messages({ since })` returns exactly the messages after that seq, spoken
    and presence interleaved in order; `messages()` returns everything.
16. A session is closed and reopened on the same repo: the names come back, a
    returning person's `since` is the seq it was, and seqs continue rather
    than restart.
17. In a reopened session an agent's `say` to a name that only the replayed
    arrivals know is accepted, not refused.
18. The context an agent reads carries the goal, the time, both lists with
    each person's gap, and the presence lines in the transcript.
19. A room with no goal renders neither the goal line nor the arrival
    paragraph, and still commits and routes presence messages normally.

---

## 15. Rejected alternatives

**A notice that is not a message.** A draft of this document put presence on
the record as a second kind of entry that never activated and never steered,
to protect rule 1 from being violated by a door. It cost a rule 5 exception
(a notice must not fail a say), a rendering exception, a second reader
method, and a paragraph explaining why the record held things that were not
messages. Making an arrival a message removes all four, because rule 1 was
never in danger: the rule is that a message activates, and an arrival is a
message. An exception invented to protect a rule is usually a sign the rule
already covered the case.

**A presence store beside the record.** An earlier draft kept presence in a
live map, wrote audit entries for transitions, and kept a separate durable
bookmark of where each name stopped reading. It invented a second store for
facts the record could hold, made ordering approximate because a mark beside
the record races the record, and made durability an argument rather than a
consequence.

**Text on a presence message.** `from: 'andrei', text: '(entered the room)'`
reads well in a transcript and puts words in somebody's mouth under their own
name. Rule 7 exists to stop exactly that. The kind carries the meaning and
the renderer supplies the words.

**One `defineHuman` per connection.** Two tabs would be two people with two
names. The person is one name. The attachment is the thing there can be many
of, and it stays off the record for the same reason.

**Inferring presence from reads.** Treating `messages()` as evidence of
attention. A poller is not a reader, and the runtime cannot tell them apart.
`acted()` puts the claim where the knowledge is.

**A read cursor the host claims.** `visit.seen(seq)`. It answers a question
the runtime cannot check — what somebody read — and makes every host keep a
cursor it must store and migrate. §8 answers the question the runtime can
check, out of a record it keeps anyway.

**A guest list of people at open time.** It buys one thing — addressing
somebody who has never visited — and costs the lifetime distinction this
whole document is about.

**A heartbeat protocol in the runtime.** Sockets, pings and timeouts on the
wire are the host's concern. The runtime takes one call — `acted()` — and
asks nothing about how the host learned it.

---

## 16. Open questions

Four of the five questions this document carried are decided, and each
decision lives in the section it belongs to. **All four presence kinds
activate** (§5), because one rule is worth more than the saving.
**`idleTimeout` defaults to fifteen minutes and `Infinity` turns it off**
(§7), so presence works without being asked for and can be refused in one
argument. **`goal` is optional and gates the arrival paragraph** (§2, §9), so
a room without a purpose degrades honestly instead of judging badly. **A
crash that leaves somebody dangling is accepted as over-delivery** (§8),
because the record holds only what the runtime observed.

One stays open, and it is the one this document cannot answer alone.

**Should a host be able to deliver without a person?** A cron, a webhook or a
scheduled job has nobody to enter as, and after this change there is nothing
but agents at open time. It cannot deliver today either, so nothing
regresses — but an ambient runtime whose whole pitch is rooms that work
unattended will want it, and the answer is probably a third kind of
definition beside `defineAgent` and `defineHuman`, not a hole in `enter`.
That is its own document.

---

## 17. Later

Presence is the fact a workspace needs before it can have channels: a channel
with read/write contracts must know who is reading, and a channel's record
carries the same arrivals this one does.

Two things sit directly on top and are not in here. Notifying somebody an
agent addressed while they were away: the record holds both halves already —
the directed message, and the `away` before it. And catching up across rooms,
one person and many sessions with one answer to "what did I miss", which is a
workspace concern, because it needs something that holds the rooms. Neither
changes the core.
