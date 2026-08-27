# Presence

This document is the design contract for presence: who is in a session, how
the room knows, and what the agents do about it. The code lives with the
rest of the runtime in [`packages/ambion/src`](../packages/ambion/src) — the
visit and the timer in [`session.ts`](../packages/ambion/src/session.ts), the
shapes in [`types.ts`](../packages/ambion/src/types.ts). Read
[`agent.md`](agent.md) first: this document assumes its eight rules and adds
nothing that breaks one.

One sentence:

> **`openSession` opens a room of agents; `enter` puts a person in it; and
> arriving is a message like any other — so the room wakes when somebody
> walks in, and an agent that knows what the session is for can tell them
> what they missed.**

---

## 1. Two lifetimes

An agent belongs to the room. It is the room's composition, it is the same
on every opening, and it waits there between activations — this is the whole
of an ambient runtime. A person is not composition. They arrive, read,
steer, and go, several of them at once, on their own schedules, from a
terminal and a browser at the same time.

`openSession` takes the first and never the second. **Seating is
composition. Entering is presence.** Three things follow, and they are what
presence is for.

**The roster tells the truth.** An agent reads whether each person is
reading right now, so a `say` directed at somebody who is not there is a
note they read later rather than a question that goes unanswered for six
hours.

**The host has a seam.** A person watching one room from a terminal and a
browser holds two visits and one seat. Closing one tab does not make
somebody absent who is still reading in the other, and the host reports each
attachment without inventing a second person.

**Arrival is information.** Somebody walking into a meeting after three days
away is the most informative thing that happens all hour, and they said
nothing. The room treats it the way it treats anything else that happened:
as a message on the record.

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

`agents` holds one kind of thing, in the two ways an agent is seated:

```ts
export type AgentSeat = AgentDefinition | PassiveSeat;
```

`Participant` is the narrower thing — who may be addressed by name:

```ts
export type Participant = AgentDefinition | HumanDefinition;
```

`goal` is what the room is for. An agent knows its own instructions and it
knows the roster; without a goal it does not know what the room is trying to
do, and an arrival is then a fact it cannot judge. `goal` is to a session
what `identity` is to an agent — one or two sentences, public, in every
participant's context.

`goal` is optional, and what it gates is deliberate: **a room with no goal
does not ask its agents to judge arrivals.** §9's paragraph about who to
speak to when somebody walks in renders only when a goal is set. Presence
still lands on the record and still shows in the roster, and the agents
still read it — they are simply not asked to act on it, because without a
purpose there is nothing to weigh an arrival against.

The whole option shape:

```ts
export interface OpenSessionOptions {
  name: string;
  agents: readonly AgentSeat[];
  /** What the room is for. One or two sentences, read by every agent. */
  goal?: string;
  /** The house default for visits that do not set their own. */
  idleTimeout?: number;
  streamFn?: StreamFn;
  repo?: SessionRepo;
}
```

A visit's timeout is the first of three that is set: the one `enter` was
given, then the session's, then fifteen minutes.

Everything else about `openSession` holds as `agent.md` states it — the
identity rules, the duplicate-name refusal, `streamFn`, `repo`, the storage.
The goal belongs to the opening, as the seats do: reopen the name with a
different goal and the record is intact under a new purpose.

A room runs whether or not anybody watches it. Agents wait, a colleague's
directed `say` wakes another colleague, and the record fills up with nobody
reading it. Somebody who opens the session later reads what happened.

---

## 3. Entering

```ts
const visit = await session.enter(andrei, { idleTimeout: 15 * 60_000 });

await visit.deliver({ text: 'Draft the weekly. Anything to flag?' });
await visit.deliver({ to: lead, text: 'What does this cost us in engineers?' });

visit.acted(); // the host reports a keystroke, a scroll, a click
await visit.leave();
```

Delivering belongs to the visit, not to the session. **You cannot speak into
a room you have not entered.** Provenance is a property of the handle the
host holds rather than a check the runtime performs on a handle it was
passed: a host that delivers as Andrei holds a live visit for Andrei, and
the visit ends when Andrei leaves.

Reading belongs to the session. `messages()`, `seats()` and `subscribe()`
answer whether or not anybody is present, because a host renders an
unattended room the same way it renders one with three people in it.
Reviewing is not acting, and a dashboard is not a visitor.

