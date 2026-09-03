# The roster

This document is the design contract for the roster while a room runs: the
agents a session starts with, the agents it holds in reserve, and the
assistant that seats them. It is not shipped. This branch implements it,
and the code will live with the rest of the runtime in
[`packages/ambion/src`](../packages/ambion/src): the seating and the
reserve in [`session.ts`](../packages/ambion/src/session.ts), the composing
activation in [`assistant.ts`](../packages/ambion/src/assistant.ts), and
the shapes in [`types.ts`](../packages/ambion/src/types.ts). Read
[`agent.md`](agent.md), [`exchange.md`](exchange.md),
[`presence.md`](presence.md) and [`assistant.md`](assistant.md) first. This
document changes two rules of the core and says which.

One sentence:

> **A room starts with an assistant, any number of agents seated, and any
> number held in reserve. When a person's question opens an exchange, the
> assistant reads the question and the reserve, and seats the agents the
> question needs. Seating is a message on the record. The seated agent
> wakes, reads the room as it stands, and takes its turn beside the agents
> already working.**

---

## 1. Composition, at start and after

`startSession` takes the room's composition:

```ts
const session = startSession({
  name: 'site',
  goal: 'Run the site office.',
  assistant,
  agents: [timeTracker, passive(inspector)], // optional: seated now
  available: [quantitySurveyor, seated(architect, 'named')], // optional: the reserve
});
```

**`assistant` is required, and it is the only participant a room needs.**
`agents` and `available` are both optional and may both be empty. A room
that names no agents and a reserve holds the assistant alone until a
question lands, and then holds whoever that question needed. A room that
names neither holds the assistant and nothing that can answer; §6 says
what happens to a question there.

**`agents` are seated when the room starts, and they stay seated for the
run**, as [`agent.md`](agent.md) §5 specifies. Nothing in this document
unseats one of them but the host (§5).

**`available` is the reserve: agents the room may seat later.** Both lists
hold `AgentSeat` values, so a reserve entry carries an attention the same
way a seated one does, and takes `broadcast` when it names none. The room
refuses a name that appears in both lists, or in either list and the
assistant, the way it refuses any duplicate name. The identity rule in
`agent.md` §5 reads the same with one more clause: the run belongs to
`startSession`, and its composition is the assistant, the agents seated,
and the agents in reserve.

**Neither list knows anything about a workspace.** Each definition names
its own workspace or none ([`workspace.md`](workspace.md) §3), and the
room never reads the field. One reserve may hold agents from several
workspaces beside agents with no workspace, and a room still connects to
no workspace of its own.

---

## 2. The reserve: what the assistant seats from

**The reserve is a list the host wrote.** Every participant reaches a room
as a value the host passed, and the reserve is no exception. Nothing
discovers agents: an agent is in the reserve because `startSession` was
handed it, and for no other reason.

**The reserve is what `available` holds and the roster does not.** An
agent the assistant seats leaves the reserve for the roster. An agent the
host unseats (§5) returns to it. The room reads the reserve fresh at every
open (§4), so it holds whatever is not seated at that moment.

**The assistant reads the reserve in its context, as a second roster.**
The composing activation (§4) renders the reserve the way every activation
renders the seats: one line per agent, its name and its identity. The
assistant reads what each agent is for and decides which of them the
question needs. It reads definitions and nothing else.

**A seat reads the roster and never the reserve.** An agent at work sees
who is seated, and a colleague it wants that is not seated is a colleague
it cannot call in. The assistant reads the reserve once per exchange, at
the open, and nobody else reads it at all. That keeps the paragraph every
seat reads at its current length, and keeps the decision to spend a seat
in one place.

**Why the reserve is the whole bound.** The assistant cannot define an
agent. A definition is a value a team owns, with its instructions, model,
tools and evals, and that ownership is the project's thesis. The assistant
chooses among definitions somebody wrote and passed in. The host decides
what may ever be in the room by deciding what `available` holds. An empty
reserve means the assistant is never woken at an open, and the room pays
nothing for composition.

---

## 3. Seating is a presence message

**A colleague joining is a thing that happened in the room that the other
participants want to know.** That is what a message is
([`presence.md`](presence.md) §5), so the record's presence kind grows from
two changes to four:

```ts
type PresenceChange = 'arrived' | 'left' | 'seated' | 'unseated';

interface PresenceMessage {
  kind: PresenceChange;
  seq: Seq;
  at: string;
  /** The participant whose presence changed: a person, or the agent. */
  from: string;
  /** How the room knows them, on `arrived` and `seated` alone. */
  identity?: string;
  /** The assistant, when it did the seating. Absent when the host did. */
  by?: string;
}
```

`from` is the agent whose presence changed, the way `arrived` carries the
person. `identity` rides on `seated` as it rides on `arrived`, so a later
reader of the record knows who was in the room. `by` names the assistant
when the assistant seated the agent.

