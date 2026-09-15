# Next

An architectural review of the current implementation, dated 2026-09-14.
These ten opportunities are ranked by conceptual impact. Execution order
appears at the end.

This plan records the review after the earlier completed plans. This review
examines the work that remains. [`backlog.md`](backlog.md) retains the wider
debt inventory.

**The objective is fewer independent rules, with clear ownership.**
The library should express sophisticated collaboration through a small,
consistent vocabulary. Each abstraction should own its state, invariants,
and behavior. Extracting files alone does not achieve that objective.

**Backward compatibility is not a goal.** Changes may replace existing APIs
and persisted shapes. Remove obsolete structures and migration machinery
when they complicate the design. Existing persisted state does not constrain
the implementation.

**Items 1–10 are implemented and verified.** Item 10 was finalized in PR #107
(`feat: expose room exchange API`, merged at `841b802`). Completed items record
their implementation below. Source references identify the current mechanisms.
Each proposal identifies its behavioral changes.
The initial review used source, contracts, and representative tests.
Implementation adds execution checks for items 1–10.

Earlier completed-item entries below describe checkpointing as it existed at
that time. Item 9 supersedes those historical references; the current design
retains one complete journal history.

## The design to preserve

**A room is an ordered record and rules for the work that record requires.**
Agents execute that work through bounded authority. An exchange groups the
work for a person's question. Views make the results useful to readers.

Preserve these decisions:

- Agent definitions are values that applications can compose.
- The journal determines durable room state.
- Conditional commits protect conversational freshness.
- Silence is a valid activation outcome.
- Attention and execution status answer separate questions.
- Pending activations and leases determine whether work remains.
- Independently executing seats communicate through serializable requests.
- Summaries retain links to the original record.

**Functional programming belongs at the decision boundary.** Pure functions
should decide and project state. The host should own storage, connections,
timers, and cancellation. Private mutation inside that host is appropriate.
An immutable projection can also use local mutation while constructing its
result, provided it never mutates its inputs.

## 1. Make one room transition the unit of correctness

**Implementation.** `room/transition.ts` now owns `RoomCommand`, `RoomEvent`,
`decide`, and `evolve`. `RoomHost` interprets decisions through the existing
journal queue. Each builder decides after the journal reads storage.
Message decisions include their persisted activation recipients.

Live application and replay share event rules. Each live transition copies
the base collections before constructing the next projection. Replay uses
a private builder. The host checks the journal position before reusing its
cached projection, including after checkpoint compaction.

**Verification.** Transition tests cover accepted events and refusals.
`evolve.test.ts` compares every event kind with replay and retains frozen
prior projections. `checkpoint.test.ts` covers compaction that preserves
the entry count. Existing lease, roster, restart, and lost-confirmation
scenarios check the host behavior.

**Original cost.** `decide()` was pure, but covered only reconciliation. Delivery,
seating, lease changes, validation, and reactions follow separate paths.
Extracting `answers.ts` retained a broad interface back into the room.

**Design.** Extend the functional core to cover domain commands:

```text
decide(state, command, time) -> proposed events or refusal
evolve(state, committed event) -> state
```

One host serializes commands, persists accepted events, updates the
projection, and dispatches effects. Provider execution remains outside the
command queue. Storage conflicts require a fresh decision against the
current state.

Persist scheduling decisions with their causes. Dispatch can then recover
from the journal after a crash between persistence and sending. In-memory
delivery caches may optimize dispatch without becoming durable truth.

**Naming.** Use `RoomCommand`, `RoomEvent`, and `RoomState` for the three
domain values. Use `RoomHost` for their effectful interpreter. Reserve
`decide` for command decisions and `evolve` for applying committed events.
Keep `reconcile` as the operation that checks outstanding work.

**Rationale.** Live operation, replay, retries, and host adapters share one
transition model. A maintainer can identify where every rule is enforced.
This removes more complexity than another division of the room class.

**Completion evidence.** Replaying accepted events produces the same state
as live execution. Repeated reconciliation creates no duplicate work.
Existing crash, handover, and fencing guarantees remain intact.

**Scope.** Preserve behavior first. Avoid a general workflow engine or a
public event-handler framework.

