# Presence

This document is the design contract for presence: who is in a session, how
the room knows, and what the agents do about it. The code lives with the
rest of the runtime in [`packages/ambion/src`](../packages/ambion/src) — the
visit and the roster in [`session.ts`](../packages/ambion/src/session.ts),
the shapes in [`types.ts`](../packages/ambion/src/types.ts). Read
[`agent.md`](agent.md) first: this document assumes its eight rules and
breaks none of them — presence widens rule 6 and leaves rule 1 exact.

One sentence:

> **`startSession` brings up a room of agents; `visitSession` puts a person
> in it; and arriving is a message like any other — so the room wakes when
> somebody walks in, and an agent that knows what the session is for can
> tell them what they missed.**

---

## 1. Two lifetimes

An agent belongs to the room. It is the room's composition, it is the same
on every opening, and it waits there between activations — this is the
whole of an ambient runtime. A person lives on a different clock. They
arrive, read, steer, and go, several of them at once, on their own
schedules.

`startSession` takes agents and never people. **Seating is composition.
Visiting is presence.** Three things follow, and they are what presence is
for.

**The roster tells the truth.** An agent reads whether each person is
reading right now. So a `say` directed at somebody absent is written as a
note they read later, with no expectation of an answer in the next six
hours.

**The host owns the boundary.** A person is in the room once or not at all,
and the host decides what "in the room" means for its medium — a socket, a
tab, a poll. A host that shows one person two tabs reconciles the tabs
itself and tells the room one thing, so the room never invents a second
person.

**Arrival is information.** Somebody walking into a meeting after three
days away is the most informative thing that happens all hour, and they
said nothing. The room treats it the way it treats anything else that
happened: as a message on the record.

---

## 2. The goal a room is started with

`startSession` is specified in [`agent.md`](agent.md) §5: it takes the
room's composition and brings it to life, `stopSession` takes it down, and
`readSession` reads a name without starting anything. One of its options is
presence's business.

```ts
const session = startSession({
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
export type AgentSeat = AgentDefinition | SeatedAgent;
```

`Participant` is the narrower thing — who may be addressed by name:

```ts
export type Participant = AgentDefinition | HumanDefinition;
```

`goal` is what the room is for. An agent knows its own instructions and it
knows the roster; without a goal it does not know what the room is trying
to do, and an arrival is then a fact it cannot judge. `goal` is to a
session what `identity` is to an agent — one or two sentences, public, in
every participant's context.

`goal` is optional. A room without one still works; its agents simply have
less to weigh a question against, and the goal line does not render.

The one option presence reads:

```ts
export interface StartSessionOptions {
  name: string;
  agents: readonly AgentSeat[];
  /** What the room is for. One or two sentences, read by every agent. */
  goal?: string;
  streamFn?: StreamFn;
  repo?: SessionRepo;
}
```

The goal belongs to the run, as the seats do: start the name again with a
different goal and the record is intact under a new purpose.

A room runs whether or not anybody watches it. Agents wait, a colleague's
directed `say` wakes another colleague, and the record fills up with nobody
reading it. Somebody who opens the session later reads what happened.

---

## 3. Visiting

```ts
const visit = await visitSession(session, andrei);

await visit.deliver({ text: 'Draft the weekly. Anything to flag?' });
await visit.deliver({ to: lead, text: 'What does this cost us in engineers?' });

await visit.leave();
```

Delivering belongs to the visit. **You can only speak into a room you are
in.** Provenance is a property of the handle the host holds, with no
runtime check on a handle it was passed: a host that delivers as Andrei
holds a live visit for Andrei, and the visit ends when Andrei leaves.

Reading belongs to the session, and `readSession` reaches it without a run.
`messages()`, `seats()` and `subscribe()` answer whether or not anybody is
present, because a host renders an unattended room the same way it renders
one with three people in it. Reviewing a room touches nothing in it, so
reading a name takes no visit and starts no agent — a dashboard can watch
without ever being a visitor.

