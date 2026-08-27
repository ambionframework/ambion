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
that one of them closed the tab, and it cannot tell the room that the last
one left.

The proposal takes people out of `openSession` and gives them a verb.

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

Reading stays on the session. `messages()`, `seats()` and `subscribe()`
answer whether or not anybody is present, because a host renders an
unattended room the same way it renders one with three people in it.
Reviewing is not acting, and a dashboard is not a visitor.

Anybody may enter. There is no guest list, because there is no longer a
place to put one — and the room does not need it. The host authenticates
the person and vouches for the name and identity it passes; Ambion never
sees a credential and adds no user store. `enter` refuses exactly one
thing: a name an agent already holds, because the room addresses
participants by name and two claimants make `say({ to })` ambiguous. It is
the same refusal `openSession` already makes, at the moment the second
claim arrives.

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

`deliver` and `acted()` on a visit that left throw. A handle to a finished
visit is a stale handle, and the runtime says so rather than accepting a
message from a person who is gone.

Two visits by one name are the same person. A second `enter` with the same
name and the same identity attaches another visit to that person. A second
`enter` with the same name and a different identity is refused: one name is
one identity for the life of the opening, and the alternative is a roster
that changes under the agents reading it.

---

## 5. Presence, and the names a room learns

A visit has two states. A person has three.

```ts
export type VisitStatus = 'present' | 'away';
export type PresenceStatus = VisitStatus | 'absent';
```

- **present** — they acted within the timeout. They are reading.
- **away** — they are attached and have not acted for longer than the
  timeout. They read this later.
- **absent** — they entered this session at some point and hold no live
  visit now. They are not in the room.

A person's presence derives from their visits, and the rule is one
sentence:

> Somebody is **present** if any of their visits is present, **away** if
> they have visits and all of them are away, and **absent** if they have
> none.

That rule is what "tracked correctly" means. Six cases follow from it, and
the proposal claims all six:

1. Two visits, one leaves — the person stays present.
2. The last visit leaves — the person turns absent.
3. One visit turns away, another is present — the person stays present.
4. Every visit turns away — the person turns away.
5. An away visit delivers — that visit returns to present, and so does the
   person. Delivering is acting.
6. A person who left is still addressable. A `say` directed at them lands on
   the record and waits; they read it when they come back.

Case 6 needs one mechanic, and it is the only one this section adds:
**the room learns a name when somebody enters, and does not forget it while
the room is open.** Without it, an agent that reads `andrei (human,
present)` in its roster and calls `say({ to: 'andrei' })` two seconds later
would fail because Andrei closed his laptop in between. With it, the say
lands, addressed, and waits. The known names bound at the number of people
who have actually visited, which is a small number of real people.

Reopening the name is a new opening. The record comes back and the room is
empty — nobody is present, and nobody is absent either, because the room has
learned no names yet. Messages on the record still carry the `to` they were
stamped with. This is the core's own rule, unchanged: the record belongs to
the name, and the seats belong to the opening.

Presence itself is live. It is not on the record and it does not survive the
process, because presence is an attachment to a running session and a
session that is not running has nobody in it. The transitions are still
auditable: each one lands in the room's own Pi session as a custom entry,
`ambion/presence`, the way each activation already lands in a seat's session
as `ambion/activation`. It is a trail for review, not part of `messages()`.
The record holds what was said.

---

## 6. The inactivity timeout

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

## 7. What agents see

This is where the addition earns its place. Presence is not host
bookkeeping; it is context, and it changes what an agent does.

The roster is the agents, always, and the people the room has learned:

```
The roster (active: taking a turn now; idle: hears every message; passive: hears
only a say directed at them):
- lead (idle): Tech lead. Owns feasibility, estimates, and sequencing.
- designer (idle): Product designer. Guards the user experience.
- planner (passive): Project manager. Keeps the plan of record.

In the room now:
- andrei (present): Founder. Owns the weekly. Bring him blockers, not status.
- mara (away): Design lead. Decides on the experience.
```

