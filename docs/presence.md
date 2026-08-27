# Presence

This document is a proposal. Nothing in it is built. The runtime today has
no `enter`, no visit, and no presence status — a human is seated by
`openSession` and stays seated, and `session.deliver` speaks for them
whether or not anybody is there.

It answers one question the core leaves open. A session is persistent and
ambient: agents wait in it, and a delivery activates them. A human opens
the same session to read what happened and to steer what happens next.
Those are not the same act, and the runtime cannot tell them apart.

> **Seating is membership. Entering is presence.** `openSession` says who
> belongs to the room. `enter` says who is in it now.

Several people can be in one room at once. Each attaches on their own, acts
on their own, and stops paying attention on their own. The room must track
that correctly, and must tell the agents, because an agent that asks a
question of an empty room is wasting the ask.

---

## 1. The distinction

The core has one entry point for a person:

```ts
const session = openSession({ name: 'initiative', participants: [andrei, lead, designer] });
await session.deliver({ from: andrei, text: 'Draft the weekly.' });
```

`andrei` is on the roster from the moment the session opens. Every agent
reads him in its context as a participant. But the value proves nothing
about attention. It is a definition, not a person, and the room holds it
whether Andrei is reading, asleep, or on another continent. Three failures
follow.

**The roster lies.** An agent sees `andrei (human)` and reasonably directs a
`say` at him. Nobody reads it for six hours. The agent had no way to know.

**The host has no seam.** A host with two people watching one room — a
terminal and a browser — has one `deliver` and one handle. It cannot report
that one of them closed the tab.

**Provenance is checked, not structural.** `deliver` verifies that `from` is
a seated handle. That catches a typo. It does not catch a host that keeps
delivering as a person who left an hour ago.

The proposal adds one verb and one value. Membership stays where it is.

---

## 2. Seating and entering

`openSession` does not change:

```ts
const session = openSession({
  name: 'initiative',
  participants: [andrei, mara, lead, designer, passive(planner)],
});
```

`andrei` and `mara` are members. The room knows their names, their
identities, and that a `say` may be addressed to them. They are not in the
room. A member who has not entered is **absent**.

Entering is the second verb:

```ts
const visit = await session.enter(andrei, { idleTimeout: 15 * 60_000 });

await visit.deliver({ text: 'Draft the weekly. Anything to flag?' });
await visit.deliver({ to: lead, text: 'What does this cost us in engineers?' });

visit.acted(); // the host reports a keystroke, a scroll, a click
await visit.leave();
```

`deliver` moves from the session to the visit. That is the point of the
change, not a side effect of it. **You cannot speak into a room you have
not entered.** Provenance stops being a check the runtime performs and
becomes a property of the handle the host holds. A host that wants to
deliver as Andrei must hold a live visit for Andrei, and the visit ends
when Andrei leaves.

Reading stays on the session. `messages()`, `seats()` and `subscribe()`
answer whether or not anybody is present, because a host renders a dashboard
of an unattended room the same way it renders one with three people in it.
Reviewing is not acting.

`enter` refuses a human who is not in `participants`. This is a consistency
rule, not a security boundary: the room addresses participants by name, and
a name that is not on the roster cannot be addressed. The host still
authenticates the person. Ambion never sees a credential.

---

## 3. The visit

One person, many visits. One visit, one attachment.

A person who opens the room in a terminal and in a browser has two visits.
They are one member with one seat and one name on the record. This is the
whole of the multi-attachment answer: the runtime counts visits and derives
the person's status from them, so closing one tab does not make somebody
absent who is still watching in the other.

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
  /** 'present' or 'away'. A visit that left is not readable; its handle throws. */
  readonly status: VisitStatus;
  deliver(input: { to?: Participant; text: string }): Promise<void>;
  /** The host reports that the person acted. Returns an away visit to present. */
  acted(): void;
  /** Idempotent: a host that closes a socket twice is not an error. */
  leave(): Promise<void>;
}
```

`acted()` names the fact the host reports, not a command to the runtime. It
replaces `touch()`, which is a metaphor.

The id is `<name>#<n>` — `andrei#1`, `andrei#2` — counted per session. It is
readable in a log and deterministic in a test. Treat it as opaque.

`deliver` on a visit that left throws. So does `acted()`. A handle to a
finished visit is a stale handle, and the runtime says so rather than
accepting a message from a person who is gone.

---

## 4. Presence

A visit has two states. A seat has three.

```ts
export type VisitStatus = 'present' | 'away';
export type PresenceStatus = VisitStatus | 'absent';
```

- **present** — the person acted within the timeout. They are reading.
- **away** — the person is attached, but has not acted for longer than the
  timeout. They will read this later.
- **absent** — the person is a member and has no live visit. They are not
  in the room.

A seat's presence derives from its visits, and the rule is one sentence:

> A seat is **present** if any of its visits is present, **away** if it has
> visits and all of them are away, and **absent** if it has no visits.

That rule is what "tracked correctly" means. Six cases follow from it, and
the proposal claims all six:

