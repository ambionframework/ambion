# Follow-up work

Work this branch decided not to do, and why it is worth doing. Each item says
what it is, what it costs, and where the reasoning already lives. The design
contracts in [`docs/`](docs) hold the open questions about a design; this file
holds the work.

## Steering an exchange from what a person holds

**What.** An assistant's preferences shape one message, and they shape it after
the work is done. The same preferences could aim the room while it works.
Sam never reads contract terms, so three seats spending an activation on
them is money his assistant already knew to save. The rule is deterministic: it
reads what a person holds and what a message is, so the room can run it as
a check, and it costs no activation.

**Why.** The preferences are in one place already
([`docs/assistant.md`](docs/assistant.md) §2), and today they reach the room only at
the close. A person who has said what they act on has said something the
room could use while it is still deciding what to say. It is also the
cheapest of the three rungs in §12: a check costs nothing, and rung 3 pays
for an activation.

**What it needs deciding.**

- **Whether the assistant is the right holder.** A deterministic rule is not a
  seat, and the assistant is a seat. The rule could be a field on the person that
  the room reads when it builds a context, which keeps every invariant below
  intact. The argument for the assistant is that a person's preferences belong in
  one place. The argument against is that a seat that never runs is a
  strange home for a check.
- **Which invariant it touches.** Three hold today: an assistant is seated
  `none`, `handsFor` gives it empty hands outside a close, and `wakes`
  refuses to wake anybody for what an assistant writes. A steer that reaches a
  running seat as a `[new]` line touches the third, because the room would
  carry an assistant's words to a seat that did not ask for them.
- **What it may steer.** Rule 2 says what arrives mid-activation is steered
  in and changes nothing else. A preference that suppresses a line is a
  different act from one that adds one, and only the second is a steer.
- **What a seat is told.** A seat that is aimed and does not know it will
  argue with the room. The paragraph that explains a fold
  (`SUMMARY_PARAGRAPH`) is the precedent.

**Where.** `dispatch` and `handsFor` in
[`session.ts`](packages/ambion/src/session.ts), `wakes` in
[`seat.ts`](packages/ambion/src/seat.ts), the assistant's paragraphs in
[`render.ts`](packages/ambion/src/render.ts).

## Reseating: attention that a running room can change

**What.** A seat's attention is chosen when the agent is seated and never
moves. `session.reseat(name, attention)` would let a host widen or narrow one
while the room runs.

**Why.** Attention is now the whole of what a seating decides
([`docs/agent.md`](docs/agent.md) rule 6): one widening scale, and one
comparison against a message's reach decides who wakes. Everything that reads
it already reads it per activation, so a seat that changes point costs nothing
to route.

It is also what [`docs/assistant.md`](docs/assistant.md) §12's rung 3 wants. An assistant is
a seat at `none`; letting it take part in an exchange is a wider attention and
a `say` in its hands. With reseating that is a host's decision — _this room
lets assistants speak_ — rather than a code change in the runtime.

**What it needs deciding.**

- **A seat mid-activation.** Narrowing a seat that is active must not cancel
  its activation, and widening one must not wake it retroactively for messages it has
  already missed. The likely rule: reseating takes effect at the next
  activation, and the record says nothing about it.
- **Whether it is on the record.** Presence is a message because the room's
  own answers change when somebody is reading. A seat changing attention
  changes who wakes, which every later context already shows in the roster.
  Probably an event and not a message, but that is an argument to have.
- **Who may do it.** A host, certainly. An agent, never — a room where an
  agent can widen its own attention is a room that can make itself expensive.
- **What an assistant holds when something else wakes it.** Nothing, today:
  `handsFor` gives an assistant the `summarise` tool for the activation a close
  woke it
  for, and empty hands otherwise, so a wider attention alone buys a seat that
  reads the room and ends its activation. Rung 3 is a `say` added there on purpose,
  with the paragraph that says when waking somebody's assistant is worth the money.

**Where.** `wakes` in
[`packages/ambion/src/seat.ts`](packages/ambion/src/seat.ts), `Attention` in
[`types.ts`](packages/ambion/src/types.ts), `seated` in
[`define.ts`](packages/ambion/src/define.ts).

## Waking an assistant costs money, and nothing says when it is worth it

Once an assistant is reachable (above), a product can wake one. The runtime's
prompt tells a seat that "attention costs money" for a directed say, and says
nothing about when somebody's assistant is the right participant to ask. Rung 3
without that paragraph is a room that pays for assistants it did not need.

## An assistant in every seat's roster

An assistant is a seat, so it is in the roster every seat reads: measured at about
480 characters of a seat context averaging 3,800 in the example — 13%, spent
describing seats that today cannot be addressed. Most of it is the example
repeating a verbose `identity` three times, so the first fix is in
[`examples/site/src/workspace.ts`](examples/site/src/workspace.ts) rather than
in the runtime. Worth re-measuring once assistants speak.

## A test for the owed-summary merge

`Assistants.owe` merges a person's owed range with `Math.min`, so somebody owed a
summary from a failed activation who asks again gets one message covering
both
exchanges. Nothing pins that behaviour; the tests cover the failure and the
retry separately. See [`docs/assistant.md`](docs/assistant.md) §5.

## Exchanges are run state

`Exchanges` holds the open exchange in memory, so a restart begins with none —
right for a room mid-question, and a limit for anything that wants to work
over past exchanges. A closed exchange is an owner and a range, so it is
derivable from the record; nothing derives it today. See
[`docs/agent.md`](docs/agent.md), _The exchange_.

## A second non-seat writer

The room owes summaries through a small scheduler: `owe`, `activationsDue`
and `activationEnded`, held by `Assistants`. If a room-level compactor ever arrives
([`docs/assistant.md`](docs/assistant.md) §16 forbids it by name today), it wants the
same scheduler. Two writers is the point at which it should become its own
thing rather than three fields on the session.
