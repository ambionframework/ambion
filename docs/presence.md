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
on their own, and stops paying attention on their own. The room tracks that
and tells the agents, because an agent that asks a question of an empty room
is wasting the ask.

Presence adds no store. Every arrival and departure lands on the record the
room already keeps, in the same order as everything else, and everything
else in this document is read back out of it.

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

**The host has no seam.** A host with two people watching one room — a
terminal and a browser — has one `deliver` and one handle. It cannot report
that one of them closed the tab.

The proposal takes people out of `openSession`, gives them a verb, and puts
what the verb does on the record.

---

## 2. openSession seats agents

```ts
const session = openSession({
  name: 'initiative',
  agents: [lead, designer, product, passive(planner)],
});
```

That is the room: four agents, one record, one name. Open the name again
and you are back in it, record intact. Nothing else about `openSession`
changes — the identity rules, the duplicate-name refusal, `streamFn`,
`repo`, the storage — all of it holds as `docs/agent.md` states it.

The room runs whether or not anybody is watching. This is the normal case,
not the edge case: agents wait, a colleague's directed `say` wakes another
colleague, and the record fills up with nobody reading it. A person who
opens the session later reads what happened.

`participants` becomes `agents`, because that is what the field now holds.
The type stays a union of the two ways to seat an agent:

```ts
export type AgentSeat = AgentDefinition | PassiveSeat;
```

`Participant` survives as a narrower thing — who may be addressed by name:

```ts
export type Participant = AgentDefinition | HumanDefinition;
```

`defineHuman` is unchanged and still returns a value. It is no longer a
participant of an opening; it is what a person enters as.

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

Reading stays on the session. `record()`, `seats()` and `subscribe()` answer
whether or not anybody is present, because a host renders an unattended room
the same way it renders one with three people in it. Reviewing is not
acting, and a dashboard is not a visitor.

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
  /** Milliseconds without an act, after which the visit turns away. Omit: never. */
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
   *  `away` or `left` notice, or `undefined` when the record holds none.
   *  It moves when they stop reading and holds while they read. See §8. */
  readonly since: number | undefined;
  deliver(input: { to?: Participant; text: string }): Promise<void>;
  /** The host reports that the person acted. Returns an away visit to present. */
  acted(): void;
  /** Idempotent: a host that closes a socket twice is not an error. */
  leave(): Promise<void>;
}
```

`acted()` names the fact the host reports, not a command to the runtime. It
replaces `touch()`, which is a metaphor. It stays synchronous even when it
returns somebody from away and writes a `returned` notice: the notice takes
its seq in the same tick and persists on the same write chain as every other
entry, which is what `commit` already does for a say.

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

## 5. The record holds notices

The record holds what happened in the room, and until now everything that
happened was something a participant said. Presence adds a second kind of
entry, and it is the only structural change this document makes:

```ts
/** Monotonic, assigned when the entry commits, strictly ordered, never reused. */
type Seq = number;

export interface Message {
  kind: 'message';
  seq: Seq;
  at: string; // ISO, stamped by the runtime at the moment it landed
  from: string; // a participant's name — stamped by the runtime, never claimed
  to?: string; // present when the delivery or say was directed
  text: string;
}

export interface Notice {
  kind: 'notice';
  seq: Seq;
  at: string;
  who: string; // the person this is about
  change: 'entered' | 'away' | 'returned' | 'left';
}

