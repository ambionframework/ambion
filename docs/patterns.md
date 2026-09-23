# Patterns

This page reads the room's primitives against the patterns people use to
work together. It adds no mechanism. Each row links the page that owns the
mechanism. The [repository README](../README.md) holds the positioning.

## The patterns

| Pattern                             | Primitives                                                             | How the room represents it                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Ask and get an answer               | [Exchange](exchange.md), close, optional [summary](summary.md)         | A question opens an exchange. Quiescence closes it. The closed view carries the outcome.             |
| Ongoing room over days              | [Visits](presence.md), presence, catch-up, resume                      | `lastDeparture` and `room.read({ messages: { since } })` catch a returning person up.                |
| Broadcast, no reply owed            | A said message                                                         | Seats may stay silent. No reply is owed.                                                             |
| Bring in a specialist               | [Reserve](roster.md), `seat`, `say({ to })`                            | An agent seats a reserve member and addresses it by name.                                            |
| Steer work in progress              | [Steer](exchange.md#3-three-rules) between provider requests           | A message that lands in an open exchange steers each eligible active seat.                           |
| Two people in one discussion        | The open exchange, `summaries`, `purpose.people`                       | A second question joins the open exchange. The room assigns one summary to each person who spoke.    |
| Waiting on a person                 | The `awaiting` outcome, `pendingFor`                                   | The closed exchange reads `awaiting` with the `person`. `pendingFor` lists what waits on one person. |
| Approve before an agent acts        | `say({ to })` a person, the `awaiting` outcome                         | The directed question is the request. The `awaiting` outcome is the wait. No entry kind is new.      |
| Stop one agent, keep the room       | `room.unseat`, the `unseat` tool, [fixed seats](roster.md#fixed-seats) | The seat leaves and the room continues. See below.                                                   |
| Consult privately                   | Every message is visible to every seat                                 | A second room, by reference. The room has no private channel.                                        |
| Delegate to a working group         | None in the kernel                                                     | Not built. The backlog holds it.                                                                     |
| Vote, sign off, structured decision | Application tools and artifacts                                        | Outside the kernel by design. A tool can write the record of the decision.                           |
| Scheduled check-in                  | None in the kernel                                                     | Not built. Timers are backlog work.                                                                  |

## Two people in one discussion

**A second question joins the open exchange.** The owner stays the person
whose question opened it. The room does not open a second exchange.

**Each person who spoke gets a summary.** The closed exchange view carries
`summaries`. Summary owns the assignment rules; see
[the closing activation](summary.md#closing-activation). The tests are in
`summary.test.ts`.

## Waiting on a person

**`awaiting` differs from `complete`.** A closed exchange that still waits
on a person reads `awaiting` and carries the `person`. Exchange owns the
derivation and the clearing; see
[the outcome contract](exchange.md#6-the-edges-a-host-sees).

**`pendingFor` lists the waits.** `pendingFor(read, person)` and
`room.pendingFor(person)` return the closed exchanges that await one person.
Both are detached reads. The room derives the outcome from the record, so a
resumed room reads the same answer. The tests are in `exchange-outcome.test.ts`.

## Approve before an agent acts

**The directed question is the approval request.** An agent asks a person
with `say({ to })` and ends its activation. The exchange closes and reads
`awaiting`. `pendingFor` shows the request to that person. The person must
differ from the exchange owner. A message to the owner answers the owner's
question, so the exchange reads `complete`. See
[exchange outcomes](exchange.md#6-the-edges-a-host-sees).

**The person's reply is the approval.** A message from the person clears
`awaiting` and lets the agent act in a later activation. The record holds the
request and the reply in order. The kernel enforces no gate. An agent that
acts without asking is a matter for its tools and its definition.

## Stop one agent, keep the room

**`unseat` removes one seat.** An agent calls the `unseat` tool. The host
calls `room.unseat(name)`. Pending work for the seat settles under the
recorded lease rules, and the room continues with the other seats.

**A fixed seat resists the tool.** An agent cannot unseat a fixed seat. The
host always can. The definition stays in the reserve, so a later `seat`
brings the agent back. See [membership](roster.md#membership-operations).