1. Two visits, one leaves — the seat stays present.
2. The last visit leaves — the seat turns absent.
3. One visit turns away, another is present — the seat stays present.
4. Every visit turns away — the seat turns away.
5. An away visit delivers — that visit returns to present, and so does the
   seat. Delivering is acting.
6. A member who never entered stays absent, and a `say` may still be
   addressed to them.

Presence is live. It is not on the record and it does not survive the
process. Reopen a name and you get the record back and an empty room. That
is correct: presence is an attachment to a running session, and a session
that is not running has nobody in it.

The transitions are still auditable. Each one lands in the room's own Pi
session as a custom entry, `ambion/presence`, the way each activation
already lands in a seat's session as `ambion/activation`. It is a trail for
review, not part of `messages()`. The record holds what was said.

---

## 5. The inactivity timeout

`idleTimeout` is milliseconds without an act. `enter` takes it per visit,
because the host knows the medium — a terminal, a tab, a webhook — and one
room can hold all three. `openSession` takes it too, as the house default
for every visit that does not set its own. Omit both and a visit never turns
away on its own; it stays present until it leaves.

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
observable on time: one timer per present visit, armed at `enter`, cleared
and armed again on each act, cleared when the visit turns away or leaves. An
away visit holds no timer. The timer is `unref`'d, so a room full of idle
people never keeps Node alive.

Deriving the status rather than storing it is what keeps the answer right
when the timer is wrong. A suspended laptop fires its timers late. `seats()`
still reports away, because it subtracts two numbers.

The timeout does not touch `settled()`. `settled()` reports that no agent is
active. Whether anybody is watching is a different fact.

---

## 6. What agents see

This is where the addition earns its place. Presence is not host
bookkeeping; it is context, and it changes what an agent does.

The roster line gains the human's presence:

```
The roster (active: taking a turn now; idle: hears every message; passive: hears
only a say directed at them):
- andrei (human, present): Founder. Owns the weekly. Bring him blockers, not status.
- mara (human, away): Design lead. Decides on the experience.
- lead (idle): Tech lead. Owns feasibility, estimates, and sequencing.
- planner (passive): Project manager. Keeps the plan of record.
```

And the system prompt gains one paragraph:

> A human's status says whether they are reading. Present: they are in the
> room now. Away: they are in the room and have not acted recently. Absent:
> they are not in the room. A say directed at a human who is away or absent
> is a note they read later, not a question they answer now. When no human is
> present, work for the record: state what you decided and why, and do not
> wait for an answer that nobody is there to give.

An agent that knows the room is empty writes differently from one that
thinks somebody is waiting. That difference is the whole return on this
document.

Presence enters an agent's context at activation, with the rest of the
roster. A person who enters while an agent is mid-turn does not appear in
that turn. This is rule 2 of the core, unchanged: working views reset at
idle, and the next activation reads the room as it is then.

---

## 7. What does not change

Four things stay exactly as they are, and each one is a decision.

**Entering does not activate anything.** A visit is not a message. Nobody
wakes, nothing lands on the record, and the room stays quiet. Design
principle 1 holds: there is exactly one way an agent activates, and it is a
message delivered into a session.

**Leaving does not activate anything either**, and neither does turning
away. The host sees it on the stream. The agents see it at their next
activation.

**Routing does not consult presence.** `dispatch` is unchanged. A message
from an away person routes like a message from a present one, because it is
the same message. A `say` directed at a human still wakes nothing — it is an
address for a reader, present or not.

**The record is unchanged.** `Message` keeps its four fields. Enter, leave,
away and return are not messages, because nobody said them.

---

## 8. Observing presence

Four events, one per fact, in the shape the stream already uses:

```ts
type SessionEvent =
  | /* … the nine events of the core, unchanged … */
  | { type: 'visit_enter';  human: string; visit: string; seat: PresenceStatus }
  | { type: 'visit_away';   human: string; visit: string; seat: PresenceStatus }
  | { type: 'visit_return'; human: string; visit: string; seat: PresenceStatus }
  | { type: 'visit_leave';  human: string; visit: string; seat: PresenceStatus };
```

Every event names the attachment that changed and the person's status
afterwards. The two levels are both needed and they disagree: when Andrei's
first tab goes idle and his second is live, `visit_away` fires with
`seat: 'present'`. A host that manages sockets reads `visit`. A host that
renders "who is here" reads `human` and `seat`, and ignores the rest.

The pull side gains one call beside `seats()`:

```ts
export interface VisitInfo {
  id: string;
  human: string;
  status: VisitStatus;
  via?: string;
  enteredAt: string;    // ISO, stamped by the runtime
  lastActedAt: string;  // ISO, stamped by the runtime
}

session.visits(): VisitInfo[];
```

`seats()` answers who belongs and who is here. `visits()` answers how they
are attached. `SeatInfo` becomes a discriminated union, because a human seat
and an agent seat no longer carry the same fields:

```ts
export type SeatInfo =
  | { kind: 'agent'; name: string; identity: string; status: SeatStatus; sessionId: string }
  | { kind: 'human'; name: string; identity: string; presence: PresenceStatus; visits: number };
```

