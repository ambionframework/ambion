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

**Items 7–10 and their replacement APIs are proposals.** Items 1–5 are
merged. Item 6 is implemented and under review. Completed items record their
implementation below. Source references identify the current mechanisms.
Each proposal identifies its behavioral changes.
The initial review used source, contracts, and representative tests.
Implementation adds execution checks for items 1–5.

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
This removes more complexity than another division of the session class.

**Completion evidence.** Replaying accepted events produces the same state
as live execution. Repeated reconciliation creates no duplicate work.
Existing crash, handover, and fencing guarantees remain intact.

**Scope.** Preserve behavior first. Avoid a general workflow engine or a
public event-handler framework.

**Source.** [Transitions](../packages/ambion/src/room/transition.ts),
[session](../packages/ambion/src/session.ts),
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
Transport adapters must upgrade together; the session API is unchanged.

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
Each seat receives its one resolved definition. The runtime holds private
room and workspace registries only. A resume takes its definitions explicitly
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
[room registration](../packages/ambion/src/session.ts), and
[executor resolution](../packages/ambion/src/seat/seat.ts).

## 7. Give the journal its own storage contract

**Current cost.** The extracted journal still requires Pi sessions.
Its SQLite implementation supports lanes and metadata while refusing
several other session operations. Conditional append is an optional
extension discovered at runtime.

**Proposed design.** Give the journal ordered reads and conditional append
through a narrow storage interface. Make concurrency guarantees explicit.
Keep Pi compatibility in an adapter. Provider transcript storage and the
collaboration journal may share a database without sharing an abstraction.

Do not silently downgrade conditional append to an unsafe implementation.
An adapter with weaker guarantees needs an explicit restriction, such as
exclusive ownership by one writer.

**Naming.** Keep `Journal`, `Seq`, and `Checkpoint`. Use `JournalEntry` in
cross-package APIs and `Entry` inside the journal where its scope is clear.
Use `JournalStorage` for the persistence interface and `openJournal` for
opening it. Reserve `SessionOpener` for Pi compatibility code.

Use `expectedPosition` for storage concurrency and `readThrough` for the
conversational precondition. They answer different questions.

**Rationale.** Storage loses an unrelated session model. Hosts can inspect
the durability contract without knowing Pi's lanes or transcript API.
This is the strongest candidate for an independently reusable sub-library.

**Completion evidence.** The journal's main entry imports no Pi session
types. SQLite and compatible adapters pass the same ordering, conditional
append, idempotency, lost-confirmation, and fencing contracts.

**Scope.** Replace storage shapes directly when that simplifies the port.
Keep generic lease scheduling inside Ambion until its domain independence
is demonstrated by another use case.

**Source.** [Journal](../packages/journal/src/journal.ts),
[SQLite storage](../packages/journal/src/sqlite.ts), and
[room vocabulary](../packages/ambion/src/journal/journal.ts).

## 8. Finish extracting workspace behavior as a tool bundle

**Current cost.** Core still owns workspace handles, destruction state,
reserved names, tool binding, and backend-specific prompt text. The renderer
documents that its workspace description can become wrong for another
backend. Both the core handle and backend track destruction.

**Proposed design.** Let the workspace package supply tools and guidance
together through existing tool composition. Its resource owner manages
connection lifetime, revocation, deletion, and file-operation coordination.
Keep authorization checks fresh without requiring a fresh coordination
identity for every call.

The current binding serializes built-ins because fresh environment objects
defeat Pi's coordination. That workaround does not establish coordination
between agents sharing files. Put that responsibility at the shared
resource boundary.

**Naming.** `defineWorkspace` currently reserves a name and creates mutable
lifecycle state. Prefer `openWorkspace` for a resource handle. Reserve
`define*` for inert definitions. Use `dispose` for releasing local resources
and `destroy` only for deleting persisted data, where both operations exist.

Use `workspaceTools` for the tool bundle and `guidance` for its associated
instructions. Keep backend names specific to storage: `memoryBackend` and
`directoryBackend` already communicate useful distinctions.

**Rationale.** Workspace access becomes ordinary tool composition. The
backend owns both what it permits and what it tells the agent it permits.
The core loses filesystem assumptions and duplicate lifecycle ownership.

**Completion evidence.** A backend can change its tools and guidance without
editing the collaboration core. Shared-file mutations have one explicit
coordination policy. Failed deletion and revocation have defined outcomes.

**Scope.** Migrate the workspace field and tool context together. Preserve
per-agent access checks and the existing deletion guarantees.