**Source.** [Transitions](../packages/ambion/src/room/transition.ts),
[room](../packages/ambion/src/room.ts),
[answers](../packages/ambion/src/answers.ts), and
[reconciliation](../packages/ambion/src/room/reconcile.ts).

## 2. Give a closed exchange a fixed result boundary

**Implementation.** Each recorded close now keeps its own summary obligation.
The view reads only messages within that close. The transition checks the
activation cause, writer, recipient, exact range, and prior publication.
The host preserves conditional storage append and fencing while allowing
later messages to arrive before the summary publishes.

`SummaryAttempt` holds fixed bounds and a finite tool-call counter.
`Grouped`, `covering`, `widen`, and the draft-refusal counter are removed.
Existing broad summaries still satisfy the historical closes they cover.
The public types and persisted activation encoding remain unchanged.

**Verification.** Transition tests check the activation cause, writer,
recipient, both range bounds, and duplicate publication. Assistant and lease
tests exercise later messages and separate summaries for one person.
Checkpoint tests retain a failed earlier close after a later close resolves.
Shared scenario checks compare summary ranges with recorded closes.

**Implementation contract.** Identify the exchange by `from`, the opening
question's journal position. Keep its recorded recipient, writer, and
`through` fixed when creating a view, retrying, and publishing a summary.

- Track each closed exchange independently, including two for one person.
- Validate the summary's writer, recipient, exact range, and uniqueness
  inside the transition decision.
- Preserve journal idempotency, conditional storage append, and run fencing.
- Apply whole-record freshness checks to ordinary speech. Summary
  acceptance checks its fixed exchange inputs.
- Keep later messages outside the summary's source context and visible in
  the record after it publishes.
- Retain the current activation encoding when reading persisted leases.
  Existing broad summaries still satisfy the historical closes they cover.

**Regression cases.** Cover a later question during drafting, two pending
exchanges for one person, out-of-order publication, invalid summary
requests, repeated tokens, failed attempts, and checkpoint recovery.

**Original cost.** Summary views extended beyond the close through
`state.lastSeq`. Refused drafts widened further, and outstanding summaries
merged by person. These rules added state and exceptions across modules.

**Design.** Make a summary the result of one immutable closed
exchange. Bind its input range and recipient to that exchange. Validate
the writer, range, and uniqueness when publishing. Later messages do not
invalidate unchanged summary inputs. Conditional storage append and run
fencing still apply.

Use the opening question's journal position to identify the exchange.
Avoid adding an unrelated identifier when that position already suffices.
Combining several exchanges becomes an explicit presentation policy.

**Naming.** Keep `Exchange`, `ClosedExchange`, `SummaryMessage`, and
`summarise`. Replace tool-local `Draft` with `SummaryAttempt` while that
state exists. Remove `Grouped`, `covering`, and `widen` when fixed inputs
make their responsibilities unnecessary. A summary's `covers` range must
describe exactly the input it summarizes.

**Rationale.** Stable inputs remove summary-specific concurrency machinery.
The contract becomes: this summary answers this exchange. Publication order
can differ from exchange order without changing what each summary means.

**Behavioral change.** A later question receives a later result. A summary
no longer absorbs intervening exchanges. Evaluate this choice against
multi-person conversations and the existing assistant scenarios.

**Compatibility.** Existing broad summaries continue to satisfy every close
they cover. A completed lease resolves only its named close. Replaying an
older journal can therefore restore an earlier obligation that a later
grouped draft previously resolved without publishing a summary.

**Completion evidence.** A later delivery cannot extend an earlier summary's
range. A retried publication cannot produce a second result for the same
exchange. The original messages remain accessible.

**Source.** [Summary view](../packages/ambion/src/room/view.ts),
[summary folding](../packages/ambion/src/room/fold.ts),
[summary tool](../packages/ambion/src/seat/tools.ts), and
[rendering](../packages/ambion/src/render.ts).

## 3. Give each activation one authoritative specification

**Implementation.** `room/activation.ts` compiles `ActivationSpec` from the
recorded cause and current role binding. `ActivationView.spec` carries that
specification. Views render its inputs, and executor tools use its grant.
The room recompiles the specification inside the commit decision.

The decision rejects intents outside the grant. Ordinary speech requires a
valid current record position. Summary publication retains its fixed range
and duplicate checks. A closed activation bound to `say` reads the current
record. An obsolete role binding returns a stale view.

