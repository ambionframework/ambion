# Demos

These are dated reports of live runs, kept as a history of building this
library. They are not a showcase of the current state.

Each file captures one run: what the agents did, what it cost, and what the
run established about a design decision. A report belongs to the day it ran
and to the code that ran it. **Do not update a report to match later code.**
When a design change needs a new measurement, run it again and add a new
file. An old report that describes an API which no longer exists is doing its
job — it shows what the design was before the change, and why the change
happened.

Every report is generated output. A script writes the HTML from the run's
JSON. Nobody edits the numbers by hand.

Name a file `YYYY-MM-DD-<slug>.html`, where the slug names what the run
showed. Two runs on one day then get two names that a reader can tell apart.

## The runs

| Date       | Report                                                           | Model      | Published                                                                        |
| ---------- | ---------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| 2026-08-26 | [The Room, Verbatim](2026-08-26-the-room-verbatim.html)          | sonnet-4-5 | [artifact](https://claude.ai/code/artifact/bb9a4ec2-2f2d-4ee0-8803-182e2bbc5797) |
| 2026-08-28 | [Who Was In The Room](2026-08-28-who-was-in-the-room.html)       | opus-5     | [artifact](https://claude.ai/code/artifact/6fcfe1ab-8b3e-4359-a3ae-720f8ca778d9) |
| 2026-08-28 | [Four Apps, One Site](2026-08-28-four-apps-one-site.html)        | opus-5     | —                                                                                |
| 2026-08-28 | [An Arrival Only Steers](2026-08-28-an-arrival-only-steers.html) | opus-5     | —                                                                                |
| 2026-08-28 | [Three Apps, One Site](2026-08-28-three-apps-one-site.html)      | sonnet-5   | [artifact](https://claude.ai/code/artifact/e170799d-5176-491f-a887-9bde86f0ac02) |
| 2026-08-28 | [One Person, One Visit](2026-08-28-one-person-one-visit.html)    | sonnet-5   | —                                                                                |

## What each run changed

**The Room, Verbatim.** The first live run of the core, before presence
existed. Five agents and one person, every turn shown in full. The person is a
participant here, seated with the agents — which is what all the later work
changed. It proved the say lock in the open: of the 32 says the agents
attempted, 13 were refused because the record moved while the seat was
drafting. The lock is what keeps a room of agents from all answering the same
question.

**Who Was In The Room.** The first run with presence. Two people arrive and
leave in a five-agent room, and 8 of the 43 messages on the record are
presence messages. It showed that an arrival wakes a room that nobody spoke
to, and that an agent can read the catch-up anchor and tell a returning person
the one thing they missed. It also showed the cost: 57 activations for 33
says, and 40 says refused by the lock.

**Four Apps, One Site.** The scenario moved to a construction suite, where
each product is an agent with its own API and three people want different
things. Four products: a time tracker, a task list, a materials tracker and a
knowledge base. It established that a product answers out of its own data and
asks a colleague on the record for anything else. It also showed that the
knowledge base had no data of its own to defend, which is why the next run
dropped it.

**An Arrival Only Steers.** The run that measured what waking on an arrival
costs. Three products, all of them waking when somebody opened the workspace,
produced briefings nobody asked for. The finding changed the default: a
presence message stopped waking an idle seat and only reached the seats
already at work, so a product could aim what it was already going to say at
whoever was now reading. The file carries the title "Three Apps, One Site",
because it is the same report regenerated under the new default.

**Three Apps, One Site.** The run that replaced that default with the
attention scale. Waking on an arrival is a decision for the seat, not for the
room: `named` hears only what is addressed to it, `broadcast` also hears
anything said, `presence` also wakes on an arrival. One seat is seated
`attentive` and watches the door. This restored rule 1 — the session routes a
presence message like any other — while keeping the quiet room the previous
run argued for.

**One Person, One Visit.** The same scenario after two things came out of the
visit. A person can no longer hold several attachments, and no clock writes to
the record. Four presence kinds became two, and `idleTimeout`, the per-visit
timer, visit ids and `session.visits()` left with them. The run is the check
that the scenario never needed any of it.