Anybody may enter. There is no guest list: the host authenticates the person
and vouches for the name and identity it passes, and Ambion never sees a
credential and keeps no user directory. The name is the person, and it is
the name a returning visitor is matched on, so a host that gives two people
one name gives them one seat and one history. `enter` refuses exactly one
thing — a name an agent already holds — because the room addresses
participants by name and two claimants make `say({ to })` ambiguous.

---

## 4. The visit

One person, many visits. One visit, one attachment.

A person who opens the room in a terminal and in a browser has two visits
and one name on the record. The runtime counts visits and derives the
person's status from them.

```ts
export interface EnterOptions {
  /** Milliseconds without an act, after which the visit turns away.
   *  Defaults to fifteen minutes. `Infinity` means never. */
  idleTimeout?: number;
  /** A label the host chooses — 'terminal', 'web', a device id. The runtime
   *  stores it and gives it back. It changes nothing. */
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
is the only thing the runtime asks of a host that knows what a real keystroke
is; sockets, pings and timeouts on the wire stay the host's concern. It is
synchronous even when it returns somebody from away and commits a `returned`
message: the message takes its seq in the same tick and persists on the same
write chain as every other entry, which is what `commit` does for a say.

The id is `<name>#<n>` — `andrei#1`, `andrei#2` — counted per session. It is
readable in a log and deterministic in a test. Treat it as opaque.

`deliver` and `acted()` on a visit that left throw. A handle to a finished
visit is a stale handle, and the runtime says so rather than accepting a
message from a person who is gone.

Two visits by one name are the same person. A second `enter` with the same
name and the same identity attaches another visit. A second `enter` with the
same name and a different identity is refused: one name is one identity for
the life of the opening, and the alternative is a roster that changes under
the agents reading it.

---

## 5. Arriving is a message

A person arriving is a thing that happened in the room, caused by a person,
that the other participants want to know. That is what a message is, so it
is one, and the record keeps one kind of entry:

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
the whole reason for this shape.

**Rule 1 holds exactly.** There is one activation mechanism: a message
delivered into a session activates every idle agent. Arriving delivers a
message. Nothing is special-cased, and nothing was weakened to let a door
count.

**Rule 2 holds exactly, and this is the one to think about.** Whatever
arrives mid-turn is steered into every active agent, and a presence message
arrives like any other — an agent at work learns that Andrei walked in, at
the next safe point, without finishing blind. The steer renders the line the
transcript renders, `[new] · andrei arrived`, so a seat never sees a message
with no text and no explanation of it. §7 counts what that costs.

**Rule 5 holds exactly.** A `say` commits only against a record its seat has
heard in full, and an arrival is part of that record. An agent composing a
reply when Andrei walks in has its say refused and is told what it missed,
which is correct: it reconsiders now that he is here. This is also what
keeps five agents from all greeting the same arrival. The first commits and
the rest are told the room moved, which is when rule 3 tells them to stand
down.

**Rule 7 holds, and gets stronger.** `from` is stamped by the runtime from
the live visit. A presence message is the one entry on the record that the
runtime observed itself rather than took somebody's word for. It carries no
`text`, because the person said nothing: writing `"(entered the room)"`
under their name would put words in their mouth, which is what rule 7 exists
to prevent. The kind carries the meaning and the renderer supplies the words.

**The room changes before the message does.** A visit registers before its
`arrived` commits and unregisters before its `left` does, so every agent the
message activates reads a roster that agrees with it. Backwards, a seat is
woken to be told Andrei left by a roster that still says he is present. The
same holds for `away` and `returned`: the status changes, then the message
that reports it takes its seq.

Two of the four kinds come from a deliberate act and two from a clock.
`arrived` and `left` follow `enter()` and `leave()`. `away` follows a timer
and `returned` follows `acted()`. All four activate.

The seq counts from 1, is monotonic, is assigned when the message commits,
and is strictly ordered. A cursor is exclusive: `since` names a message the
reader has, and the read starts after it. It is not Pi's storage seq — that
stays Pi's, and `openStore` sorts replayed entries by it.

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

A person's presence derives from their visits:

> Somebody is **present** if any of their visits is present, **away** if
> they have visits and all of them are away, and **absent** if they have
> none.

A presence message marks a change of that status, so four of these seven
cases write nothing at all:

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

Presence itself is live: it is a fact about attachments, and attachments die
with the process. What survives is the record of how it changed, and that
rebuilds everything — who has ever been here, who was here last, when, and
where each of them stopped reading. Presence is kept in one place, and the
place is the record.