`CommitRequest` and `CommitResult` name the commit protocol. `LeaseRequest`
distinguishes claim, renewal, and release. `PendingActivation` records the
cause, position, attempt, and `unsuccessfulAttempts` counter explicitly.
Persisted identifiers, leases, and checkpoints keep their existing formats.
Transport adapters must upgrade together; the room API is unchanged.

**Verification.** Transition tests cover grant mismatches, unknown intents,
invalid freshness positions, current context for role-defined speech, and
obsolete role bindings. The room-port tests reject missing freshness without
appending, then accept a write with the current position. They also cover
renewal before claim and repeated claims. Existing wire, lease, checkpoint,
and Cloudflare tests exercise the updated protocol.

**Implementation contract.** One pure compiler derives `ActivationSpec`
from the recorded cause, current room state, and role bindings. Its
specification identifies the seat, attempt, input, and granted tool.
Views render that specification. Tool binding consumes it. The transition
recompiles it before accepting a room action.

- Use a discriminated specification with the required input for each case.
- Reject room intents outside the grant, including custom executor calls.
- Require a valid current `readThrough` for ordinary speech. A valid older
  position returns the missed messages; missing or invalid values are refused.
- Preserve fixed summary bounds, duplicate detection, and journal idempotency.
- Preserve custom role tools and their bounded room authority.
- Distinguish claim, renewal, and release requests. Renewal cannot create a
  lease; a repeated claim for a live lease remains safe.
- Keep journal, checkpoint, and activation identifier formats unchanged.
- Update transport clients together. The canonical view and request types
  replace the previous transport shapes; the session API stays unchanged.

**Regression cases.** Test mismatched intent and grant, missing and invalid
freshness positions, a later message before commit, custom role tools,
JSON round trips, repeated requests, and recovery from a checkpoint.

**Original cost.** An activation's meaning is distributed across its encoded
identifier, role, tool name, optional view fields, and tool-local state.
The commit boundary checks liveness and some intent details. It does not
establish that the activation was granted the submitted intent.

**Design.** Compile one discriminated specification for an
activation. It identifies the cause, seat, input boundary, and permitted
room actions. Use that specification to derive views, bind tools, and
validate requests where they commit.

Record scheduling facts with their causes. Keep executable definitions in
the room's bindings. Deterministic identifiers remain useful, but their
string encoding should not define the authorization contract.

**Naming.** Use `ActivationSpec` for the compiled specification and
`ActivationView` for its rendered input. Use `CommitRequest` for the wire
request and `CommitResult` for its answer. Replace the overloaded request
type `Lease` with a `LeaseRequest` union for claim, renewal, and release.

Use `PendingActivation` for current `Due`: it can be pending during
backoff, before it is due. Name its counter `unsuccessfulAttempts` if it
continues to count failed, expired, and refused attempts. Keep `cause`,
`seat`, and `attempt` as explicit identity fields.

**Rationale.** One contract governs execution and acceptance. It also makes
invalid combinations of tool, cause, and input range unrepresentable.

**Completion evidence.** A custom transport cannot commit a summary from a
speaking activation or bypass its required freshness check. Built-in tools
and room validation derive their permissions from the same specification.

**Scope.** This strengthens enforcement for custom executors. It requires
wire compatibility work, without introducing a general permissions system.

**Source.** [Activation compiler](../packages/ambion/src/room/activation.ts),
[wire types](../packages/ambion/src/wire.ts),
[commit handling](../packages/ambion/src/answers.ts),
[activation identifiers](../packages/ambion/src/room/lease.ts), and
[tool binding](../packages/ambion/src/seat/tools.ts).

## 4. Separate liveness from acknowledged context

**Implementation.** `seat/pi.ts` tracks the ranges attached to actual Pi
provider inputs. Initial views and consumed steers establish contiguous
`readThrough` progress. Freshness refusals associate their context with a
tool result. An accepted ordinary message advances the author's position.

Renewals and releases carry explicit progress. The fold keeps its maximum
and separates attempted work from acknowledged completion. Unread work
remains pending. An unsuccessful attempt advances its identifier, and
revocation cancels its named work. Abandonment resolves its named work at
the retry limit.