This breaks `seat.status` for callers that read it without narrowing —
`examples/room` is one. The smaller change is a flat `presence?:` field
beside the optional `status?:`, at the cost of a type that lets you ask an
agent for its presence. The union is the better shape and the churn is two
lines.

---

## 9. The change in the code

Nine edits, all in `packages/ambion/src`. The runtime keeps its two
concerns: participants as values, and the session as a room. Presence is
part of the room — who is in it — not a third thing. Ambion still writes no
model loop, no transport, no authentication, and no user store. The host
opens the socket and names the person; the runtime counts and derives.

| File         | Change                                                                         |
| ------------ | ------------------------------------------------------------------------------ |
| `types.ts`   | `VisitStatus`, `PresenceStatus`, `VisitInfo`; `SeatInfo` becomes a union       |
| `types.ts`   | Four `visit_*` events on `SessionEvent`                                        |
| `session.ts` | `VisitRuntime` per attachment; a `Map<string, VisitRuntime[]>` keyed by human  |
| `session.ts` | `enter()`, and `Visit` with `deliver`, `acted`, `leave`                        |
| `session.ts` | `deliver` moves off `Session`; the body is reused, `from` comes from the visit |
| `session.ts` | `seatPresence()` and `visitStatus()` — pure, both read by `seats()`            |
| `session.ts` | One `unref`'d timer per present visit; armed, cleared, re-armed on each act    |
| `session.ts` | `systemPrompt` renders presence in the roster and gains the paragraph in §6    |
| `index.ts`   | Export `Visit`, `VisitInfo`, `VisitStatus`, `PresenceStatus`, `EnterOptions`   |

Hosts migrate in one line each:

```ts
// before
await session.deliver({ from: andrei, text: 'Draft the weekly.' });

// after
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

## 10. What would prove it

One milestone test per claim this document makes loudly, in the style of
`packages/ambion/test/session.test.ts`:

1. A member who has not entered is absent, and an agent can still address
   them.
2. `enter` seats a presence, activates nothing, and leaves no mark on the
   record.
3. Two people enter, both deliver, and the record stamps each from their own
   visit.
4. One person, two visits: one leaves, the seat stays present; the second
   leaves, the seat turns absent.
5. A visit turns away after `idleTimeout` with the clock advanced, and
   `visit_away` carries the seat's status.
6. One of two visits turns away and the seat stays present; both turn away
   and the seat turns away.
7. An away visit delivers, returns to present, and the message routes
   normally.
8. `deliver` and `acted()` on a left visit throw.
9. `leave()` twice is not an error.
10. The roster an agent reads names each human's presence, and an empty room
    says so.

---

## 11. Rejected alternatives

**Presence as messages on the record.** "andrei joined" as a `Message`.
Rejected twice over: the record holds what participants said, and nobody
said it; and every message activates the idle room, so joining would wake
five agents to read a line about a door.

**One `defineHuman` per connection.** Two tabs would be two participants
with two names, and names are unique. The person is one seat. The
attachment is the thing there can be many of.

**Inferring presence from reads.** Treating `messages()` as evidence of
attention. A poller is not a reader, and the runtime cannot tell them apart.
`acted()` puts the claim where the knowledge is.

**A separate `joinSession(name)` beside `openSession(name)`.** Two ways to
reach one room. `enter` on the opened session is enough, and it keeps the
session as the single thing that owns the name.

**A heartbeat protocol in the runtime.** Sockets, pings and timeouts on the
wire are the host's concern. The runtime takes one call — `acted()` — and
asks nothing about how the host learned it.

---

## 12. Open questions

Five decisions this document takes, each of which could go the other way.

1. **Should `idleTimeout` have a default?** The proposal says no: omit it
   and a visit never turns away. A default of ten or fifteen minutes would
   make the common case shorter and the surprising case surprising.

2. **Should a read cursor come with this?** "Enter to review" implies
   unread. `visit.seen(seq)` and `visit.unread()` would mirror the agents'
   own `viewSeq` and cost little. It is left out to keep the proposal to one
   idea, and it is the first candidate to add.

3. **Should a host be able to deliver without a person?** A cron or a
   webhook has no human to enter as. It cannot today either, so nothing
   regresses — but a room that works unattended will want it, and the answer
   is probably a participant kind, not a hole in `enter`.

4. **Does an away person still get directed says?** The proposal says yes,
   unchanged: the message lands on the record and they read it later. The
   alternative is to let an agent see that nobody will answer and choose
   differently, which is what §6 already tells it to do.

5. **`SeatInfo` as a union, or a flat optional field?** The proposal takes
   the union and pays two lines of churn in the example.

---

## 13. Later

Presence is the fact a workspace needs before it can have channels: a
channel with read/write contracts must know who is reading. Two things sit
directly on top of this document and are not in it — the read cursor of
question 2, and per-person notification when an agent addresses somebody who
is away. Both are additions to the visit. Neither changes the core.