export type Entry = Message | Notice;
```

**A notice is a fact the room recorded. A message is a thing a participant
said.** That is the whole distinction, and three rules follow from it.

**1. A notice does not activate anything, and does not steer.** This is the
core's design principle 1, unweakened: there is exactly one way an agent
activates, and it is a message delivered into a session it belongs to. A
notice lands, takes a seq, and waits to be read at the next activation.
Nobody wakes to be told that a door opened, and nobody's running turn is
interrupted to be told either — an interruption costs a model call, and the
room already handles the case that would justify one: it never forgets a
name, so a `say` to somebody who left still lands (§6).

**2. A notice does not fail a `say`.** Rule 5 of the core refuses a say
whose seat did not hear the whole record, so that every message was spoken
by somebody who had heard everything before it. It compares against
messages. A notice raises the record's seq without invalidating anybody's
turn, because nobody needs to have heard that Andrei went away in order to
have earned the right to speak. Implement this wrong and a busy room refuses
most of its says.

**3. A notice is written per person, not per attachment.** Andrei's second
tab is host bookkeeping; the room records only that Andrei's own status
changed. The four changes are the four transitions of §6: `entered` on
absent to present, `away`, `returned`, and `left` on the last visit going.
Attachment-level detail stays on the event stream, where §11 puts it, and
off the shared record where every agent would have to read it.

The seq counts from 1, is monotonic, is assigned when the entry commits, and
is strictly ordered over both kinds. A cursor is exclusive: `since` names an
entry the reader has, and the read starts after it. The core already needs this and already approximates it
with `record.length`; naming it is what lets a cursor point into a record
that holds two kinds of thing. It is not Pi's storage seq — that stays
Pi's, and `openStore` keeps sorting replayed entries by it.

Records written before this change carry neither field. `openStore` reads a
missing `kind` as `'message'` and assigns a missing `seq` from replay order,
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

That rule is what "tracked correctly" means. Seven cases follow from it, and
the proposal claims all seven. A notice marks a change of status, so four of
them write nothing:

1. A second visit opens while the person is present — no notice, because
   their status did not change. Only the first `enter` of a stretch writes
   `entered`.
2. Two visits, one leaves — the person stays present, and again no notice.
3. The last visit leaves — the person turns absent and a `left` notice
   lands.
4. One visit turns away, another is present — the person stays present, and
   again no notice.
5. Every visit turns away — the person turns away and an `away` notice lands.
6. An away visit delivers — that visit returns to present, so does the
   person, and a `returned` notice lands. Delivering is acting.
7. A person who left is still addressable. A `say` directed at them lands on
   the record and waits; they read it when they come back.

Case 7 needs the room to know the name, and the record is where it knows it
from. **A room learns every name in its record, and a record does not
forget.** An agent that reads `andrei (present)` in its roster and calls
`say({ to: 'andrei' })` two seconds after Andrei closed his laptop still
lands the message. So does an agent in a session reopened next week, because
replaying the record replays the notices. The known names are bounded by the
people who actually visited, which is a small number of real people.

Presence itself is live — it is a fact about attachments, and attachments
die with the process. What survives is the record of how it changed, and
that is enough to rebuild everything this document needs: who has ever been
here, who was here last, and where each of them stopped reading. A session
reopened after a restart shows nobody present, because nobody is, and shows
every name it has ever seen, because it read them back.

---

## 7. The inactivity timeout

`idleTimeout` is milliseconds without an act. `enter` takes it per visit,
because the host knows the medium — a terminal, a tab, a webhook — and one
room can hold all three. `openSession` takes it too, as the house default
for every visit that does not set its own. Omit both and a visit never turns
away on its own; it stays present until it leaves.

Two acts reset it: `deliver` and `acted()`. Reading does not. A host that
polls `record()` every second is not a person paying attention, and the
runtime cannot tell the two apart from the inside. **Attention is claimed,
not inferred.** `acted()` is the seam through which the host — which knows
what a real keystroke is — makes the claim.

The mechanism is a pure function and a timer, in that order:

```
status(visit, now) = now - visit.lastActedAt < visit.idleTimeout ? 'present' : 'away'
```

`seats()` and `visits()` compute it on read. The timer only makes the change
observable on time, and makes the notice land when it happened: one timer
per present visit, armed at `enter`, cleared and armed again on each act,
cleared when the visit turns away or leaves. An away visit holds no timer.
The timer is `unref`'d, so a room full of idle people never keeps Node alive.

Deriving the status rather than storing it is what keeps the answer right
when the timer is wrong. A suspended laptop fires its timers late. `seats()`
still reports away, because it subtracts two numbers.

Because an away visit holds no timer, `away` fires at most once per stretch
of attention. A person in and out all day writes a few notices, not one per
tick. The record does not fill up with a clock.

The timeout does not touch `settled()`. `settled()` reports that no agent is
active. Whether anybody is watching is a different fact.

---

## 8. Catch-up

Notices on the record give catch-up for nothing, and give it exactly.

The record already holds when each person stopped reading, in strict order
with everything else. The bookmark a catch-up needs is not a number kept
somewhere; it is an entry.

```ts
const visit = await session.enter(andrei);
const missed = await session.record({ since: visit.since });
```

`visit.since` is the seq of this person's most recent `away` or `left`
notice. `record({ since })` returns every entry after it. `since` is
`undefined` when the record holds neither — they have not been here
before — and the host says welcome and shows the tail of the record instead
of "you missed four thousand entries".

**The anchor is where they stopped reading, not where they left.** Away and
absent are one fact here: nobody is looking. A person whose visit turns away
at 14:00 and acts again at 16:00 gets the two hours they missed, exactly
like a person who closed the tab and came back. One rule covers both, and it
is the rule §7 already states — acting is the only evidence of attention the
runtime has.

**The anchor holds while they read.** `since` is a live read of the record,
so it moves the moment an `away` or `left` notice lands and then holds until
the next one. It does not move when they act, when a message lands, or when
a second visit opens. The divider a host draws in the transcript stays where
it was drawn for the whole stretch of attention.

Three things this buys that a separate bookmark did not:

**Ordering is exact, not approximate.** An anchor and the entries it points
past are the same kind of thing in one sequence, committed on one path. There
is no window in which a message lands between a person going away and the
mark being written, because there is no second write. A bookmark kept beside
the record has that race; a bookmark that _is_ the record cannot.

**Durability is free.** The record persists through Pi's `SessionRepo`
already, and `openStore` already replays it. A person returning to a session
reopened after a restart is matched by name against the notices that came
back with everything else. Nothing new is stored, so nothing new can be lost,
and `JsonlSessionRepo` makes this real today.

**What you missed includes who was here.** Catch-up returns the arrivals and
departures interleaved with what was said, in order, because they are on the
same record. A person reads that the room went quiet at 15:00 because
everybody left, not just that it went quiet.

One failure stays, and it fails in the safe direction. If the process dies
while somebody is present, no `left` notice is written, because nothing
observed them leaving. On reopen their anchor is their previous `away` or
`left`, so they are shown more than they missed rather than less. Over-
delivery is the right way for this to break.

What catch-up does not cover is what the agents did. The record holds what
was said and who was here. The turns and tool calls in between are in each
seat's own downstream session, where rule 8 of the core puts them.

---

## 9. What agents see

This is where the addition earns its place. Presence is not host
bookkeeping; it is context, and it changes what an agent does.

Notices render in the transcript, in order, beside what was said:

```
The record of 'initiative' so far:
[andrei] Draft the weekly. Anything to flag?
[lead → andrei] Two engineers for three weeks, assuming the migration holds.
· andrei is away
[designer] Cutting that flow costs a step nobody has counted.
· andrei left
```

And the roster carries the current answer, so an agent does not have to
replay the notices to know who is here:

```
The agents (active: taking a turn now; idle: hears every message; passive:
hears only a say directed at them):
- lead (idle): Tech lead. Owns feasibility, estimates, and sequencing.
- designer (idle): Product designer. Guards the user experience.
- planner (passive): Project manager. Keeps the plan of record.