`LeaseHold.readThrough` is always a number. `expiresAt` names absolute lease
expiry in lease entries, the projection, and responses. Runtime expiry
settings remain durations. Checkpoints retain acknowledgment and the lease
intervals that establish which messages reached a seat.
While a lease runs, checkpoints preserve the previous floor and retry history.

**Verification.** `context-progress.test.ts` covers explicit acknowledgments,
monotonic updates, invalid requests, retry identifiers, checkpoint retention,
and recovery from the current checkpoint shape. `pi-context.test.ts` checks actual Pi
provider inputs, queued steers, missing ranges, duplicate inputs, tool
results, and full-view recovery. Existing abort tests retain their original
single-cut expectations.

**Implementation contract.** The executor reports the highest contiguous
record position whose context entered a provider request. A successful
ordinary commit also acknowledges the message that the executor authored.
A renewal extends liveness and records only explicitly reported progress.
Completion carries the final acknowledged position.

- Keep acknowledged progress monotonic across repeated or reordered requests.
- Reject invalid progress before appending a lease change.
- Give steers structured record ranges. Journal positions include non-message
  entries, so consecutive message positions need not differ by one.
- Advance acknowledgment only across consumed ranges with no context gap.
- Preserve steering after an in-flight provider request completes.
- Track context from freshness refusals when its tool result enters a
  provider request. Rendering text does not establish acknowledgment.
- Keep scheduling coverage separate from terminal acknowledgment. Unread
  work remains pending after release, and a retry cannot reuse an ended id.
- Preserve explicit cancellation. Revocation resolves its named work without
  claiming consumption; abandonment resolves work at the retry limit.
- Use the new lease and checkpoint shapes directly. Backward compatibility
  with earlier persisted state is outside this work.
- Keep provider-specific context tracking inside the seat adapter.

**Regression cases.** Cover renewal during an in-flight request, dropped,
duplicate and reordered steers, nonconsecutive message positions, completion
races, refusal context, cancellation before a request, and checkpoint recovery.

**Original cost.** The executor tracks consumption through `readThrough`,
pending sequence numbers, and recognition of `[new]` strings in provider
events. The room separately derives `heardThrough` from lease renewals.
A heartbeat establishes liveness, but does not inherently establish which
messages the executor consumed.

**Design.** Carry an explicit consumed-through position from the
executor, including at activation completion. A timer renewal extends the
lease without inventing progress. Structured message metadata identifies
which context the provider adapter consumed.

Steering remains a delivery optimization. The journal and acknowledged
position determine what must be delivered again. Preserve injection after
an in-flight provider request completes.

**Naming.** Use `readThrough` consistently for acknowledged context on the
executor, lease progress, and commit precondition. Define it as the highest
contiguous journal position whose relevant context was consumed. Keep
`expiresAt` for liveness and `deadlineAt` for the activation's maximum end.

Replace helper names such as `heard`, `moved`, and `asked` with operations
that state their facts: `acknowledgeThrough`, `needsRefresh`, and
`providerRequestStarted`. Keep `steer` for supplying new context to a
running activation.

**Rationale.** Knowledge no longer depends on timing or rendered prose.
This gives the freshness guarantee one meaning on both sides of the wire.

**Completion evidence.** Renewing during a provider request does not
acknowledge newly arrived context. Dropped, duplicated, or reordered steers
cannot advance acknowledgment past a gap or silently discharge pending work.

**Scope.** Isolate Pi-specific consumption and transcript handling in an
executor adapter. Preserve the distinction between retrying a transport
request and starting a new activation attempt.

**Source.** [Pi context adapter](../packages/ambion/src/seat/pi.ts),
[activation](../packages/ambion/src/seat/activation.ts),
[lease folding](../packages/ambion/src/room/lease.ts), and
[seat renewal](../packages/ambion/src/seat/seat.ts).

## 5. Make assistant behavior one cohesive policy module

**Implementation.** The room designates its assistant once in the
composition. It remains an ordinary roster seat at attention `none`.
One private policy owns reserve eligibility, summary eligibility, guidance,
and the two tool schemas. The executor owns each activation's mutable
call limits.

Remove generic roles, role registries, shared tool shapes, and custom event
grants. An activation has exactly one protocol: a message permits `say`,
an opening permits `seat`, and a closing permits `summarise`.
The assistant takes only opening and closing activations.