---

## 7. The inactivity timeout

`idleTimeout` is milliseconds without an act, and it **defaults to fifteen
minutes**. `enter` takes it per visit, because the host knows the medium — a
terminal, a tab, a webhook — and one room holds all three. `openSession`
takes it as the house default for the visits that do not set their own.

`Infinity` turns it off: the visit stays present until it leaves, and no
`away` or `returned` message is written for it. It needs no special case in
the rule below — `now - lastActedAt < Infinity` is always true — and exactly
one in the timer, which is armed only for a finite timeout.

Two acts reset it: `deliver` and `acted()`. Reading does not. A host that
polls `messages()` every second is not a person paying attention, and the
runtime cannot tell the two apart from the inside. **Attention is claimed,
not inferred.**

The mechanism is a pure function and a timer, in that order:

```
status(visit, now) = now - visit.lastActedAt < visit.idleTimeout ? 'present' : 'away'
```

`seats()` and `visits()` compute it on read. The timer makes the change
observable on time and makes the message land when it happened: one timer
per present visit, armed at `enter`, cleared and armed again on each act,
cleared when the visit turns away or leaves. An away visit holds no timer.
The timer is `unref`'d, so a room full of idle people never keeps Node alive.

Deriving the status rather than storing it keeps the answer right when the
timer is wrong. A suspended laptop fires its timers late; `seats()` still
reports away, because it subtracts two numbers.

### What presence costs

Every presence message wakes every idle agent and steers every active one,
because it is a message. The core prices this honestly for what is said and
presence is priced the same way: a room of three costs three looks when
somebody arrives, and a colleague mid-turn pays a steer on top. Most of
those looks produce silence, and silence is still billed.

Because `idleTimeout` has a default, **a room pays for presence unless it
opts out**. Call `enter` and do nothing else, and four kinds of message wake
every idle seat.

One thing bounds it and two turn it off. **Away fires at most once per
stretch of attention**, because an away visit holds no timer — a person in
and out all day writes a few messages, not one per tick. **`Infinity`**
removes the two clock-driven kinds entirely, leaving the arrivals and
departures a person causes deliberately. And **`passive`** removes the
glance rather than the message: a passive seat hears no broadcast, so it
hears no arrival either, until somebody names it, while the record keeps
everything.

One combination is worth avoiding, and it is the one a host falls into by
doing nothing. A room with no `goal` still activates on all four kinds, and
its agents are not asked what to do with an arrival (§2) — so it pays the
full price of presence for judgement it never wanted. A room without a goal
passes `idleTimeout: Infinity`, or states a goal.

The timeout does not touch `settled()`. `settled()` reports that no agent is
active. Whether anybody is watching is a different fact.

---

## 8. Catch-up

The record holds when each person stopped reading, in strict order with
everything else. The cursor a catch-up needs is not a number kept somewhere;
it is a message.

```ts
const visit = await session.enter(andrei);
const missed = await session.messages({ since: visit.since });
```

`visit.since` is the seq of this person's most recent `away` or `left`
message, and `messages({ since })` returns everything after it. `since` is
`undefined` when the record holds neither — they have not been here
before — and the host says welcome and shows the tail rather than four
thousand messages.

**The anchor is where they stopped reading, not where they left.** Away and
absent are one fact here: nobody is looking. A person whose visit turns away
at 14:00 and acts again at 16:00 gets the two hours they missed, exactly
like a person who closed the tab and came back.

**The anchor holds while they read.** `since` is a live read of the record,
so it moves the moment an `away` or `left` message lands and then holds until
the next one. It does not move when they act, when a message lands, or when
a second visit opens. The divider a host draws in the transcript stays where
it was drawn for the whole stretch of attention.

Three things follow from the anchor being a message rather than a mark kept
beside the record.

**Ordering is exact.** An anchor and the messages past it are the same kind
of thing in one sequence on one commit path. No message lands between a
person going away and a mark being written, because there is no second write.

**Durability is free.** The record persists through Pi's `SessionRepo` and
`openStore` replays it. Nothing extra is stored, so nothing extra is lost,
and a durable `SessionRepo` — Pi's `JsonlSessionRepo`, or another — carries
presence with it.

**What you missed includes who was here.** Arrivals and departures come back
interleaved with what was said, because they are the same record. A person
reads that the room went quiet at 15:00 because everybody left.