The people this room knows:
- andrei (absent): Founder. Owns the weekly. Bring him blockers, not status.
- mara (present): Design lead. Decides on the experience.
```

Two lists, because they are two facts, and the second one is derived from
the first record rather than stored beside it. The agents are the room's
composition and never move. The people change between one activation and the
next. When nobody is in the room the prompt says so plainly:
`Nobody is in the room now.`

The system prompt gains one paragraph:

> The second list is the people this room has seen and how they are reading.
> Present: they are here now. Away: they are here and have not acted
> recently. Absent: they are not here. The record marks each change where it
> happened. A say directed at somebody who is away or absent is a note they
> read later, not a question they answer now. When nobody is in the room,
> work for the record: state what you decided and why, and do not wait for an
> answer that nobody is there to give.

An agent that knows the room is empty writes differently from one that
thinks somebody is waiting. That difference is the return on this document.

Presence enters an agent's context at activation, with the rest of the
record. A person who enters while an agent is mid-turn does not appear in
that turn — the notice is on the record, and the next activation reads it.
This is rule 2 of the core, unchanged: working views reset at idle.

---

## 10. What does not change

Four things stay exactly as they are, and each one is a decision.

**Activation.** Notices neither activate an idle agent nor steer an active
one. There is still exactly one way an agent activates.

**Routing.** `dispatch` is unchanged, and it never sees a notice. A message
from an away person routes like a message from a present one, because it is
the same message. A `say` directed at a person still wakes nothing — it is
an address for a reader, present or not.

**Provenance.** `from` is still stamped by the runtime and never claimed. It
is stamped harder: it comes from a live visit rather than from a handle the
caller picked. A notice has no `from` at all, because nobody said it.

**Storage.** Nothing is added. The record is one Pi session's custom
entries, as it is today, with one more `customType` alongside the one it
already uses.

---

## 11. Observing presence

The stream keeps attachment granularity, which the record deliberately does
not carry:

```ts
type SessionEvent =
  | /* … the nine events of the core, unchanged … */
  | { type: 'visit_enter';  human: string; visit: string; presence: PresenceStatus }
  | { type: 'visit_away';   human: string; visit: string; presence: PresenceStatus }
  | { type: 'visit_return'; human: string; visit: string; presence: PresenceStatus }
  | { type: 'visit_leave';  human: string; visit: string; presence: PresenceStatus }
  | { type: 'notice';       notice: Notice };