The public `assistant` option remains optional. A composition rejects an
assistant name that does not identify a roster seat at attention `none`.
The host cannot unseat that assistant during the run. Recovery reads the
designation directly from the composition.

**Original cost.** Roles appeared generic, but their scheduling inherited
assistant policy. An `opened` handler depended on a nonempty reserve.
A `closed` handler depended on the summary threshold. The first matching
seat handled an event. Tool shapes and binder precedence added more concepts.

**Naming.** Use `assistantPolicy` for the private policy value. Remove
`defineRole`, `RoleDefinition`, `Role`, `ASSISTANT`, `defineToolShape`,
`ToolShape`, and `binderOf`. Tool definitions directly state their name,
parameters, description, and implementation.

**Rationale.** The supported behavior becomes understandable on its own.
One designation replaces event mappings and host registries. Eligibility
and granted actions share the same assistant contract.

**Behavioral change.** Custom exchange handlers are removed. The assistant
protocol has explicit eligibility and completion rules. Future handlers
need their own coherent domain contract before becoming public APIs.

**Completion evidence.** Test reserve selection, summary eligibility,
restricted grants, invalid designations, and protected assistant seating.
Retain fixed summary boundaries, per-person preferences, retry limits,
cancellation, checkpoint recovery, and host handover invariants.

**Scope.** Keep the policy private in `src/assistant.ts`. An independent
package is unnecessary until another consumer demonstrates that boundary.

**Source.** [Assistant policy](../packages/ambion/src/assistant.ts),
[activation specification](../packages/ambion/src/room/activation.ts),
[routing](../packages/ambion/src/room/routing.ts), and
[executor tools](../packages/ambion/src/seat/tools.ts).

## 6. Make definitions immutable and bindings local to a room

**Implementation.** A room captures its definitions by name when it starts.
Each seat receives its one resolved definition. The runtime holds a private
room registry only. A resume takes its definitions explicitly
and resolves them before it writes its fence.

`defineAgent` copies and freezes authoring data. It copies arrays and plain
records, including schema records. Functions and resource handles retain
their identity. A dynamic seating binds a new name when its accepted journal
entry lands. A later seating may use that binding again. It cannot replace it.

**Verification.** Core tests cover independent same-name definitions,
captured caller tool and schema mutation, missing and duplicate restart
bindings, failed and competing dynamic seating, and recovery after uncertain
seating writes. Cloudflare tests cover configured binding capture, duplicate
configured names, remote seats, and Durable Object restart behavior.

**Naming.** The binding stays private because no external caller owns it.
`Runtime` names host resources. `Seating` remains the persisted boundary.
`SeatedAgent` is the normalized authoring value before a composition lands.

An agent's `name` remains its room-local identity. A catalog identifier,
if needed for restart, must have a separate, explicit scope. Do not make
every agent name globally unique to hide the binding problem.

Consolidate membership names where they encode the same facts. Keep distinct
types only for real boundaries:
an authoring definition can contain functions; persisted membership cannot.
Name those boundaries explicitly instead of introducing another synonym
for a seat.

**Rationale.** Room behavior becomes independent of registration order in
other rooms. Readonly public types then reflect actual ownership.

**Completion evidence.** Two rooms can use different tools and instructions
for the same agent name without interference. Restart resolves the intended
definitions or reports the missing binding clearly.

**Scope.** Resolve collisions explicitly. Removing public
mutable maps requires replacements for legitimate host operations.

**Source.** [Runtime](../packages/ambion/src/host/runtime.ts),
[room registration](../packages/ambion/src/room.ts), and
[executor resolution](../packages/ambion/src/seat/seat.ts).

## 7. Give the journal its own storage contract

**Implementation.** `JournalStorage` reads ordered stored entries and
conditionally appends at `expectedPosition`. Each read returns its final
scanned storage position. `StoragePosition` orders storage. `Seq` orders
journal envelopes. The journal persists `{ kind, body, seq, key?, run? }`.

`memoryJournals()` and `sqliteJournals(sql)` implement the main contract.
SQLite uses one conditional insert that returns the entry it appended. The
main package imports no Pi types. `@ambionframework/journal/pi` contains the
Pi transcript facade over named native journal storage.