Anybody may visit. There is no guest list: the host authenticates the
person and vouches for the name and identity it passes, and Ambion never
sees a credential and keeps no user directory. The name is the person, and
it is the name a returning visitor is matched on, so a host that gives two
people one name gives them one seat and one history. `visitSession` refuses
two things: a name an agent already holds, because two claimants make
`say({ to })` ambiguous; and a session that is idle, because a visit is
presence and there is nothing to be present in.

---

## 4. The visit

**One person, one visit.** A name is in the room or it is not, and
`visitSession` returns the visit that name holds.

```ts
export interface Visit {
  readonly human: HumanDefinition;
  /** A live read: the seq of this person's most recent `left` message,
   *  or `undefined` when the record holds none. It moves when they leave
   *  and holds while they are here. See §8. */
  readonly since: Seq | undefined;
  deliver(input: { to?: Participant; text: string }): Promise<void>;
  /** Idempotent: a host that closes a socket twice is not an error. */
  leave(): Promise<void>;
}
```

`visitSession` on a name that is already in the room commits nothing and
hands back the same visit. So a host does not have to remember whether it
opened one, and two tabs of one person do not make two people. The host
decides when that person is gone; the room takes its word for it.

A second `visitSession` with the same name and a different identity is
refused: one name is one identity for the life of the opening. The
alternative is a roster that changes under the agents reading it.

`deliver` on a visit that left throws, and so does it on a visit whose run
was stopped. A handle to a finished visit is a stale handle, and the
runtime says so. It accepts no message from a person who is gone, and none
into a room that is.

The runtime holds no clock over a visit. It does not guess that somebody
stopped reading, and it writes no message that says they did. The room
knows exactly two facts: a person arrived and, when the host says so, they
left. A host that wants an idle tab treated as a departure calls `leave()`,
which is the same fact stated once.

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
  kind: 'arrived' | 'left';
  seq: Seq;
  at: string;
  from: string;
  /** How the room knew them, on `arrived` alone. */
  identity?: string;
}