One case fails, and it fails in the safe direction. If the process dies while
somebody is present, no `left` is written, because nothing observed them
leaving. On reopen their anchor is their previous `away` or `left`, so they
are shown more than they missed rather than less.

Catch-up does not cover what the agents did. The record holds what was said
and who was here; the turns and tool calls in between are in each seat's own
downstream session, where rule 8 of the core puts them.

---

## 9. What agents see

An arrival is worth waking for only if an agent can judge it, and judging it
takes three things: what the room is for, what time it is, and how long this
person has been gone. The context an agent reads on Andrei's arrival:

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

Three things beyond the record, each pulling its weight. **The goal** comes
from `openSession` and is what makes "does this arrival matter" answerable at
all. **The time**, absolute at the top and relative on each line, is what a
persistent ambient room needs and a bare transcript never gives: without it
an agent cannot tell a three-day gap from a three-minute one. **The gap** —
`last here 3 days ago` — is derived from the record, not stored, because the
arrivals are on it.

The system prompt carries one paragraph about arrivals, and most of it is
about not speaking. It renders only when the session has a goal (§2): an
agent with nothing to weigh an arrival against is not asked to weigh one.

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
he has not seen it. That is what presence is for — you walk into the room and
somebody tells you the one thing you missed.

Presence enters an agent's context at activation, with the rest of the
record. This is rule 2 of the core: working views reset at idle.

---

## 10. Observing presence

`messages()` returns the record, and takes a cursor:

```ts
session.messages(options?: { since?: Seq }): Promise<Message[]>;
session.visits(): VisitInfo[];
```

The event stream keeps attachment granularity, which the record deliberately
does not carry:

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
instrument panel, and the record is what participants read. An attachment is
host bookkeeping, so it never reaches the record — the room records that
Andrei's own status changed, not that his second tab did.

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

`seats()` answers who is in the room, and `SeatInfo` is a discriminated
union, because an agent seat and a person do not carry the same fields:

```ts
export type SeatInfo =
  | { kind: 'agent'; name: string; identity: string; status: SeatStatus; sessionId: string }
  | { kind: 'human'; name: string; identity: string; presence: PresenceStatus; visits: number };
```

---

## 11. What proves it

The milestone tests live in
[`packages/ambion/test/presence.test.ts`](../packages/ambion/test/presence.test.ts),
one per claim this document makes loudly: a room of agents alone opening,
running an exchange and settling with nobody present; `enter` committing an
`arrived` that activates the idle room while a passive seat sits out, against
a roster that already shows the arrival; an arrival steering an active agent
and refusing the say that turn commits; two people entering and the record
stamping each from their own visit; one person's second visit committing
nothing, and only the last leave committing `left`; the timeout resolving
`enter` then session then fifteen minutes, and `Infinity` arming no timer;
one of two visits turning away silently and both turning away committing
`away`; an away visit delivering, `returned` landing before its delivery; a
directed `say` still landing for somebody who left; a left visit throwing on
`deliver` and `acted()` while `leave()` twice does not; `enter` refusing an
agent's name and a second identity; `since` undefined on a first visit, then
the seq of the `left`, holding while a person reads and moving when they turn
away; `messages({ since })` returning exactly what followed, spoken and
presence interleaved; a session reopened on the same repo bringing back the
names, the anchors and the seq counter, and accepting a `say` to a name only
the replayed arrivals know; and the rendered context carrying the goal, the
time, both lists and the presence lines — with a goal-less room rendering
neither the goal nor the arrival paragraph, and routing presence normally
anyway. All in-process, in vitest, with fake timers where the clock matters.

---

## 12. Later

Presence is the fact a workspace needs before it can have channels: a channel
with read/write contracts must know who is reading, and a channel's record
carries the same arrivals this one does.

Three things sit directly on top and are not here. **Notifying somebody an
agent addressed while they were away** — the record holds both halves
already, the directed message and the `away` before it. **Catching up across
rooms**, one person and many sessions with one answer to "what did I miss",
which needs something that holds the rooms. And **a sender that is not a
person**: a cron, a webhook or a scheduled job has nobody to enter as, and an
ambient runtime whose rooms work unattended will want one — the answer is a
third kind of definition beside `defineAgent` and `defineHuman`, not a hole
in `enter`. Each arrives as its own document. None changes this one.