Runtime now takes one native `storage` opener. It derives `journals` and
`transcripts` as namespaced views. A room record, Pi audit, and Cloudflare
host metadata share that backend under separate names.

**Verification.** The full gate passes on 2026-09-14. It runs 52 journal,
449 Ambion, 12 Cloudflare, 23 workspace, and 2 CLI tests. Storage tests cover
conditional append, foreign positions, snapshots, successful rereads, and
lost confirmation. Pi facade tests retain transcript state over native
storage. Room and Cloudflare tests retain fencing, idempotency, checkpoints,
restart, and transcript behavior.

**Naming.** `JournalEntry` names the public envelope. `Entry` stays internal
to the journal. `JournalStorage`, `JournalOpener`, and `StoragePosition` name
the persistence boundary. `SessionOpener` belongs only to the Pi subpath.

**Scope.** This replaces the former Pi-session journal storage directly.
Workspace file contents remain on the workspace backend. Generic lease
scheduling remains in Ambion.

**Source.** [Journal](../packages/journal/src/journal.ts),
[SQLite storage](../packages/journal/src/sqlite.ts), and
[room vocabulary](../packages/ambion/src/journal/journal.ts).

## 8. Finish extracting workspace behavior as a tool bundle

**Original cost.** Core still owns workspace handles, destruction state,
reserved names, tool binding, and backend-specific prompt text. The renderer
documents that its workspace description can become wrong for another
backend. Both the core handle and backend track destruction.

**Implementation.** Workspace behavior now lives in
`@ambionframework/workspace`. `openWorkspace` returns the sole owner of one
backend resource. Its `use(agent, operation, signal)` checks lifecycle and
cancellation at submission, at the queue head, and after the backend receives
the fresh agent connection, then runs the whole operation through one serial
queue and cleans up its fresh environment.
`Workspace.tools()` binds exactly the backend's Pi harness tools and carries
its guidance as an ordinary `ToolBundle`; custom tools close over the
workspace and call `use` with `ctx.agent`. The core now has only generic
bundles and an agent-aware `ToolContext`, with no workspace field, filesystem
prose, or name registry.

`destroy` revokes new and queued work, drains active work, and deletes through
the backend. Concurrent destroys join one promise; a failed deletion restores
the active, retryable owner. `dispose` drains and releases local resources
without deleting directory data. The just-bash backends own only storage I/O:
they supply their tools and guidance, clear released caches, and propagate
deletion failures. Hosts that share a filesystem pass one opened owner to all
agents; the owner is process-local and claims no cross-process locking.

**Naming.** `openWorkspace`, `Workspace`, `WorkspaceBackend`, `tools`, `dispose`,
and `destroy` are the workspace package surface. `ToolBundle` and `ToolContext`
are the core's generic composition surface.

**Rationale.** Workspace access is ordinary tool composition, while one
resource owner defines authorization freshness, coordination, revocation, and
deletion. The backend owns its available tools and guidance, so a backend can
change them without editing the collaboration core.

**Verification.** The full gate passes on 2026-09-14: 52 journal, 444 Ambion,
37 workspace, 12 Cloudflare, and 2 CLI tests. Workspace tests cover lifecycle,
queue, fresh access, environment cleanup, failed deletion retry, memory
release, directory deletion, and backend-specific guidance.

**Scope.** Migrate the workspace field and tool context together. Preserve
per-agent access checks and the existing deletion guarantees.

**Source.** [Workspace owner](../packages/workspace/src/resource.ts),
[workspace tools](../packages/workspace/src/tools.ts),
[workspace backends](../packages/workspace/src/just-bash.ts), and
[generic core types](../packages/ambion/src/types.ts).

## 9. Remove checkpointing and keep one durable record

**Implementation.** Checkpoint entries, checkpoint configuration, and journal
compaction are removed from the room and generic journal. The journal retains
the complete ordered history, including administrative entries and message
keys. Live application and replay continue to use the same pure `evolve`
rules, so lease attempts, pending retries, freshness, fencing, and
idempotency all derive from one record.

**Rationale.** The checkpoint was a second persisted interpretation of room
state. It retained messages while adding floors, carried leases and close
exceptions, and still required storage replay to scan the full history. The
smaller contract keeps historical messages queryable and removes those
boundaries and migration concerns. Replay and projection cost grow with
retained history; this makes no bounded-history performance claim. Context
compaction is a separate future concern.