```

The four `visit_*` events name the attachment that changed and the person's
status afterwards. They fire on every attachment change. `notice` fires only
when the person's own status changed, and carries the entry that landed on
the record — so a host can tell the two apart without inferring. When
Andrei's first tab goes idle and his second is live, `visit_away` fires with
`presence: 'present'` and no `notice` follows, because Andrei is still
reading.

This is the core's own distinction, held: the event stream is the host's
instrument panel, and the record is what participants read.

The pull side:

```ts
export interface VisitInfo {
  id: string;
  human: string;
  status: VisitStatus;
  via?: string;
  enteredAt: string;   // ISO, stamped by the runtime
  lastActedAt: string; // ISO, stamped by the runtime
  since: number | undefined;
}

session.record(options?: { since?: Seq }): Promise<Entry[]>;
session.visits(): VisitInfo[];
```

`record()` replaces `messages()`. One record, one reader: it returns
everything the room recorded, in seq order, and a host that wants only what
was said filters on `kind`. Keeping both would be two ways to read one
thing, and it would make the shorter name return the less complete answer.

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
being true when this lands. The proposal is reviewable against them.

**§4, `defineHuman`.** "A human is a participant, not an operator: seated
like an agent, on the roster like an agent, on the record like an agent." On
the record: still true, and the stamping paragraph holds word for word.
Seated like an agent: no. A person is not seated by `openSession` at all,
and §4 gets rewritten around entering.

**§5, `openSession`.** The example seats `andrei` in `participants` and
calls `session.deliver`. Both change. "The seats belong to the opening" is
sharpened rather than replaced: agent seats belong to the opening, and a
person's presence belongs to their visit.

**§5, "What the record holds is one shape".** It holds two now, and every
entry carries a seq. The four fields of a message are unchanged and two are
added.

**§5, rule 7, "Identity is injected."** "Every agent's context carries the
roster — each participant's name, kind, identity and status." It carries two
lists now, and the second one varies between activations of the same room.
The rule's other half — provenance is stamped, never self-reported — gets
stronger, not weaker.

Rules 1 through 6 and rule 8 are untouched, and rules 1 and 5 are untouched
precisely because a notice is not a message. So is every one of the eleven
tests in `packages/ambion/test/session.test.ts`, except where they call
`deliver` or read a message's shape.

---

## 13. The change in the code

Fourteen edits, all in `packages/ambion/src`. The runtime keeps its two
concerns: participants as values, and the session as a room. Presence is
part of the room — who is in it — not a third thing, and it introduces no
store, no transport, no authentication, and no user directory. The host
opens the socket and names the person; the runtime records and derives.

| File         | Change                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `define.ts`  | `defineHuman` unchanged; its comment stops calling the value a participant                                    |
| `types.ts`   | `Seq`, `Notice`, `Entry`; `Message` gains `kind` and `seq`                                                    |
| `types.ts`   | `AgentSeat`; `Participant` narrows to agent-or-human                                                          |
| `types.ts`   | `VisitStatus`, `PresenceStatus`, `VisitInfo`; `SeatInfo` becomes a union                                      |
| `types.ts`   | Four `visit_*` events and `notice` on `SessionEvent`                                                          |
| `session.ts` | `participants` becomes `agents`; `seat()` drops its human branch                                              |
| `session.ts` | `commit()` assigns the seq and takes a notice as well as a message                                            |
| `session.ts` | `openStore` replays both entry types, restores the seq counter, and rebuilds the known names from the notices |
| `session.ts` | `VisitRuntime` per attachment; `Map<string, VisitRuntime[]>` keyed by name                                    |
| `session.ts` | `enter()`, and `Visit` with `deliver`, `acted`, `leave`, and `since` as a getter                              |
| `session.ts` | `deliver` moves off `Session`; the body is reused, `from` comes from the visit                                |
| `session.ts` | `presenceOf()` and `visitStatus()` — pure, both read by `seats()`                                             |
| `session.ts` | One `unref`'d timer per present visit; armed, cleared, re-armed on each act                                   |
| `session.ts` | `messages()` becomes `record({ since })`; `renderContext` renders notices                                     |
| `session.ts` | `systemPrompt` renders the two lists and gains the paragraph in §9                                            |
| `index.ts`   | Export the new types, and re-export Pi's `JsonlSessionRepo`                                                   |

Two functions the record's new shape touches, and neither is a rewrite.
`dispatch` takes messages and never sees a notice. `sayTool` changes in one
line and depends on one: its lock compares the last message seq, not the last
entry seq — the line in this document that is easiest to implement backwards,
and §5 says why — and its `to` lookup still reads the map of known names,
which `openStore` must now fill from the replayed notices rather than from
`openSession`. Miss that and a reopened room refuses every say addressed to
somebody who was in it yesterday.

Hosts migrate in three lines:

```ts
// before
const session = openSession({ name: 'initiative', participants: [andrei, lead, designer] });
await session.deliver({ from: andrei, text: 'Draft the weekly.' });