**Every rule of the core applies to a seating unchanged**, and this is the
reason for the shape:

- **Rule 1.** A seating is a message, and the message activates the idle
  room through the one mechanism. Nothing is special-cased.
- **Rule 2.** A seat already at work hears `[new] · inspector seated` at
  its next safe point, and can direct its next say at the newcomer. The
  room changes before the message does, as with a visit: the seat is in the
  roster before its `seated` commits, so every seat the message reaches
  reads a roster that agrees with it.
- **Rule 5.** A say drafted at a colleague who was unseated in the meantime
  is refused, and the refusal shows the departure. The lock covers roster
  races with no new code.
- **Rule 6.** A seating has the reach of a presence message. A bare seat at
  `broadcast` is too narrow, so a colleague joining wakes nobody by
  default, for the reason [`presence.md`](presence.md) §5 gives for an
  arrival: a seating has no words in it. A seat at `presence` wakes.
- **Rule 7.** `from` and `by` are stamped by the runtime from the seating
  it performed. Nobody claims either.

**Two rules of the core change, and both concern who a message names.**

**Author and subject are different names.** For every kind the record held
before this document, the participant a message is about is the one who
wrote it, so `dispatch` excludes `message.from` from the routing and that
is the author. A seating is the first message where the two differ: the
author is `by`, and the subject is `from`. So the author is what `dispatch`
excludes, and the subject is who a seating names.

**A named seat wakes, however narrowly it is seated.** Rule 4 already says
this for a directed say: the one it names wakes, at any attention. A
seating names the seat it seats, and that seat wakes the same way. It is
the newcomer's first activation, and the reason to seat it during an
exchange. The routing in `wakes` reads as three lines:

1. What the assistant writes wakes nobody, with one exception: the subject
   of a `seated` the assistant wrote.
2. A seat that a message names wakes.
3. Everybody else wakes by reach, against their attention.

Line 1 is [`assistant.md`](assistant.md) §11's guard with its one
exception written into it. The assistant can cause exactly one activation:
the seat it seated, from the reserve the host attached, and nobody else.

---

## 4. The composing activation

**The open of an exchange wakes the assistant, when the reserve holds
anybody.** The close already wakes it, and the runtime hands it one tool,
`summarise`, bound to a range ([`assistant.md`](assistant.md) §14). The
open wakes it the same way, and the runtime hands it one tool, `seat`,
bound to the reserve. The assistant bookends the exchange: it composes the
room at the open and consolidates what the room said at the close.

The order inside `publish` is what makes it parallel. A question lands, the
room opens the exchange and activates the assistant, then it routes the
question and activates the seats. The assistant reads the question while
the seats do.

**What the assistant is handed.** The same context every seat reads, and
two things more: the reserve (§2) as a second roster, and the ask at the
end, which names the person and the seq of their question, and asks the
assistant to seat who the question needs or to end its turn. The
activation is one pass, as a summarising activation is: it does not
rebuild when the room moves, because what it decides is who to seat, and
the record as it stood at the question is what that turns on.

**What `seat` does.** It takes a name from the reserve, and it is refused a
name that is not there. It moves the entry from the reserve to the roster,
at the attention the entry carries, then commits the `seated` message under
the same lock a say commits under, with `by` stamped as the assistant. The message routes as
§3 says. The tool bounds its activation the way `summarise` bounds one:
after a small fixed number of seatings it ends the activation itself, with
Pi's `terminate`, so a model that keeps calling it cannot fill the room.

**A composing activation is the room working.** `settled()` reports that
no seat that speaks for itself is taking an activation, and the assistant
writing a summary is left out of that count so a close cannot hold open the
exchange it is closing ([`exchange.md`](exchange.md) §6). A composing
activation is different: it is part of the exchange's work, and the count
includes it. Without this the seats can all decline in seconds, the room
settles, and the assistant seats a colleague into an exchange that has
closed. With it, the exchange stays open until the assistant has decided,
the newcomer wakes inside it, and the summary written at the close covers
what the newcomer said.

So the room draws one distinction about its assistant: a drafting
activation is outside `working()`, a composing activation is inside it. The
end of any activation then runs one check: if nothing is working, the room
settles and the exchange closes. If the assistant stopped and something is
still working, the room checks whether it owes a draft, as it does today.

**A question that lands while the assistant drafts a summary gets no
composing activation.** The seat is taken, and the compose is skipped
rather than queued. A queued compose would land into a room that may have
settled. The roster stands as it is for that exchange, and the next
question composes again. This is the same guard `Assistant.pick` applies
to a draft: one seat, one activation.

**What the newcomer reads.** Every activation rebuilds the seat's context
from the record as it stands ([`agent.md`](agent.md) rule 2), so a
newcomer needs nothing built for it. Its first activation reads the roster
it is now on, the people, and the record folded by every summary written
before it, with the question that opened the exchange and every reply so
far in full. Its own `seated` line sits on the record where it came in,
and the ask at the end names the open exchange and the seq of its
question, so the seat knows what it was seated for.