**Completion evidence.** No room or native journal API exposes checkpoint
state or compaction. Replay after restart preserves the existing lease,
pending retry, acknowledgment, fencing, and idempotency behavior, while
message history and Pi audit records remain durable.

**Scope.** Rendering and provider context policy remain unchanged. Any future
bounded context projection must be evaluated separately from journal
retention.

**Source.** [Room fold](../packages/ambion/src/room/fold.ts),
[journal](../packages/journal/src/journal.ts),
[message cache](../packages/ambion/src/journal/journal.ts), and
[rendering](../packages/ambion/src/render.ts).

## 10. Give the public API one vocabulary and asynchronous lifecycle

**Implementation.** Finalized in PR #107 (`feat: expose room exchange API`,
merged at `841b802`). The collaboration API now calls its durable domain a
room and keeps Pi's `Session` terminology inside the Pi adapter. Opening and
reading are consistently awaitable, and a read returns plain data rather than
a live object.

The public surface is:

```ts
const room = await startRoom({ name, agents, assistant });
const visit = await room.visit(person);
const exchange = await visit.send({ text: 'Can we proceed?', key: deliveryId });
const conversation = await exchange.messages();
const response = await exchange.response();

const snapshot = await readRoom(room.name);
await room.stop();
```

`resumeRoom` restores a room over its journal and returns a ready `Room`.
`readRoom` returns a `RoomSnapshot` containing readonly `messages`, `seats`,
and the current exchange, with no execution handles or subscription. Its
seat statuses and current exchange may reflect work active when it was read.
`ExchangeHandle` returned by `Visit.send` carries `owner`, `from`, and `at`;
`messages` waits for the durable close and returns the non-summary messages in
the inclusive `[from, through]` range. `response` waits for the optional
summary or returns `undefined` when no summary is due. `room.exchange(from)`
reacquires the same exchange after a restart.

There is no public room-wide idle, quiet, or settled wait. Callers follow the
specific exchange they opened, so durable close and optional response are
explicit milestones. A repeated send with the same idempotency key returns
the same handle, and concurrent sends into an open exchange steer that same
exchange. A message committed before its close remains inside its range.

`Visit` keeps participant identity and presence lifetime. `say` remains the
agent's conversational tool. `stop` ends execution; it does not delete the
record or invent a close for unfinished work.

**Completion evidence.** Ready handles never expose partial replay. Snapshot
reads require no running room. Exchange handles preserve owner and opening
sequence across retries and restarts, and response completion follows the
exchange's durable close or deliberate no-summary outcome.

**Source.** [Public API](../packages/ambion/src/index.ts),
[room lifecycle](../packages/ambion/src/room.ts), and
[host adapter](../packages/cloudflare/src/room-object.ts).

## 11. Isolate default provider loading from room and read APIs

**Proposal.** Keep the default provider registry behind an internal boundary
that is entered only when a model activation needs it. Scripted and custom
transports, `readRoom`, and other collaboration and inspection paths should
avoid loading provider SDKs they do not use. A Pi subpath is justified only
if the dependencies separate cleanly; the first step is an internal lazy
loading boundary with no new public setup concept.

**Current evidence.** Three fresh Node 22 processes importing the current
built `@ambionframework/ambion` entry took 257–273 ms and increased RSS by
about 67–68 MiB per process. The source still statically imports
`@earendil-works/pi-ai/providers/all` from `host/runtime.ts`, even though
registry construction itself is lazy. These measurements motivate the
boundary; they are not a completion claim.

## Naming principles

**A name must identify a responsibility or an observable fact.** Renaming
cannot repair mixed ownership. Introduce a replacement name when its
contract exists, and remove redundant names with their redundant concepts.

| Term              | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| Agent             | An inert definition of an automated participant.                        |
| Human             | A person's participant definition.                                      |
| Participant       | An agent or human that can be identified in the room.                   |
| Room              | The durable collaboration domain.                                       |
| Seat              | An agent's membership and responsibilities in one room.                 |
| Visit             | A human's presence lifetime and delivery handle.                        |
| Message           | A participant-visible record item, including presence and summaries.    |
| Journal entry     | An ordered, persisted envelope and its body.                            |
| Room event        | A committed domain fact used to derive room state.                      |
| Room notification | An observation emitted to a host, potentially process-local.            |
| Exchange          | A person's question and the work until its defined completion boundary. |
| Activation        | One execution of a seat, including its provider requests.               |
| Lease             | Time-bounded authority for an activation to continue.                   |
| Runtime           | Host-owned resources used to execute rooms.                             |
| Workspace         | A resource reached through an agent's tools.                            |