export type Message = Spoken | Presence | Summary;
```

`Summary` is the third kind, and it belongs to [`assistant.md`](assistant.md): an
assistant writes it, nobody speaks it, and it opens and closes no visit.
`Reminder` is the fourth, and it belongs to [`reminder.md`](reminder.md):
an agent wrote it earlier for itself, and the clock lands it.

Every rule of the core applies to a presence message unchanged, and that is
the whole reason for this shape.

**Rule 1 holds exactly.** There is one activation mechanism: a message
delivered into a session activates every idle agent. Arriving delivers a
message. Nothing is special-cased, and nothing was weakened to let a door
count.

**Rule 6 decides who wakes for it, and by default that is nobody.** The
session routes a presence message exactly like any other; each seat's
attention says whether it is wide enough to be woken by one. A bare agent
sits at `broadcast` and is too narrow, so opening a room wakes
nothing. An agent seated `attentive(concierge)` sits at `presence` and
wakes.

The default is the narrow one because an arrival has no words in it. Every
other message says what it wants; an arrival says only that somebody is
here, so a seat that answers one is guessing at the request — and a room of
three products all guessing hands a person three briefings they never asked
for the moment they open it. That cost scales with how many people use the
room, and stays flat with how much work there is. §8 is what actually
briefs a returning person, and it costs nothing until they ask. A seat
whose job is to meet people is the case that wants `attentive`, and a room
needs only that one seat at `presence`.

**Rule 2 reaches every seat already at work, whatever its attention.**
Whatever arrives mid-activation is steered into every active agent, and a
presence message arrives like any other: `[new] · andrei arrived` lands in
the running activation at the next safe point. Attention governs waking alone,
never hearing — a seat at `broadcast` is never woken by an arrival, and is
still told about one it is already working through.

That is what presence routing is for. A seat drafting a reply when the
person it concerns walks in — or walks out — can aim what it was already
going to say: pitch it at whoever is reading now, say the part that needs
them while they are still there, and drop what only mattered to somebody
who has gone. It shapes an answer already being written. It never starts
one.

**Rule 5 holds exactly.** A `say` commits only against a record its seat
has heard in full, and an arrival is part of that record. An agent
composing a reply when Andrei walks in has its say refused and is told what
it missed, which is correct: it reconsiders now that he is here. This is
also what keeps five agents from all greeting the same arrival. The first
commits and the rest are told the room moved, which is when rule 3 tells
them to stand down.

An `arrived` carries the identity the room knew them by, and it is the only
thing a presence message adds to a name. A run does not inherit its people
from the last one, so the record is where the next run learns who has been
here: without the identity, a replayed name is a name with no roster line.

**Rule 7 holds, and gets stronger.** `from` is stamped by the runtime from
the live visit. A presence message is the one entry on the record that the
runtime observed itself, with nobody's word to take. It carries no `text`,
because the person said nothing: writing `"(entered the room)"` under their
name would put words in their mouth, which is what rule 7 exists to
prevent. The kind carries the meaning and the renderer supplies the words.

**The room changes before the message does.** A visit registers before its
`arrived` commits and unregisters before its `left` does, so every agent
the message activates reads a roster that agrees with it. Backwards, a seat
is woken to be told Andrei left by a roster that still says he is present.

Both kinds come from a deliberate act: `arrived` follows `visitSession()`
and `left` follows `leave()`. No presence message comes from a clock. The
one message a clock lands is a reminder, and an agent set it on purpose
([`reminder.md`](reminder.md) §5).

The seq counts from 1, is monotonic, is assigned when the message commits,
and is strictly ordered. A cursor is exclusive: `since` names a message the
reader has, and the read starts after it. It is separate from Pi's storage
seq — that stays Pi's, and `openStore` sorts replayed entries by it.

---

## 6. Presence

A person is in the room or they are not.

```ts
export type PresenceStatus = 'present' | 'absent';
```

- **present** — they hold a live visit. They are reading.
- **absent** — the record has seen them and they hold no visit. They read
  this later.

A presence message marks a change of that status, so two of these four
cases write nothing at all:

1. A second `visitSession` opens while the person is present — no message,
   because their status did not change, and the same visit comes back.
2. The visit leaves — the person turns absent and `left` commits.
3. They visit again — the person turns present and `arrived` commits.
4. A person who left is still addressable. A `say` directed at them lands
   on the record and waits; they read it when they come back.

Case 4 needs the room to know the name, and the record is where it knows it
from. **A room learns every name in its record, and a record does not
forget.** An agent that reads `andrei (present)` and calls
`say({ to: 'andrei' })` two seconds after Andrei closed his laptop still
lands the message. So does an agent in a session reopened next week,
because replaying the record replays the arrivals.

Presence itself is live: it is a fact about a running room, and it dies
with the process. What survives is the record of how it changed, and that
rebuilds everything — who has ever been here, who was here last, when, and
where each of them stopped reading. Presence is kept in one place, and the
place is the record.

---

## 7. What presence costs

A presence message costs one commit, and no model call unless a seat is
seated `attentive`. It lands on the record, wakes nobody at the default
attention, and is read at the next activation by whoever the next message
wakes. A seat already at work pays a steer — one line in an activation it was
running anyway, and no activation of its own. Rule 5 counts it like any other
message, so a say drafted across an arrival is refused and re-aimed at
whoever is now reading; that is the lock working, with no exception made.

Two things bound the rest. **Only a deliberate act writes one.** No timer
writes a presence message, so a person who leaves a tab open all afternoon
costs the room nothing, and the message count follows the number of times
somebody opened or closed the room. And **`passive`** removes the
glance and keeps the message: a seat at `named` hears no broadcast, so it
hears no arrival either, until somebody names it, while the record keeps
everything.

Presence does not touch `settled()`. `settled()` reports that no agent is
active. Whether anybody is watching is a different fact.

---

## 8. Catch-up

The record holds when each person stopped reading, in strict order with
everything else. The cursor a catch-up needs is a message on the record
itself; the runtime keeps no counter beside it.

```ts
const visit = await visitSession(session, andrei);
const missed = await session.messages({ since: visit.since });
```

`visit.since` is the seq of this person's most recent `left` message, and
`messages({ since })` returns everything after it. `since` is `undefined`
when the record holds none — they have not been here before — and the host
says welcome and shows only the tail, and spares them four thousand
messages.

**The anchor holds while they read.** `since` is a live read of the record,
so it moves the moment a `left` message lands and then holds until the next
one. It does not move when they speak, when a message lands, or when they
visit again. The divider a host draws in the transcript stays where it was
drawn for the whole visit.

Three things follow from the anchor being a message on the record.

**Ordering is exact.** An anchor and the messages past it are the same kind
of thing in one sequence on one commit path. No message lands between a
person leaving and a mark being written, because there is no second write.

**Durability is free.** The record persists through Pi's `SessionRepo` and
`openStore` replays it. Nothing extra is stored, so nothing extra is lost,
and a durable `SessionRepo` — Pi's `JsonlSessionRepo`, or another — carries
presence with it.

**What you missed includes who was here.** Arrivals and departures come
back interleaved with what was said, because they are the same record. A
person reads that the room went quiet at 15:00 because everybody left.

**A run that ends properly closes its visits.** `stopSession` commits
`left` for everybody still present before it drains, because a deliberate
shutdown did observe them leaving — the room is going away underneath them.
So every anchor survives a planned restart exactly, and the next run picks
each person up where they stopped reading.

These are the one kind of message the room commits without routing. Every
other message activates the idle room, and this one has nobody to activate:
an activation started to hear that the room is closing is an activation
nobody reads.

That leaves one case, and it fails in the safe direction. If the process
dies before it can stop, no `left` is written, because nothing observed
anything. On the next run each of those people is anchored at their
previous `left`, so they are shown more than they missed and never less. A
crash widens a window; it never hides anything.

Catch-up does not cover what the agents did. The record holds what was said
and who was here; the turns and tool calls in between are in each seat's
own downstream session, where rule 8 of the core puts them.

---

## 9. What agents see

An arrival is worth waking for only if an agent can judge it, and judging
it takes three things: what the room is for, what time it is, and how long
this person has been gone. What an agent reads on Andrei's arrival — the
goal from its system prompt, and then the activation's own message:

```
This session exists to: Ship payments v2 this quarter. Decide scope, sequence
the work, and keep the plan of record current.

