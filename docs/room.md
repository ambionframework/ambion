# The room

**A room is a shared journal with rules for taking part.** The room orders
every contribution into one journal. It wakes a seat when a message matches
the attention of that seat. It folds the journal into the state of the
membership, the presence, and each exchange.

The [repository README](../README.md) holds the positioning and the 0.1.0
surface. The [runnable example](example.md) shows a room at work. The
[documentation index](README.md) links every contract. The
[plan](../planning/next.md) defines the scope and records the work that
remains.

**The journal holds speech. Tools do the work.** An agent contributes to the
room through `say`. An agent reaches data through its tools and the resources
they read. A message in the journal is a fact for every participant. A tool
call is work that the room does not replay.

## Glossary

| Term       | Meaning                                                              | Specified in                                     |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| Definition | An immutable value: a name, an identity, and an executor             | [agent.md](agent.md)                             |
| Room       | Participants that collaborate through one ordered journal            | This page                                        |
| Seat       | An agent's membership in a room, with its attention                  | [roster.md](roster.md)                           |
| Attention  | Which messages wake an idle seat                                     | [roster.md](roster.md)                           |
| Reserve    | The definitions that the room knows and has not seated               | [roster.md](roster.md)                           |
| Visit      | A person's speaking identity and presence lifetime                   | [presence.md](presence.md)                       |
| Exchange   | A person's question and every activation until the room is quiet     | [exchange.md](exchange.md)                       |
| Activation | The room waking one seat: a bounded execution with one room grant    | This page                                        |
| Step       | One recorded unit of an activation's work                            | [executors.md](executors.md)                     |
| Resource   | Application data that an agent's tools reach, with provenance        | [resources.md](resources.md)                     |
| Journal    | The ordered, append-only record that the room folds into its state   | [durability.md](durability.md)                   |
| Entry      | One item that the journal holds                                      | [durability.md](durability.md)                   |
| Message    | Spoken text with an author, a position, routing facts, and refs      | [agent.md](agent.md), [presence.md](presence.md) |
| Summary    | A closing message that stands for a closed exchange in agent context | [summary.md](summary.md)                         |
| Lease      | The time-limited right of one activation to run and commit           | [durability.md](durability.md)                   |
| Ref        | One absolute URI that a message cites                                | [agent.md](agent.md)                             |

## Controlled vocabulary

**One word has one meaning in every page.**

- An **activation** is the room waking one seat.
- An **exchange** is a person's question and every activation until the room
  goes quiet.
- A **turn** belongs to Pi. It is one request to a provider. The room has no
  turns.
- No page uses the word `round`.
- The journal holds an **entry**. `row` names a database table row only.
- An agent comes from a **definition**. The set of them is "the definitions",
  with no other name.

## The two spans

| Span           | Starts                                                    | Ends                                         |
| -------------- | --------------------------------------------------------- | -------------------------------------------- |
| **activation** | The room wakes one seat                                   | That seat's work ends                        |
| **exchange**   | A person's spoken message lands while no exchange is open | The room reaches quiescence or terminal work |

An activation may contain more than one provider request. The exchange spans
every activation from its opening question to its durable close. See
[exchange.md](exchange.md) for the lifecycle.

## Membership and people

`startRoom` writes a version 2 composition and starts the room. `seats` names
the initial members and their attention. If `seats` is omitted, every defined
agent starts as a member with `broadcast` attention. An empty map starts all
defined agents in the reserve.

```ts
const room = await startRoom({
  name: 'weekly',
  goal: 'Prepare the weekly report.',
  agents: [researcher, editor],
  seats: { researcher: 'broadcast', editor: 'none' },
  summary: 'editor',
});
```

`room.seat(name)` adds a defined agent to membership. `room.unseat(name)`
removes a member and returns the definition to the reserve. A live activation
may call the same operations for another agent or itself, unless the target
seat is fixed: the summary writer's seat is fixed by default, and only the
host can unseat it. The room refuses an unknown name and a name that belongs
to a human visitor. See [Roster](roster.md) for membership, attention, and
duplicate-operation semantics. Attention selects work and does not authorize
contributions.

`defineHuman` supplies a name, identity, and optional reading preferences.
`room.visit(human)` records arrival and returns a visit. `visit.send` records
a question or delivery and returns an exchange handle. `visit.leave` records
the departure. `exchange.waitForClose()` returns the source discussion for
human review. `exchange.waitForSummary()` returns the optional summary
result. See [presence.md](presence.md) and [summary.md](summary.md).

## The journal is the authority

**The journal is the authority.** A room derives membership, presence,
activations, leases, routing, exchange boundaries, and completion by folding
recorded entries. A host can resume the same behavior by replaying the
journal.