**Source.** [Core workspace integration](../packages/ambion/src/tools/workspace.ts),
[workspace backends](../packages/workspace/src/just-bash.ts), and
[workspace prose](../packages/ambion/src/render.ts).

## 9. Use one incremental projection and checkpoint its state

**Current cost.** `foldRoom()` repeatedly traverses retained messages to
reconstruct people, roster, exchanges, and outstanding work. Checkpoints
prune administrative history, but retain all messages and the original
composition. Reconstruction therefore still grows with conversation history.

**Proposed design.** Update the projection through the same `evolve`
function used for replay. Checkpoints capture sufficient current state to
resume from their position. Historical messages remain queryable, and
idempotency lookup remains durable.

Apply this separation to rendering. Human display and bounded agent
context are explicit projections over the record. A concise answer for
one person should not automatically determine everything specialists retain.
Retain access to the source messages when a summary omits relevant details.

**Naming.** Use `RoomState` for the authoritative derived state and
`RoomSnapshot` for a public read. Use `projectRecord` for selecting content
and `renderRecord` for turning selected content into text. Use
`checkpointPosition` and `pendingFrom` for distinct checkpoint boundaries
when both are necessary; avoid an unexplained `floor`.

**Rationale.** One reducer serves live state and recovery. Checkpoints cease
to be a second interpretation of the journal. Rendering can evolve without
changing what the room considers true.

**Completion evidence.** Full replay, incremental application, and
checkpoint-plus-suffix replay agree. Historical messages and idempotency
tokens remain accessible. Measure projection cost on long histories.

**Scope.** Depends on item 1. Remove redundant caches only after the new
projection preserves their behavior and performance requirements.

**Source.** [Room fold](../packages/ambion/src/room/fold.ts),
[journal compaction](../packages/journal/src/journal.ts),
[message cache](../packages/ambion/src/journal/journal.ts), and
[rendering](../packages/ambion/src/render.ts).

## 10. Give the public API one vocabulary and asynchronous lifecycle

**Current cost.** `startSession()` returns before initialization, while
`resumeSession()` waits. Read-only `seats()` can observe an unreplayed
journal. A read-only subscription silently does nothing. `quiet()` can
resolve while an exchange's close write remains unsuccessful.

The public API calls the collaboration domain a session. Internally, the
domain is a room, and Pi also supplies sessions. Several interfaces describe
different capabilities without making their distinction clear in the name.

**Proposed design.** Make opening consistently awaitable. Return ready
handles. Separate snapshot reads from observation of a running room.
Distinguish execution inactivity from durable exchange completion, including
cancellation and failure.

**Naming.** Use `Room` throughout the collaboration API. Keep `Session` in
the Pi adapter. A proposed public surface is:

```ts
const room = await startRoom({ name, agents, assistant });
const visit = await room.visit(person);
await visit.send({ text: 'Can we proceed?', key: deliveryId });
await room.waitForIdle();
const snapshot = await readRoom(room.name);
await room.stop();
```

This is a proposed naming sketch. `startRoom` starts with a supplied
composition. `resumeRoom` restores the stored composition. `readRoom`
returns a snapshot. `waitForIdle` describes execution inactivity and makes
no claim that a durable result exists.

Provide a separate `waitForExchange` result when callers need durable
completion. Define its outcomes before finalizing the signature. Returning
the committed message from `visit.send` gives callers its journal position
and delivery key without another read.

Replace `settled` and `quiet` only after specifying the milestones they
serve. Preserve access to the interval between exchange closure and summary
publication through an explicit exchange milestone. Keep `Visit` because
it owns participant identity and a presence lifetime. Keep `say` for the
agent's conversational tool.

**Rationale.** Callers learn one noun for the domain and one readiness rule.
Method names state their effects or the condition they await. A snapshot
does not imply a live subscription.

**Completion evidence.** Ready handles never expose partial replay.
Snapshot reads require no running room. Idle waits and durable completion
report their respective conditions correctly under storage failure.

**Behavioral change.** Awaitable opening and explicit completion outcomes
change API contracts. Remove obsolete names and document the resulting
semantics directly.

**Source.** [Public API](../packages/ambion/src/index.ts),
[session lifecycle](../packages/ambion/src/session.ts), and
[host adapter](../packages/cloudflare/src/room-object.ts).

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

Map the current `SessionEvent` stream to `RoomNotification`. Keep
`RoomEvent` for durable domain facts. Replace `SessionView` with separate
snapshot and observation interfaces when item 10 defines their contracts.
Do not rename a live handle to `RoomSnapshot` while retaining live behavior.

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
5. Complete incremental projection through item 9. Finalize and migrate
   the public vocabulary and lifecycle through item 10.

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