The time is 2026-08-27 16:04 UTC.

The agents (active: taking a turn now; idle: at rest. A seat marked "named
only" hears nothing but a say addressed to it; one marked "watches arrivals"
also wakes when somebody arrives or leaves; the rest wake on anything said):
- lead (idle): Tech lead. Owns feasibility, estimates, and sequencing.
- designer (idle): Product designer. Guards the user experience.
- planner (idle, named only): Project manager. Keeps the plan of record.

The people (present: in the room now; absent: not in the room):
- andrei (present, since just now, has not seen the last 2 messages): Founder.
  Owns the weekly. Bring him blockers only.
- mara (absent, since 20 minutes ago): Design lead.

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

Four things beyond the record, each pulling its weight:

- **The goal** comes from `startSession` and is what makes "does this
  arrival matter" answerable at all.
- **The time**, absolute at the top and relative on each line, is what a
  persistent ambient room needs and a bare transcript never gives: without
  it an agent cannot tell a three-day gap from a three-minute one.
- **The gap** is derived from the record, because the arrivals are on it;
  the runtime stores no separate timer.

And **the divider**. Knowing that Andrei has been gone three days is not
the same as knowing what he missed, and an agent that has to work it out by
reading dates will get it wrong. So the room draws the line for it, at each
person's anchor:

```
· andrei left                                             3 days ago
── andrei has not seen anything below this line ──
[exec] Approved two more engineers for the quarter.       1 day ago
```