// after
const session = openSession({ name: 'initiative', agents: [lead, designer] });
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
2. `enter` writes an `entered` notice, and activates nothing — no agent runs.
3. A notice landing mid-turn does not steer, and does not fail the say that
   turn commits.
4. Two people enter, both deliver, and the record stamps each from their own
   visit.
5. One person, two visits: the second `enter` writes no notice, the first
   visit leaving writes none either, and the second leaving writes `left`.
6. A visit turns away after `idleTimeout` with the clock advanced, and an
   `away` notice lands at the right seq.
7. One of two visits turns away and no notice lands; both turn away and one
   does.
8. An away visit delivers, a `returned` notice lands, and the message routes
   normally.
9. A person leaves, and an agent's directed `say` still lands on the record
   addressed to them.
10. `deliver` and `acted()` on a left visit throw; `leave()` twice does not.
11. `enter` refuses a name an agent holds, and refuses a second identity for
    a name already in the room.
12. `since` is `undefined` on a first visit, and the seq of the `left` notice
    on the next one.
13. `since` does not move while a person reads, and moves when they turn
    away — read from the same visit, before and after.
14. `record({ since })` returns exactly the entries after that seq, messages
    and notices interleaved in order; `record()` returns everything.
15. A session is closed and reopened on the same repo: the names come back,
    a returning person's `since` is the seq it was, and seqs continue rather
    than restart.
16. In a reopened session an agent's `say` to a name that only the replayed
    notices know is accepted, not refused.
17. The roster an agent reads carries both lists and the transcript carries
    the notices; an empty room says so.