Two lists, because they are two facts. The agents are the room's
composition and never move. The people change between one activation and
the next, and an agent that reads them in a separate list reads the change
as a change. When the second list is empty the prompt says so plainly:
`Nobody is in the room.`

The system prompt gains one paragraph:

> The second list is the people in the room and how they are reading.
> Present: they are here now. Away: they are here and have not acted
> recently. Absent: they were here and left. A say directed at somebody who
> is away or absent is a note they read later, not a question they answer
> now. When nobody is in the room, work for the record: state what you
> decided and why, and do not wait for an answer that nobody is there to
> give.

An agent that knows the room is empty writes differently from one that
thinks somebody is waiting. That difference is the return on this document.

Presence enters an agent's context at activation, with the rest of the
roster. A person who enters while an agent is mid-turn does not appear in
that turn. This is rule 2 of the core, unchanged: working views reset at
idle, and the next activation reads the room as it is then.

---

## 8. What does not change

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
the same message. A `say` directed at a person still wakes nothing — it is
an address for a reader, present or not.

**The record is unchanged.** `Message` keeps its four fields. Enter, leave,
away and return are not messages, because nobody said them.

---

## 9. Observing presence

Four events, one per fact, in the shape the stream already uses:

```ts
type SessionEvent =
  | /* … the nine events of the core, unchanged … */
  | { type: 'visit_enter';  human: string; visit: string; presence: PresenceStatus }
  | { type: 'visit_away';   human: string; visit: string; presence: PresenceStatus }
  | { type: 'visit_return'; human: string; visit: string; presence: PresenceStatus }
  | { type: 'visit_leave';  human: string; visit: string; presence: PresenceStatus };
```

Every event names the attachment that changed and the person's status
afterwards. The two levels are both needed and they disagree: when Andrei's
first tab goes idle and his second is live, `visit_away` fires with
`presence: 'present'`. A host that manages sockets reads `visit`. A host
that renders "who is here" reads `human` and `presence`, and ignores the
rest.

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

`seats()` answers who is in the room. `visits()` answers how they are
attached. `SeatInfo` becomes a discriminated union, because an agent seat
and a person no longer carry the same fields:

```ts
export type SeatInfo =
  | { kind: 'agent'; name: string; identity: string; status: SeatStatus; sessionId: string }
  | { kind: 'human'; name: string; identity: string; presence: PresenceStatus; visits: number };
```

This breaks `seat.status` for callers that read it without narrowing —
`examples/room` is one, and it is two lines.

---

## 10. What this changes in the contract

`docs/agent.md` is the contract for shipped code, and three parts of it stop
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

**§5, rule 7, "Identity is injected."** "Every agent's context carries the
roster — each participant's name, kind, identity and status." It carries two
lists now, and the second one varies between activations of the same room.
The rule's other half — provenance is stamped, never self-reported — gets
stronger, not weaker: `from` now comes from a live visit instead of a handle
the caller chose.

Rules 1 through 6 and rule 8 are untouched. So is every one of the eleven
tests in `packages/ambion/test/session.test.ts`, except where they call
`deliver`.

---

## 11. The change in the code

Ten edits, all in `packages/ambion/src`. The runtime keeps its two
concerns: participants as values, and the session as a room. Presence is
part of the room — who is in it — not a third thing. Ambion still writes no
model loop, no transport, no authentication, and no user store. The host
opens the socket and names the person; the runtime counts and derives.

| File         | Change                                                                         |
| ------------ | ------------------------------------------------------------------------------ |
| `define.ts`  | `defineHuman` unchanged; its doc comment stops calling the value a participant |
| `types.ts`   | `AgentSeat`; `Participant` narrows to agent-or-human                           |
| `types.ts`   | `VisitStatus`, `PresenceStatus`, `VisitInfo`; `SeatInfo` becomes a union       |
| `types.ts`   | Four `visit_*` events on `SessionEvent`                                        |
| `session.ts` | `participants` becomes `agents`; `seat()` drops its human branch               |
| `session.ts` | `VisitRuntime` per attachment; `Map<string, VisitRuntime[]>` keyed by name     |
| `session.ts` | `enter()`, and `Visit` with `deliver`, `acted`, `leave`                        |
| `session.ts` | `deliver` moves off `Session`; the body is reused, `from` comes from the visit |
| `session.ts` | `presenceOf()` and `visitStatus()` — pure, both read by `seats()`              |
| `session.ts` | One `unref`'d timer per present visit; armed, cleared, re-armed on each act    |
| `session.ts` | `systemPrompt` renders the two lists and gains the paragraph in §7             |
| `index.ts`   | Export `Visit`, `VisitInfo`, `VisitStatus`, `PresenceStatus`, `EnterOptions`   |