**What a seating costs.** One activation of the assistant per exchange
while the reserve holds anybody, and one activation of each seated agent.
Both are paid on purpose, the way a directed say is
([`agent.md`](agent.md) rule 4), and both are on the record.

---

## 5. What the host may do

Two verbs on `Session`, and the assistant's tool is a thin binding over the
first:

```ts
session.seat(inspector); // or seated(inspector, 'named')
session.unseat(inspector);
```

**`seat` puts an agent on the roster, from the reserve or from anywhere.**
The host may seat a value the reserve never held. The room refuses a name
it already holds, and refuses the room's assistant. The `seated` message
commits with no `by`, and it wakes the seat it names as §3 says.

**`unseat` takes an agent off the roster, and the host alone may call
it.** It aborts the activation in flight, if any, with Pi's own abort, the
way `abort()` does for the whole room. It takes the seat off the roster,
then commits `unseated`. An agent that came from the reserve returns to it.
An agent seated at start may be unseated too, and the record says so.
Unseating is the direction the room cannot take back, so the assistant
holds no tool for it. [`FOLLOW_WORK.md`](../FOLLOW_WORK.md) holds the
argument for giving it one.

**`stop` unseats what the run added.** `stopSession` commits `left` for
every person present ([`presence.md`](presence.md) §8). It commits
`unseated`, in the same way and without routing, for every seat the run
added after it started. The next run begins from the composition
`startSession` was given, and the record says who was seated in between.

**A seat that leaves keeps its downstream session.** Rule 8 puts every
activation's turns in `<room>:<agent>`. An agent seated, unseated and
seated again reopens the same session, so what it did is auditable across
the gap.

---

## 6. An exchange that wakes nobody closes at once

A question opens an exchange, and quiescence closes it
([`exchange.md`](exchange.md) §3). Quiescence is a seat stopping. A question
that wakes no seat has no seat to stop, and the exchange would stay open
until something unrelated activated and ended.

This case exists today, in a room where every seat is `named` and a
question is undirected. It is common once a room may start with the
assistant alone and an empty reserve. So `publish` runs the same check the end
of an activation runs: after routing, if nothing is working, the room
settles and the exchange closes. The exchange holds one message, the
question, and the assistant writes nothing for it, because an exchange the
agents said nothing into writes nothing ([`assistant.md`](assistant.md)
§4). The host hears `exchange_opened`, `exchange_closed` and `quiet`, in
that order, and the person hears that nobody was there to answer through
the record.

---

## 7. Boundaries

Each boundary is stated so a later change has to argue with it.

- **The assistant composes and consolidates, and never speaks in the
  room.** It holds `seat` at the open and `summarise` at the close, and no
  `say` at any time. [`assistant.md`](assistant.md) §12 states the rule.
- **The assistant never unseats.** §5.
- **The assistant never defines an agent.** It seats from the reserve, and
  the host decides what is in it by writing `available`. §2.
- **A seat never reads the reserve.** §2.
- **A seating is on the record, and the starting composition is not.** The
  record holds what happened in the run. What the run started with is the
  run's, as `agent.md` §5 says of the roster and `presence.md` says of the
  people.
- **The threshold reads the record.** The rule that a summary is written
  when the agents said more than one thing counts messages from any name
  that is not a person and not the assistant, so an agent that spoke and
  was unseated before the close still counts. Today the count reads the
  live roster, and this document changes that.
- **The reserve knows no workspace.** Each agent in it names its own or
  none, and the room reads neither. §1.

---

## 8. What proves it

The milestone tests will live in
[`roster.test.ts`](../packages/ambion/test/roster.test.ts), one per claim
this document makes loudly:

- a room starts with the assistant alone, and a question into it opens and
  closes an exchange with nobody woken (§1, §6);
- the reserve is what `available` holds, an agent seated from it leaves
  it, an unseated one returns to it, and a name in both lists is refused
  (§1, §2);
- the composing activation reads the reserve and holds `seat` alone, and a
  seating lands as a message stamped `by` the assistant (§3, §4);
- a seating wakes the seat it names and nobody at `broadcast`, and a seat
  at `presence` wakes too (§3);
- a seat already at work is steered by the seating and can direct a say at
  the newcomer (§3);
- the exchange stays open through the composing activation, and the
  summary written at the close covers what the newcomer said (§4);
- a question that lands while the assistant drafts gets no composing
  activation, and the next question does (§4);
- the tool refuses a name outside the reserve, and ends the activation
  after the cap (§4);
- the host seats and unseats by hand, an unseat aborts the activation in
  flight, and a say directed at the unseated colleague is refused with the
  departure (§5);
- `stop` unseats what the run added and leaves the starting composition
  alone (§5);
- the threshold counts an agent that spoke and was unseated (§7).

All in-process, in vitest, on a scripted stream.
