# Follow-up work

Work this branch decided not to do, and why it is worth doing. Each item says
what it is, what it costs, and where the reasoning already lives. The design
contracts in [`docs/`](docs) hold the open questions about a design; this file
holds the work.

## Reseating: attention that a running room can change

**What.** A seat's attention is chosen when the agent is seated and never
moves. `session.reseat(name, attention)` would let a host widen or narrow one
while the room runs.

**Why.** Attention is now the whole of what a seating decides
([`docs/agent.md`](docs/agent.md) rule 6): one widening scale, and one
comparison against a message's reach decides who wakes. Everything that reads
it already reads it per activation, so a seat that changes point costs nothing
to route.

It is also what [`docs/aide.md`](docs/aide.md) §12's rung 3 wants. An aide is
a seat at `none`; letting it take part in an exchange is a wider attention and
a `say` in its hands. With reseating that is a host's decision — _this room
lets aides speak_ — rather than a code change in the runtime.

**What it needs deciding.**

- **A seat mid-turn.** Narrowing a seat that is active must not cancel its
  turn, and widening one must not wake it retroactively for messages it has
  already missed. The likely rule: reseating takes effect at the next
  activation, and the record says nothing about it.
- **Whether it is on the record.** Presence is a message because the room's
  own answers change when somebody is reading. A seat changing attention
  changes who wakes, which every later context already shows in the roster.
  Probably an event and not a message, but that is an argument to have.
- **Who may do it.** A host, certainly. An agent, never — a room where an
  agent can widen its own attention is a room that can make itself expensive.
- **What an aide holds when something else wakes it.** Nothing, today:
  `handsFor` gives an aide the `summarise` tool for the turn a close woke it
  for, and empty hands otherwise, so a wider attention alone buys a seat that
  reads the room and ends its turn. Rung 3 is a `say` added there on purpose,
  with the paragraph that says when waking somebody's aide is worth the money.

**Where.** `Attention` and `wakes` in
[`packages/ambion/src/session.ts`](packages/ambion/src/session.ts), `seated`
in [`define.ts`](packages/ambion/src/define.ts).

## Waking an aide costs money, and nothing says when it is worth it

Once an aide is reachable (above), a product can wake one. The runtime's
prompt tells a seat that "attention costs money" for a directed say, and says
nothing about when somebody's aide is the right participant to ask. Rung 3
without that paragraph is a room that pays for aides it did not need.

## An aide in every seat's roster

An aide is a seat, so it is in the roster every seat reads: measured at about
480 characters of a seat context averaging 3,800 in the example — 13%, spent
describing seats that today cannot be addressed. Most of it is the example
repeating a verbose `identity` three times, so the first fix is in
[`examples/site/src/workspace.ts`](examples/site/src/workspace.ts) rather than
in the runtime. Worth re-measuring once aides speak.

## A test for the owed-summary merge

`oweSummary` merges a person's owed range with `Math.min`, so somebody owed a
summary from a failed turn who asks again gets one message covering both
exchanges. Nothing pins that behaviour; the tests cover the failure and the
retry separately. See [`docs/aide.md`](docs/aide.md) §5.

## Exchanges are run state

`Exchanges` holds the open exchange in memory, so a restart begins with none —
right for a room mid-question, and a limit for anything that wants to work
over past exchanges. A closed exchange is an owner and a range, so it is
derivable from the record; nothing derives it today. See
[`docs/agent.md`](docs/agent.md), _The exchange_.

## A second non-seat writer

The room owes summaries through a small scheduler: `owed`, `wakeAide`,
`closedTurn`. If a room-level compactor ever arrives
([`docs/aide.md`](docs/aide.md) §16 forbids it by name today), it wants the
same scheduler. Two writers is the point at which it should become its own
thing rather than three fields on the session.