The proposed glossary preserves the current participant-visible use of
`Message`. It distinguishes domain events from transient execution
notifications. Neither distinction requires persisting diagnostic events.

Use `RoomNotification` for process-local observations and keep `RoomEvent`
for durable domain facts. `RoomSnapshot` is plain data and never retains live
methods or a subscription.

Apply these rules throughout the migration:

- Use `define*` for inert values, `start*` for execution, and `read*` for reads.
- Use `stop` for ending execution, `release` for relinquishing authority,
  and `destroy` for deleting data.
- Use `pending` for outstanding work and `due` for work eligible now.
- Use `expiresAt`, `deadlineAt`, and `retryAt` for instants. State units on
  numeric time fields. Use `retryDelay` or `timeoutMs` for durations.
- Use `is*` and `has*` for boolean facts and `can*` for eligibility checks.
- Prefer action-specific helpers such as `publishSummary` to `landed`,
  `took`, or `heard`, whose meaning changes across modules.
- Keep `Attention` and its ordered values. Prefer one `seated` constructor
  over teaching `passive` and `attentive` as separate concepts.
- Preserve `identity` and `instructions`: their public and private scopes
  are useful domain distinctions.
- Keep provider-specific names and storage types out of the main entry.
- Avoid adding aliases solely to shorten spelling. Judge names by the
  explanation a caller needs to use them correctly.

## Proposed component ownership

**Extract complete responsibilities.** Start with internal modules or
subpaths where independent packaging provides no immediate benefit.

| Component          | Owns                                                                | Packaging direction                                                   |
| ------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Collaboration core | Commands, events, routing, exchanges, activation authority          | Main package; pure kernel remains internal initially.                 |
| Journal            | Ordering, persistence contract, idempotency, fencing                | Existing journal package with independent storage adapters.           |
| Pi executor        | Provider loop, steering metadata, tool adaptation, transcript audit | Begin as `/pi`; extract a package when dependencies separate cleanly. |
| Workspace          | Resource lifetime, access, coordination, tools, guidance            | Complete the existing workspace package.                              |
| Assistant          | Reserve selection and synthesis policy                              | Begin as an internal module or `/assistant`.                          |
| Host adapters      | Transport, alarms, process and platform lifetime                    | Preserve the Cloudflare host boundary.                                |

A platform adapter should not reinterpret exchange or lease semantics.
A tool backend should not require edits to the core renderer. An
independent journal should not require knowledge of agents or Pi sessions.

## Execution order and acceptance

**Impact order and implementation order differ.** Use small migrations
that preserve a working library at each step:

1. Establish the command boundary and activation specification: items 1
   and 3. Update their APIs to express the new contracts.
2. Correct ownership boundaries: item 6, then the journal and workspace
   extractions in items 7 and 8. These extractions can proceed independently
   where their interfaces permit it.
3. Make context acknowledgment explicit through item 4. Preserve provider
   request boundaries and existing fault behavior.
4. Evaluate fixed summary inputs and assistant policy through items 2 and 5. Use multi-person scenarios to assess the deliberate behavior changes.
5. Keep item 9's one durable record. Finalize and migrate the public
   vocabulary and lifecycle through item 10.

Use the proposed names when each internal contract lands. Avoid a separate
repository-wide rename before the ownership changes stabilize. Rename
persisted fields and wire operations directly when their new names clarify
the contract. Remove obsolete shapes and adapters.

**Measure simplification by removed rules.** Each change should identify
which independent state, duplicated decision, or public concept it removes.
Count reductions in required concepts, not only exports or source lines.

Preserve the existing fault tests as regression evidence. Add targeted
checks for changed contracts, including replay equivalence, immutable input
ranges, activation authority, context acknowledgment, and resource ownership.
Broader proofs should follow the actual invariants those boundaries enforce.