One divider per person in the room, at the seq where they stopped reading,
and a count beside their name in the roster. An agent does not compute what
somebody missed; it reads it.

The system prompt carries one paragraph about presence, and it is about
aiming. A presence line reaching a working seat is never a request — nobody
asked anything by opening the room — so it never starts an activation,
and
the paragraph says so. It renders in every room, with or without a goal,
because it is about routing.

> Who is reading can change while you work. An arrival or a departure
> reaches you as a [new] line mid-turn, and wakes you outright if your seat
> watches for it. It is never a request — nobody asked you anything by
> opening the room — so it never means start something new, and you
> never greet, never say that you noticed, and never summarise the record
> back to the room. Use it to aim what you were already going to say: pitch
> it at whoever is actually reading now, say the part that needs them while
> they are still there, and drop what only mattered to somebody who has
> gone. If it changes nothing about your turn, ignore it. When nobody is in
> the room, work for the record: state what you decided and why, and do not
> wait for an answer that nobody is there to give.

The planner reading the context above has something worth saying: Andrei
owns the headcount call, the exec approved two engineers a day after he
left, and he has not seen it. That is what presence is for — you walk into
the room and somebody tells you the one thing you missed.

Presence enters an agent's context at activation, with the rest of the
record. This is rule 2 of the core: working views reset at idle.

---

## 10. Observing presence

`messages()` returns the record, and takes a cursor:

```ts
session.messages(options?: { since?: Seq }): Promise<Message[]>;
```

**Presence adds no event of its own.** An arrival and a departure reach the
stream on the existing `message` event, because that is what they are:
entries the room committed. The events of the core are the whole stream,
and a host that renders `message` renders presence for free. The `left`
messages `stopSession` writes reach it too: they wake nobody, and the host
still hears the room empty.

That is the point of putting presence on the record itself. A second
channel for "who is here" would have to be kept in step with the first, and
the two would disagree the first time one of them dropped an event.

`seats()` answers who is in the room, and `SeatInfo` is a discriminated
union, because an agent seat and a person do not carry the same fields:

```ts
export type SeatInfo =
  | {
      kind: 'agent';
      name: string;
      identity: string;
      status: SeatStatus;
      attention: Attention;
      sessionId: string;
      /** The person this seat writes for, when it is their assistant. See assistant.md. */
      owner?: string;
    }
  | {
      kind: 'human';
      name: string;
      identity: string;
      presence: PresenceStatus;
      /** The assistant they brought. Absent while it is still run state from a
       * restart they have not yet revisited. See assistant.md. */
      assistant?: string;
    };
```

---

## 11. What proves it

The milestone tests live in
[`presence.test.ts`](../packages/ambion/test/presence.test.ts), one per
claim this document makes loudly:

- a room of agents running and settling with nobody present;
- `visitSession` committing an `arrived` that wakes nobody at the default
  attention;
- an `attentive` seat woken by that same arrival while a `passive` seat
  and a plain one sit out, against a roster that already shows it;
- an arrival steering a seat already at work;
- a presence message carrying no text and stamping `from` off the visit;
- two people delivering and the record stamping each from their own;
- a second `visitSession` on one name committing nothing and returning the
  same visit, and one `left` when it leaves;
- a name still on the roster after it left and after the run that knew it
  ended;
- a stale visit refusing `deliver` while `leave` twice does not;
- `since` undefined on a first visit, then the seq of the `left`, holding
  while a person reads and moving when they leave again;
- `messages({ since })` returning both kinds in order;
- `stopSession` closing its visits without waking anybody;
- `readSession` reading a stopped name with no agent standing up;
- the rendered context carrying the goal, the clock, each person's unseen
  count and the divider — with the goal rendering only when set and the
  presence paragraph rendering always.

All in-process, in vitest, on a scripted stream.

The rules this document shares with the core are proved beside them, in
[`session.test.ts`](../packages/ambion/test/session.test.ts), which now
runs every one of them through a visit.