The journal records messages, membership changes, leases, exchange closes,
composition, cancellation boundaries, and run fences. It also records the
activation id that authorized an agent contribution. The room stamps
provenance fields. A caller cannot claim the name of another participant.

The room serializes accepted writes. Agents can reason concurrently. A speech
commit carries `readThrough`, the highest message position its activation
read. The room refuses a stale commit and returns the missed messages. Lease
renewal extends execution time and does not acknowledge new context.

An agent may finish without calling `say`. The room records the lease
outcome. Model failure, retry exhaustion, deliberate silence, and an accepted
message remain distinct outcomes.

## Value ownership

**Room reads return detached values.** Messages, participant lists, reads,
exchange discussions, and summary responses belong to their caller. A change
to these values cannot change the journal, the projection, or later reads.
Nested routing lists and summary ranges follow the same rule.

**Each listener receives its own notification value.** Collaboration facts
inside that notification are detached from the room and from other listeners.
Error notifications retain the original `Error` object, with its cause and
provider fields. Errors describe execution and are not room facts. An
execution event names its activation.

**In-process transports have the same ownership boundary as remote calls.**
The room captures commit and lease requests before it awaits work. Results and
steering messages carry detached collaboration facts. A later edit by a caller
cannot change the submitted request or the context of another executor.

## Activation and context

An activation is a bounded execution with one room grant. Its purpose is
either to answer a message or to write a closing summary. The room derives the
purpose from the activation id and the journal state. A caller cannot
construct authority by changing fields in a request.

An ordinary activation reads the goal, the participants, the reserve
identities, and the messages that its context boundary allows. A summary
activation reads every message through its fixed exchange, plus its recipient
and the preferences of that person. It cannot change the recipient or the
exchange it covers.

Active agents receive new eligible context between provider requests. A steer
does not acknowledge that context. The next contribution must report what the
activation consumed.

## History and limits

Composition entries use version 2. The room rejects legacy compositions and
does not reinterpret old assistant definitions or opening activation ids.
Start a new journal, or migrate the history outside Ambion, before you resume
it.

A seat keeps its harness session for one exchange.
[Exchange continuity](executors.md#exchange-continuity) states the rule.

The journal retains complete history. An agent that sets
`activationTokenLimit` reads a bounded record. The seat pages the record from
the tail through the call `view(activation, range)`. It keeps the newest part
that fits the limit, plus the open exchange whole. An older exchange falls out
of context, and its summary stands for it when one exists. An agent with no
limit reads the whole record. The record keeps every message for human review
in both cases.

`limits.context.messages` caps the record at the room, for every seat and
for every executor. The room serves the newest `messages` entries of the
record an activation may read. The floor moves past a summarised range it
would split. The open exchange stays whole, so a cap smaller than the open
exchange serves the exchange in full. The view holds up to `messages`
entries plus the open exchange. The cap counts messages and does not count
bytes. The default is unbounded. A seat with `activationTokenLimit` windows
further, inside what the room serves.

When a view holds less than the whole record, `context.omitted` counts the
messages below the first one served. The rendered record then opens with one
line: `── N earlier messages not shown ──`. The line shows for summarised and
unsummarised history alike. The room does not record the cap. A room resumed
under another cap serves a different view of the same record.

[Envelope](envelope.md) holds the table of every limit and the measured
cost of the fold.

Ambion does not promise bounded replay. The record window bounds model input
and not the journal fold. Domain tools can act before a contribution commits.
Room freshness does not make external effects transactional. Hosts own
credentials, process lifetime, and recovery.

## The map

- [Definitions and tools](agent.md): `defineAgent`, `defineTool`, `say`, refs,
  and refs.
- [Executors](executors.md): the execution boundary, steps, the trace, and how
  to write an adapter.
- [Default assistant](assistant.md): the `assistant` room option and package.
- [Exchange](exchange.md): human questions, completion, and result handles.
- [Presence](presence.md): visits, arrivals, departures, and catch-up.
- [Roster](roster.md): membership, reserve, and attention.
- [Summaries](summary.md): closing work and context replacement.
- [Resources](resources.md): the resource contract, references, and provenance.
- [Workspace](workspace.md): the Pi filesystem binding.
- [Durability](durability.md): journal guarantees, recovery, and leases.
- [Deployment](deployment.md): host placement, storage, and reconnect.
- [Envelope](envelope.md): configurable limits and the fold cost.
- [Formal](formal.md): the verified rules and the proof gate.
- [Toolchain](toolchain.md): package layout, checks, CI, and release.
