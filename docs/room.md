# The room

**A room is a shared journal with rules for taking part.** The room orders
every contribution into one journal. It wakes a seat when a message matches
the attention of that seat. It folds the journal into the state of the
roster, the presence, and each exchange.

The [repository README](../README.md) holds the positioning and the current
surface. The [runnable example](example.md) shows a room at work. The
[documentation index](README.md) links every contract.

**The journal holds speech. Tools do the work.** An agent contributes to the
room through `say`. An agent reaches data through its tools and the resources
they read. A message in the journal is a fact for every participant. A tool
call is work that the room does not replay.

## Glossary

Each term names one thing in every page. The right column names the page
that specifies it.

| Term           | Meaning                                                                                                                                                 | Specified in                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Room           | Participants that collaborate through one ordered journal                                                                                               | This page                                                                |
| Definition     | An immutable value: a name, an identity, and an executor. The set of them is "the definitions"                                                          | [agent.md](agent.md#definitions)                                         |
| Seat           | An agent's place on the roster, with its attention                                                                                                      | [roster.md](roster.md)                                                   |
| Attention      | Which messages wake an idle seat                                                                                                                        | [roster.md](roster.md#attention)                                         |
| Reserve        | The definitions that the room knows and has not seated                                                                                                  | [roster.md](roster.md)                                                   |
| Visit          | A person's speaking identity and presence lifetime                                                                                                      | [presence.md](presence.md)                                               |
| Exchange       | A person's question or a returned say, and every activation until the room is quiet                                                                     | [exchange.md](exchange.md)                                               |
| Person         | Of an exchange: the first person who spoke in it, and the one its summary goes to                                                                       | [exchange.md](exchange.md#4-who-directs-one-and-who-receives-its-result) |
| Activation     | The room waking one seat: a bounded execution with one room grant                                                                                       | This page                                                                |
| Due activation | An activation that the room owes a seat. Each attempt is an activation                                                                                  | [durability.md](durability.md#4-what-a-lease-promises)                   |
| Resource       | Application data that an agent's tools reach, with provenance. `WorkspaceResource` is the handle that serialises operations on one backend              | [resources.md](resources.md)                                             |
| Journal        | The ordered, append-only record that the room folds into its state                                                                                      | [durability.md](durability.md)                                           |
| Entry          | One item that the journal holds                                                                                                                         | [durability.md](durability.md)                                           |
| Message        | One item of the record: a say, a system message, a presence change, a summary, or a dismissal                                                           | [agent.md](agent.md), [presence.md](presence.md)                         |
| Record         | The messages of the journal in seq order, as a seat or a person reads them. `readThrough` and the record window are positions on it                     | [durability.md](durability.md)                                           |
| Pass           | One iteration of the executor's loop inside one activation                                                                                              | [executors.md](executors.md#the-pass-contract)                           |
| Step           | One recorded unit of an activation's work                                                                                                               | [executors.md](executors.md)                                             |
| Summary        | A closing message that stands for a closed exchange in agent context                                                                                    | [summary.md](summary.md)                                                 |
| System message | A message of the system with no author: one that the host posts, or a returned say                                                                      | [exchange.md](exchange.md#7-the-edges-a-host-sees)                       |
| Returned say   | A system message that gives a say that an agent scheduled for itself back when it is due                                                                | [exchange.md](exchange.md#6-a-scheduled-say)                             |
| Lease          | The time-limited right of one activation to run and commit                                                                                              | [durability.md](durability.md)                                           |
| Commit         | The write of a seat to the room: a say, a seating change, or a dismissal. In `commit ref` and `CommitUri`, the word has the git sense                   | [durability.md](durability.md)                                           |
| Ref            | One absolute URI that a message cites                                                                                                                   | [agent.md](agent.md)                                                     |
| Executor       | The value in a definition that names an executor kind, such as `pi`, `claude`, or `codex`, and holds its options                                        | [executors.md](executors.md#the-executor-contract)                       |
| Port           | The interface of a seat that another process can implement: `wake`, `steer`, and `cut`                                                                  | [executors.md](executors.md#the-executor-contract)                       |
| Reconcile      | The host verb that folds the journal, decides the work that is due, writes the entries, and sends the requests to the seats. `Room.reconcile` is public | [durability.md](durability.md)                                           |
| Host           | The application that embeds a room through `startRoom`, `resumeRoom`, and the `hosting` entry                                                           | [deployment.md](deployment.md)                                           |

## The two spans

| Span           | Starts                                                                      | Ends                                         |
| -------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| **activation** | The room wakes one seat                                                     | That seat's work ends                        |
| **exchange**   | A person's said message or a system message lands while no exchange is open | The room reaches quiescence or terminal work |

An activation may contain more than one provider request. The exchange spans
every activation from its opening question to its durable close. See
[exchange.md](exchange.md) for the lifecycle.

## Roster and people

`startRoom` writes a composition and starts the room. `agents` supplies the
definitions and `seats` names the initial seated agents.
[Roster](roster.md) owns seats, attention, the reserve, and fixed seats.

```ts
const runtime = createRuntime({ storage: memoryJournals() });
const room = await startRoom({
  runtime,
  name: 'weekly',
  goal: 'Prepare the weekly report.',
  agents: [researcher, editor],
  seats: { researcher: 'broadcast', editor: 'none' },
  summaryWriter: 'editor',
  execution: piExecution(),
});
```

**`goal` is public context for every agent.** It states what the room tries
to accomplish. It is optional and has no effect on the journal when omitted.
It helps a seat decide whether an arrival matters. The `identity` and the
instructions of an agent stay its own domain context.

`definePerson` supplies a name, identity, and optional reading preferences.
`room.visit(person)` records arrival and returns a visit. `visit.send` records
a question or delivery and returns an exchange handle. `visit.leave` records
the departure. `exchange.waitForClose()` returns the source discussion for
human review. `exchange.waitForSummary()` returns the optional summary
result. See [presence.md](presence.md) and [summary.md](summary.md).

## The journal is the authority

**The journal is the authority.** A room derives the roster, presence,
activations, leases, routing, exchange boundaries, and completion by folding
recorded entries. A host can resume the same behavior by replaying the
journal.

The journal records messages, seating changes, leases, exchange closes,
composition, cancellation boundaries, and run fences. A system message
has no author: the host writes one with `room.post`, and
the room writes a returned say when a scheduled say is due. It also records the
activation id that authorized an agent contribution. The room stamps
provenance fields. A caller cannot claim the name of another participant.

The room serializes accepted writes. Agents can reason concurrently. A speech
commit carries `readThrough`, the highest message position its activation
read. The room refuses a stale commit and returns the missed messages. The room
checks no position for a scheduled say, a closing summary, a seating, an
unseating, or a dismissal. Lease renewal extends execution time and does not
acknowledge new context.

An agent may finish without calling `say`. The room records the lease
outcome. Model failure, retry exhaustion, deliberate silence, and an accepted
message remain distinct outcomes.

## Value ownership

**Room reads and notifications return detached values.** Messages,
participant lists, reads, exchange discussions, summary responses, nested
routing lists, and summary ranges belong to their caller. Each listener
receives its own notification value. A change to a value cannot change the
journal, the projection, later reads, or the value of another listener. An
error notification keeps the original `Error`, with its cause and provider
fields. Errors describe execution and are not room facts. An activation event
names its activation.

**An in-process port has the same ownership boundary as a remote call.** The
room captures commit and lease requests before it awaits work. Results and
steering messages carry detached collaboration facts. A later edit by a caller
cannot change the submitted request or the context of another executor.

## Activation and context

An activation is a bounded execution with one room grant. Its purpose is
either to answer a message or to write a closing summary. The room derives the
purpose from the activation id and the journal state. A caller cannot
construct authority by changing fields in a request.

A respond activation reads the goal, the participants, the reserve
identities, and the messages that its context boundary allows. A summary
activation reads every message through its fixed exchange, plus its recipient
and the preferences of that person. It cannot change the recipient or the
exchange it covers.

An active agent receives new eligible context between provider requests when
its framework takes a message during a run. Otherwise the agent receives it on
its next pass. A steer does not acknowledge that context. The next
contribution must report what the activation consumed.

## History and limits

A seat keeps its vendor session for one exchange.
[Exchange continuity](executors.md#exchange-continuity) states the rule.

The journal retains complete history. The room windows the record of each
view by one rule: it keeps the newest messages, never splits a summarised
range, and keeps the open exchange whole. A summary activation keeps its own
closed exchange whole the same way. The record keeps every message for human
review.

**`limits.context.messages` caps the record at the room**, for every seat
and for every executor. The room serves the newest `messages` entries of the
record an activation may read. The floor moves past a summarised range it
would split. The open exchange stays whole, so a cap smaller than the open
exchange serves the exchange in full. The view holds up to `messages`
entries plus the open exchange. The cap counts messages and does not count
bytes. The default is unbounded.

**`activationTokenLimit` windows further, inside the cap.** The room keeps
the newest blocks of the record whose estimated tokens fit the limit, and
at least the newest block. A summarised range counts once, as the line of
its summary. An older exchange falls out of context, and its summary stands
for it when one exists. An agent with no limit reads what the cap serves.
[Definitions and tools](agent.md#definitions) states the option and its
estimator.

**`recall` reads below the window.** `view(activation, message)` returns
the view of that one message when the purpose may read it. No cap and no
token limit apply to it.

When a view holds less than the whole record, `context.omitted` counts the
messages below the first one served. The rendered record then opens with one
line: `── N earlier messages not shown ──`. The line shows for summarised and
unsummarised history alike. The room does not record the cap. A room resumed
under another cap serves a different view of the same record.

[Limits and fold cost](limits.md) holds the table of every limit and the cost of
the fold.

Ambion does not promise bounded replay. The record window bounds model input
and not the journal fold. Domain tools can act before a contribution commits.
Room freshness does not make external effects transactional. The journal owns
no domain transactions and no credentials. Hosts own credentials, process
lifetime, and recovery.

## Collaboration patterns

Each row reads one pattern of people at work against the primitives of the
room. A row adds no mechanism. It links the page that owns the mechanism.

| Pattern                             | How the room represents it                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask and get an answer               | A question opens an [exchange](exchange.md). Quiescence closes it, and the closed `Exchange` carries the outcome. A [summary](summary.md) is optional.                                                                           |
| Ongoing room over days              | `lastDeparture` and `room.read({ messages: { after } })` catch a returning person up ([Presence](presence.md#6-catch-up)).                                                                                                       |
| Broadcast, no reply owed            | A said message. Seats may stay silent, and no reply is owed.                                                                                                                                                                     |
| Bring in a specialist               | An agent seats a reserve agent with `seat` and addresses it with `say({ to })` ([Roster](roster.md#seating-operations)).                                                                                                         |
| Steer work in progress              | A message that lands in an open exchange steers each eligible active seat ([three rules](exchange.md#3-three-rules)).                                                                                                            |
| Two people in one discussion        | A second question joins the open exchange, and the person whose question opened it stays its `person`. The room assigns one summary to each person who spoke ([summary activation](summary.md#summary-activation)).              |
| Waiting on a person                 | The closed exchange reads `awaiting` with the `person`, and `awaitingFor(read, person)` lists what waits on one person ([outcomes](exchange.md#7-the-edges-a-host-sees)).                                                        |
| Approve before an agent acts        | The agent asks a person with `say({ to })` and ends its activation. The exchange reads `awaiting`, and the reply of the person clears it. The kernel enforces no gate. The tools and the definition of an agent govern its acts. |
| Stop one agent, keep the room       | `room.unseat` or the `unseat` tool removes a seat, and the room continues. An agent cannot unseat a [fixed seat](roster.md#fixed-seats). The host can.                                                                           |
| Consult privately                   | The room has no private channel. Open a second room and cite it by reference.                                                                                                                                                    |
| Delegate to a working group         | An agent opens a breakout room for background work. The canvas records its parent and opener ([Canvas](canvas.md)).                                                                                                              |
| Vote, sign off, structured decision | Outside the kernel by design. A tool can write the record of the decision.                                                                                                                                                       |
| Scheduled check-in                  | The agent calls `schedule` with `delaySeconds`, and the room returns the say when it is due ([scheduled say](exchange.md#6-a-scheduled-say)).                                                                                    |
| An event from the host              | The host calls `room.post`. The system message opens an exchange when none is open, and routes as a say does: it wakes the seat that `to` names ([host calls](exchange.md#7-the-edges-a-host-sees)).                             |