`dispatch` and `sayTool` need no change at all. `dispatch` reads the agent
map, which people never enter. `sayTool` validates `to` against the agent
map and the people map, and the people map is now filled by `enter` instead
of by `openSession` — the same lookup against a differently filled map.

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

## 12. What would prove it

One milestone test per claim this document makes loudly, in the style of
`packages/ambion/test/session.test.ts`:

1. A room of agents alone opens, runs a full exchange, and settles with
   nobody present.
2. `enter` puts a person in the room, activates nothing, and leaves no mark
   on the record.
3. Two people enter, both deliver, and the record stamps each from their own
   visit.
4. One person, two visits: one leaves and the person stays present; the
   second leaves and the person turns absent.
5. A visit turns away after `idleTimeout` with the clock advanced, and
   `visit_away` carries the person's status.
6. One of two visits turns away and the person stays present; both turn away
   and the person turns away.
7. An away visit delivers, returns to present, and the message routes
   normally.
8. A person leaves, and an agent's directed `say` still lands on the record
   addressed to them.
9. `deliver` and `acted()` on a left visit throw; `leave()` twice does not.
10. `enter` refuses a name an agent holds, and refuses a second identity for
    a name already in the room.
11. The roster an agent reads carries both lists, and an empty room says so.

---

## 13. Rejected alternatives

**A guest list of people at open time.** `openSession({ agents, humans })`:
the people who may enter, declared, with presence layered on top. It buys
one thing — an agent may address somebody who has never visited — and costs
the lifetime distinction this whole document is about, by putting two kinds
of member in one call again. The room learning names on entry (§5) recovers
most of what the guest list bought.

**Presence as messages on the record.** "andrei joined" as a `Message`.
Rejected twice over: the record holds what participants said, and nobody
said it; and every message activates the idle room, so joining would wake
four agents to read a line about a door.

**One `defineHuman` per connection.** Two tabs would be two people with two
names. The person is one name. The attachment is the thing there can be many
of.

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

## 14. Open questions

Five decisions this document takes, each of which could go the other way.

1. **Does the room forget?** §5 says a room never forgets a name while it is
   open, so a `say` to somebody who left still lands. The alternative is to
   forget on the last leave and refuse the say, which makes the roster
   smaller and the mid-turn race real.

2. **Should `idleTimeout` have a default?** The proposal says no: omit it and
   a visit never turns away. A default of ten or fifteen minutes would make
   the common case shorter and the surprising case surprising.

3. **Should a read cursor come with this?** "Enter to review" implies
   unread. `visit.seen(seq)` and `visit.unread()` would mirror the agents'
   own `viewSeq` and cost little. It is left out to keep the proposal to one
   idea, and it is the first candidate to add.

4. **Should a host be able to deliver without a person?** A cron or a webhook
   has nobody to enter as, and after this change there is nothing but agents
   at open time. It cannot deliver today either, so nothing regresses — but
   an unattended room will want it, and the answer is probably a third kind
   of definition, not a hole in `enter`.

5. **`agents`, or keep the name `participants`?** The proposal renames the
   field, because it now holds one kind of thing and the old name says
   otherwise. Keeping `participants` costs nothing at the call site and one
   sentence of explanation forever.

---

## 15. Later

Presence is the fact a workspace needs before it can have channels: a
channel with read/write contracts must know who is reading. Two things sit
directly on top of this document and are not in it — the read cursor of
question 3, and notifying somebody an agent addressed while they were away.
Both are additions to the visit. Neither changes the core.