---

## 15. Rejected alternatives

**A presence store beside the record.** An earlier draft of this document
kept presence in a live map, wrote an audit entry for transitions, and kept
a separate durable bookmark of where each name stopped reading. It was
wrong, and the reasons are worth keeping. It invented a second store for
facts the record could hold. It made ordering approximate, because a mark
written beside the record races the record. It made durability an argument
rather than a consequence. And it failed the core's own measure — does this
add a second way to do something that has one — which the runtime applies to
every other addition. The record was already the room's ordered, persisted
log of what happened. Presence is what happened.

That draft rejected notices for two reasons. One was taste: the record holds
what participants said, and nobody said a join. The other was mechanical and
real: every message activates the idle room, so a join would wake four agents
to read a line about a door. §5 answers the mechanical one by making a notice
not a message — no activation, no steer, no failed say — and the taste one is
worth less than exact ordering and free durability.

**One `defineHuman` per connection.** Two tabs would be two people with two
names. The person is one name. The attachment is the thing there can be many
of, and it stays off the record for the same reason.

**Inferring presence from reads.** Treating `record()` as evidence of
attention. A poller is not a reader, and the runtime cannot tell them apart.
`acted()` puts the claim where the knowledge is.

**A read cursor the host claims.** `visit.seen(seq)`, with unread derived
from it. It answers a question the runtime cannot check — what somebody
read — and it makes every host keep a cursor it must store and migrate. §8
answers the question the runtime can check, out of a record it keeps anyway.
A host that wants per-person read state can still keep it, against the same
seq.

**A guest list of people at open time.** `openSession({ agents, humans })`.
It buys one thing — addressing somebody who has never visited — and costs
the lifetime distinction this whole document is about. The record learning
names (§6) recovers what it bought.

**A separate `joinSession(name)` beside `openSession(name)`.** Two ways to
reach one room. `enter` on the opened session is enough.

**A heartbeat protocol in the runtime.** Sockets, pings and timeouts on the
wire are the host's concern. The runtime takes one call — `acted()` — and
asks nothing about how the host learned it.

---

## 16. Open questions

Six decisions this document takes, each of which could go the other way.

1. **Should a notice ever steer?** The proposal says never: an interruption
   costs a model call, and the case that would justify one is already
   handled. The argument the other way is a long turn in a room somebody
   just left, where the agent keeps writing for a reader who is gone.

2. **Should `idleTimeout` have a default?** The proposal says no: omit it and
   a visit never turns away, and no `away` notice is ever written. A default
   of ten or fifteen minutes would make the common case shorter and the
   surprising case surprising.

3. **Does a crash while somebody is present deserve a synthetic notice?** §8
   accepts over-delivery: no `left` was observed, so none is written, and the
   person is shown more than they missed. `openStore` could instead append a
   `left` for anybody the record leaves dangling. That is tidier and puts an
   event on the record that nothing observed.

4. **Should a host be able to deliver without a person?** A cron or a webhook
   has nobody to enter as, and after this change there is nothing but agents
   at open time. It cannot deliver today either, so nothing regresses — but
   an unattended room will want it, and the answer is probably a third kind
   of definition, not a hole in `enter`.

5. **`agents`, or keep the name `participants`?** The proposal renames the
   field, because it now holds one kind of thing and the old name says
   otherwise. Keeping `participants` costs nothing at the call site and one
   sentence of explanation forever.

6. **Does `record()` fully replace `messages()`?** The proposal says yes, so
   that one method returns the whole record. Keeping `messages()` for hosts
   that only render chat is a convenience, and a second way to read one
   thing.

---

## 17. Later

Presence is the fact a workspace needs before it can have channels: a
channel with read/write contracts must know who is reading, and a channel's
record carries the same notices this one does.

Two things sit directly on top and are not in here. Notifying somebody an
agent addressed while they were away: the record holds both halves already —
the directed message, and the `away` notice before it. And catching up across
rooms, one person and many sessions with one answer to "what did I miss",
which is a workspace concern, because it needs something that holds the
rooms. Neither changes the core.
