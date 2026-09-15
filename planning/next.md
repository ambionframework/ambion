# Next: the work to ship Ambion 0.1.0

Delivery plan, 2026-09-15. Reviewed against `e05bb48` on `origin/main`.
[release-0.1.0.md](release-0.1.0.md) defines the positioning, capabilities,
deployment models, and limits. This file owns implementation work and its
completion evidence, including the remaining work from earlier plans.

All proposed changes and unchecked tasks remain outstanding. Existing baseline
features are identified separately. Writing these plans does not implement
or verify the release.

## Recommendation

**Align the implementation with the collaboration kernel scope.** Remove
representations and ownership overlaps that require unrelated mechanisms to
stay synchronized. The main sources of complexity are:

- Executable definitions and durable membership change in one operation.
- The journal knows about the room's distinction between messages and other facts.
- Activation authority has several overlapping representations.
- Room dispatch, recovery, and exchange reads interpret some facts separately.
- Provider execution and transcript storage extend into unrelated packages.

**Use 0.1.0 to remove these overlaps.** A smaller exported API is useful, but
the larger gain comes from having fewer relationships to keep consistent.

| Order | Change                                             | Main reduction                                       | Scope                |
| ----- | -------------------------------------------------- | ---------------------------------------------------- | -------------------- |
| 1     | One collaboration projection and commit path       | Remove competing interpretations and dispatch paths  | Large                |
| 2     | Separate executable configuration from membership  | Remove binding transactions and seating wrappers     | Medium; breaking API |
| 3     | Separate the journal, protocol, and Pi integration | Remove domain leakage and broad host interfaces      | Medium–large         |
| 4     | Finish context, tools, and release contracts       | Remove implicit conversions and ambiguous guarantees | Medium               |

These are four workstreams, not four independent rewrites. Implement them in
small changes. Each change must delete an old path before it is complete.

## 1. Release coverage and current baseline

**Every release capability needs implementation and evidence.** The scope's
feature identifiers map to the work below.

| Scope                        | Work required before release                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| F1: agent configuration      | Fixed definitions per run, name-based membership, normalized typed tools                                |
| F2: rooms and presence       | One projection, immutable participant views, presence recovery procedure                                |
| F3: concurrent contributions | One commit boundary, exact acknowledgement, steering and retry tests                                    |
| F4: exchanges and assistant  | Shared completion query, constrained assistant tools, summary-based activation context and human review |
| F5: persistence              | Generic journal cleanup, uncertain-write recovery, separate audit failures, restart evidence            |
| F6: tools and workspaces     | Tool normalization, resource/adapter split, workspace behavior verification                             |
| F7: observation and control  | Ordered notifications, reconnect example, explicit cancellation scope                                   |
| F8: deployment models        | Node memory/SQLite examples, JSON protocol conformance, accurate Cloudflare reference status            |
| F9: distribution             | Package extraction, compatibility checks, packed-consumer tests, installation and migration docs        |

**Retain the work already on main.** Awaited startup and snapshots, exchange
handles, separate discussion and response waits, and checkpoint removal are
already implemented. Provider catalog loading is deferred until execution.
The current storage test harness covers memory and SQLite.

These are baseline observations, not evidence that the proposed refactors
pass their release gates. Do not repeat completed changes as new work.

**Keep the assistant's restricted role explicit.** Reject domain tools in its
definition for 0.1.0. Selection and summary executions receive their room
tools. Do not silently accept and omit unsupported tools.

## 2. One owner for collaboration state

**Give each kind of state one owner and one recovery rule.**

| State                                                    | Owner                               | Recovery                                     |
| -------------------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| Accepted collaboration facts                             | Room journal                        | Read confirmed entries                       |
| Membership, pending work, exchange results               | Pure room projection                | Replay the journal                           |
| Definition bindings                                      | Immutable configuration for one run | Supply definitions when starting or resuming |
| Connections, alarms, listeners, resend timestamps        | Room host                           | Recreate from the projection                 |
| Provider requests, tool calls, consumed-context tracking | Agent runner                        | End or retry under journal lease rules       |
| Files and other domain resources                         | Application or workspace            | Use that resource's own persistence contract |

Host memory can affect when a request is resent. It cannot determine whether
the room still owes the work. A Pi transcript records execution history; it
does not become a second source of collaboration state.

### Make the reducer the authority

**Define room state as a replayable value.** Separate recorded facts from
questions that depend on the clock or retry policy.

```ts
// Conceptual internal contracts, not new public extension points.
apply(state, entry) -> state
decide(state, command, now, policy) -> event | refusal
reconcile(state, now, policy) -> decisions
readExchange(state, from) -> exchangeView
```

`apply` consumes confirmed entries. It does not read the clock, resolve models,
dispatch work, or calculate retry delays. Queries derive eligibility from the
recorded attempt history and explicit policy.

**Execution and observation share summary completion.**
[`summaryCompletion`](../packages/ambion/src/room/exchange.ts) now answers
both the pending-work fold and exchange response reads.
[PR #115](https://github.com/ambionframework/ambion/pull/115) centralized this
interpretation. Its results remain derived from journal facts.

**Delivery recipients now derive in journal order.**
[`delivery.ts`](../packages/ambion/src/room/delivery.ts) reads the leases
that precede each message and its recorded wakes. The projection retains
the result for pending-work reads and live steering. It adds no journal
entries. Retry accounting still reads the attempt history.

Attention routes idle agents; active ordinary agents receive new context,
except their own contributions. Assistant selection and summary executions
keep fixed context bounds. The host checks lease liveness before transport
delivery. Replay does not consult the wall clock.

[`message-delivery.test.ts`](../packages/ambion/test/message-delivery.test.ts)
checks live context, recovery of unconsumed context, and summary isolation
on memory and SQLite. Keep these boundaries as activation identity and
dispatch are consolidated next.

**Keep performance work subordinate to the model.** The current `evolve`
path copies base collections and rebuilds derived projections. Naming it
incremental does not make its work bounded.

First establish one correct reducer and its queries. Then maintain indexes
inside that projection where measurements justify them. Full replay must
remain an independent correctness oracle. Do not add checkpoints for 0.1.0.

### Make one path dispatch work

**Activation dispatch now comes from reconciliation.** After a message
append, the host delivers notifications and steering, then requests
reconciliation immediately. Reconciliation reads the activation identities
and attempts from `state.due` for normal operation, retries, and restart.
There is no polling delay or second durable queue.

[`dispatch.test.ts`](../packages/ambion/test/dispatch.test.ts) checks prompt
ordinary and assistant selection starts, and recovery after lost initial
sends, on memory and SQLite. Live handling no longer sends an extra ordinary
activation for assistant selection.

Steering remains a distinct execution operation. Reuse the reducer's delivery
decision and the protocol's structured message data. Do not invent another
activation identity merely to carry a rendered steering line.

### Keep effects outside the commit decision

**Make the atomic boundary easy to describe.**

1. Enter the journal's serial write queue and read the latest storage suffix.
2. Resolve an already committed idempotency key.
3. Validate the command against the current projection.
4. Append conditionally at the expected storage position.
5. Apply the confirmed entry to the projection before the next command.
6. Deliver notifications and request execution outside that write decision.

A failed comparison requires a fresh read and decision. Never retry a stale
event body blindly. An uncertain write requires recovery before a new decision.

**Return expected refusals as data.** The current `RefusedError` translates
between the decision layer, journal draft callbacks, and protocol responses.
A unified commit path should return the decision's result directly.
Exceptions remain appropriate for storage and host failures.

Notification callbacks must not change commit success. Preserve notification
order, isolate listener failures, and avoid awaiting reentrant room calls
inside the write queue.

## 3. Separate configuration from membership

**Fix executable definitions for each room run. Keep membership dynamic.**
This is the most consequential proposed restriction for 0.1.0.

Today, `room.seat(agent)` can install a new JavaScript definition and commit
durable membership. The host stages a binding, promotes it after observation,
and repairs uncertain writes. That transaction crosses two storage models.

Executable functions cannot be recovered from the room journal. A resumed or
remote host already needs definitions supplied separately. Make that existing
requirement explicit at room startup.

### Proposed room API

```ts
const room = await startRoom({
  name: 'site',
  agents: [architect, engineer],
  seats: { architect: 'broadcast' },
  assistant,
});

// Definitions are already available. These operations change membership.
await room.seat('engineer', { attention: 'named' });
await room.unseat('engineer');

const visit = await room.visit(person);
const exchange = await visit.send({
  to: 'architect',
  text: 'Can we proceed?',
  key: deliveryId,
});

const messages = await exchange.messages();
const response = await exchange.response();

await visit.leave();
await room.stop();
```

**Use `agents` for definitions and `seats` for initial membership.** If `seats`
is absent, seat every supplied ordinary agent at `broadcast`. An empty map
starts with those agents in reserve. Reject unknown names immediately.

The reserve becomes the supplied ordinary agents that are currently unseated.
Remove `available` as a second list of executable definitions. The assistant
can select from the reserve. Newly selected agents use the documented default
attention; callers can choose attention when seating explicitly.

This removes per-reserve attention configuration from 0.1.0. Do not add a
second policy map merely to preserve that convenience.

**Address participants by their stable names.** Definitions provide behavior;
names identify participants in a room. Directed messages and `unseat` should
not require callers to retain an executable object.

Room validation still establishes whether a name is present and addressable.
A name, object, or TypeScript brand is not an authorization credential.

**Use `participants()` for the combined room view.** Current `seats()` returns
humans as well as agents. Rename that method and the snapshot field to
`participants`. Keep `seat` and `unseat` for agent membership operations.

**Remove the seating construction hierarchy.** Delete `AgentSeat`,
`SeatedAgent`, `seated`, `passive`, and `attentive`. Retain the attention scale
and put it directly on membership configuration and operations.

This removes wrapper detection, brand checks, normalization, and multiple
spellings for the same choice. The added `seats` map describes a real
distinction: supplied code and current participation.

**Keep definitions immutable without making object identity part of the
protocol.** `defineAgent` and `defineHuman` can remain useful validating
constructors. The room captures their declared fields at startup. It must not
depend on a hidden symbol to distinguish a valid participant.

**State the cost plainly.** Installing an entirely new executable definition
requires a new room run with an expanded definition set. This plan does not
add a `bind` API to preserve arbitrary installation during a run.

If installing unknown agents during a run is essential to the product, retain
the current binding transaction. Merely renaming it does not simplify it.
The recommendation for 0.1.0 is to accept the restriction.

Resume must validate definitions against durable membership and reserve
requirements before starting execution. It must not reset membership from the
new startup defaults. Preserve `readRoom` without executable definitions.

Persist catalog names and public metadata with the room configuration. Keep
functions and provider bindings outside the journal. Reject duplicate names,
including collisions with the assistant, before writing the configuration.

## 4. Give the journal one job

**Keep ordered storage, fencing, and idempotency in the journal package.**
Move every distinction about collaboration into Ambion.

The current [`Journal`](../packages/journal/src/journal.ts) has a designated
`record` kind. It exposes `commit` for that kind and `write` for other kinds.
It also tracks `lastCommitted` and implements message freshness through
`readThrough`.

Ambion already checks freshness in its transition function. Its message commit
path does not pass `readThrough` into the generic journal. Two mechanisms
describe a rule that needs one owner.

**Use one conditional append operation for every domain entry.** The caller
supplies an optional key and a synchronous decision evaluated after recovery.
The decision can propose an entry or return a result without writing.

The journal owns sequence allocation, serialized writes, conditional storage
append, duplicate-key lookup, recovery, and writer fencing. It does not know
which entries an agent must have read.

Remove the `record` designation, `TRecord`, `record` cache, generic
`readThrough` check, and separate domain `write` path. Keep the writer fence
explicit; its distinction is required by storage ownership.

**Replace `RoomJournal` inheritance with composition.** The room's projection
owns its message view and last message position. The journal owns entries.
The current third collection of joined messages then has no separate owner.

Keep envelope metadata in one representation internally. A public message can
still expose `seq` directly. Build that immutable view at a defined boundary.
Do not force users to learn the storage envelope.

### Storage layout

**Keep the physical layout.**

```text
journal_entries(journal, position, entry)

entry = { kind, seq, key?, run?, body }

room journal:
  composition | message | lease | close | run

Pi transcript journals:
  separate names and their existing transcript format
```

Membership, unfinished work, exchange boundaries, and accepted contributions
remain recoverable from the room journal. No task table or mutable state table
becomes authoritative.

Keep storage positions distinct from accepted journal sequence numbers. A
reader can encounter stored entries it does not accept. Keep permanent
delivery keys and conditional `append(entry, expectedPosition)`.

**An internal rename does not require rewriting stored data.** Normalize
existing entries at the reader boundary. For any unavoidable schema change,
provide an explicit version and migration policy. Do not silently reinterpret
old histories under a new meaning.

Validate stored bodies at that boundary. Current room vocabulary validation
checks the kind while ignoring the body. Recognized malformed entries must
produce a clear diagnostic; they must not enter the fold through a type cast.

## 5. Make execution a narrow boundary

### One activation representation

**Use one tagged purpose to determine authority.** Current `ActivationSpec`
repeats purpose through `cause`, `grant.kind`, `grant.tool`, and optional
opening or closing data. Encoded IDs repeat some of those fields again.

Use a discriminated value with the information each purpose requires:

```ts
type Purpose =
  | { kind: 'respond'; message: Seq }
  | { kind: 'select'; exchange: Seq }
  | { kind: 'summarize'; exchange: Seq };

type Activation = Readonly<{
  id: string;
  seat: string;
  attempt: number;
  purpose: Purpose;
}>;
```

This is an internal sketch. An exchange reference uses its opening position.
Context boundaries come from the validated view and the recorded close.
The purpose determines permitted contributions and which room tools exist.

**Keep deterministic identity, but stop distributing its parser.** Decode and
validate IDs at journal and protocol boundaries. Inside the kernel, pass the
canonical activation value. Keep one codec for existing stored IDs.

The room remains responsible for proving that the referenced cause exists,
the seat is eligible, and the lease is current. A syntactically valid ID grants
no authority by itself.

Summary submissions should contain the text the executor proposes. The room
already knows the author, recipient, exchange, and fixed range. Stamp those
fields there and remove the requirement for the executor to echo them.

### Separate protocol data from provider execution

**Have the room return structured collaboration context.** The protocol should
carry the permitted purpose, participant facts, selected messages, and their
context boundary. Pi integration renders these values into prompts.

Model resolution, private agent instructions, Pi messages, tool adaptation, and
transcript writing belong with the executor. The room does not need a model
catalog or a provider stream to decide whether a contribution can commit.

The current [`RunningRoom`](../packages/ambion/src/host/runtime.ts) exposes
room calls, model services, transcripts, definitions, notifications, and
eviction to transports. Replace that broad interface with the existing three
room calls and separately supplied executor dependencies.

Keep the five operations: `view`, `commit`, `lease`, `wake`, and `cut`.
Make starting and steering explicit variants of the `wake` payload. Avoid
optional fields whose meaning changes according to an actor's local state.

**Do not add a general executor plugin framework.** Establish a narrow internal
contract and test it with the in-process and Cloudflare hosts. Pi remains the
supported model loop for 0.1.0.

### Separate execution progress from audit progress

**Only consumed context advances acknowledgement.** Retain the Pi context
tracking that proves which messages actually entered a provider request.
Rendering, queuing, or renewing a lease cannot acknowledge unseen messages.
This complexity protects a real collaboration guarantee.

**An audit failure must not repeat successful reasoning.** Current
[`Activation.pass`](../packages/ambion/src/seat/activation.ts) can classify
transcript persistence failure as execution failure after a contribution lands.

Determine the execution result before audit persistence. Retry audit writes
under a stable identity. Report their failure separately. Unconfirmed audit
data can be lost on process failure; accepted room contributions remain
recoverable from the room journal.

Neither leases nor room idempotency provide exactly-once domain tools.
Applications must make irreversible tool operations idempotent where needed.
Document this boundary without building a domain transaction system.

## 6. Packages and names

**Make dependencies match ownership before adding public packages.**
The collaboration kernel can be a clear source boundary inside `ambion`.
Creating another npm package solely to hold shared types adds coordination.

Proposed source structure:

```text
packages/ambion/src/
  kernel/       events, state, routing, decisions, exchange queries
  protocol/     JSON requests, responses, activation identity codec
  host/         journal integration, room lifecycle, dispatch, subscriptions
  pi/           model execution, tools, context rendering, audit integration
  index.ts      definitions and the default room facade

packages/journal/       ordered storage, append queue, fencing, recovery
packages/pi-journal/    Pi SessionStorage implemented over JournalStorage
packages/workspace/    resource lifecycle, execution environments, tools
packages/cloudflare/   platform hosting adapter
```

The facade composes host and Pi integration. The host uses the kernel and
journal. Pi integration uses the protocol and Pi. The kernel imports no host,
provider, tool schema, or platform implementation.

Split the current assistant module along that boundary: collaboration policy
stays in the kernel; prompts and tool schemas move into Pi integration.

### Extract Pi transcript storage

**Move `journal/pi` into `@ambionframework/pi-journal`.** Its
[`pi.ts`](../packages/journal/src/pi.ts) implements Pi session storage and
depends on Pi's transcript model. It can serve Pi applications without Ambion.

This is a cohesive extraction with an independent purpose. Remove the optional
Pi peer and transcript types from the generic journal package. The new package
depends on `journal` and Pi; neither dependency imports it.

Keep full transcript behavior, including the existing session operations.
Moving audit storage is not permission to replace it with a lossy event logger.

### Keep workspace ownership intact

**Separate the workspace resource from its Ambion tool adapter internally.**
[`resource.ts`](../packages/workspace/src/resource.ts) currently imports the
Ambion bundle type and constructs its tools. The resource's job is connecting,
serializing complete operations, and managing disposal.

Move Ambion tool binding into a small integration module. Keep the existing
convenient workspace facade. The resource and execution environment must be
usable without loading the collaboration runtime.

Expose the resource through a separate package subpath if needed to enforce
that import boundary. This does not require another package or lifecycle API.

Do not extract a general resource framework or a separate just-bash package
for 0.1.0. Extract further only when a second consumer needs that boundary.

### Keep the release surface deliberate

| Current name or structure                         | Proposed treatment                        | Reason                                                        |
| ------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| `AgentSeat`, `SeatedAgent`, three seating helpers | Remove                                    | Membership is plain room configuration                        |
| `seats()` / `SeatInfo`                            | `participants()` / `ParticipantInfo`      | The returned view includes humans and agents                  |
| `SeatActor`                                       | `AgentRunner` within Pi integration       | Names execution rather than durable membership                |
| `ActivationSpec` plus repeated grants             | One canonical activation value            | One discriminator determines authority                        |
| `wire.ts`                                         | Split protocol values from journal events | Network requests and persisted facts have different contracts |
| Broad `RunningRoom` / `Answering` interfaces      | Narrow calls and explicit dependencies    | Adapters cannot reach arbitrary host state                    |
| `Close.wakes[0]` internally                       | `summaryBy`                               | A close designates at most one summary writer                 |
| `Composition` internally                          | `RoomConfiguration`                       | Names the durable configuration fact directly                 |
| `journal/pi`                                      | `pi-journal` package                      | Pi storage has a separate consumer and dependency set         |
| Placeholder CLI                                   | Exclude from 0.1.0 publication            | Help and version output do not establish a useful CLI         |

**Preserve useful established names.** Keep room, agent, visit, exchange,
attention, and journal. Do not rename human to person or attention to routing
merely for stylistic consistency.

Keep transport details behind a hosting subpath. Stop exporting persisted
lease and composition shapes solely because the transport currently uses
`wire.ts`. Leave Cloudflare private until its deployment API is ready.

## 7. Finish the abstraction at the edges

### Tools should have one normal form

**Remove `unknown[]` from authored tools.** Keep `defineTool` as the default
typed authoring interface. Native Pi tools require one explicit adapter.
Provider-specific compatibility belongs in Pi integration.

Use explicit `tools` and `bundles` inputs. Flatten bundles once during
definition construction. A bundle remains tools plus guidance; it has no
lifecycle or execution identity. Workspace resources retain their own owner.

Delete duck typing that treats any object with a `tools` array as a bundle.
The executor should receive one normalized tool type and need no brand-based
choice between calling conventions.

Capture documented immutable data fields. Keep executable functions and
resource handles by identity. Do not expand the generic reflection-based
`capture` helper into an object serialization framework.

### Separate activation context from human review

**Summaries replace covered source messages in later activations.** Keep this
existing behavior for 0.1.0. Once a closed exchange has a summary, agents
continue from that summary and their domain tools. Closure without a summary
does not itself replace source messages. Selection reads the opening context;
summary execution reads its fixed discussion range.

**Human participants can review the original exchange.** Keep all source
messages in the journal and expose the fixed discussion through
`exchange.messages()`. Clients can expand a summary into that discussion for
review. This does not restore the source range to later agent activations.

Verify that rendering and client reads preserve this distinction. Summaries
and uncovered messages accumulate, so context size can still grow. State that
limit explicitly. A future retention policy must preserve human review and
recovery guarantees. Do not make a context-management framework a release gate.

### Make values safe to retain

**Protect facts at ownership boundaries.** Current message reads copy the
array while sharing mutable message objects. Freeze owned JSON values or
return owned immutable snapshots. Include nested ranges, recipient arrays,
and notification payloads.

Keep mutable maps and journal counters private. `ReadonlyMap` is a type-level
promise, and freezing a `Map` does not disable its mutating methods. Pure
functions may use private builders; they must not expose shared mutable state.

Validate every contribution in the kernel, including empty text and target
eligibility. Tool adapters can give early feedback, but cannot be the only
place that enforces a room rule.

## 8. Delivery sequence and release evidence

**Start with the existing behavioral contracts.** Main already has awaited
room startup, `readRoom`, exchange handles, and separate discussion and
response waits. Checkpointing is already removed. Preserve those decisions.

### Stage 1: establish the kernel boundary

- Centralize activation identity. Exchange completion and delivery interpretation
  now share their respective rules across execution and replay.
- Separate steering from the activation wake envelope. Normal operation and
  recovery now use one dispatch decision.
- Isolate mutable host resources from immutable collaboration facts.
- Protect returned values and validate contributions at commit.

**Evidence:** the same history produces the same membership, pending work,
exchange boundaries, and responses. Exercise steering, silence, failures,
removal, and summary work overlapping a later exchange.

### Stage 2: simplify configuration and journal writes

- Introduce fixed definitions per run and name-based membership operations.
- Remove binding transactions, seating wrappers, and duplicate definition lists.
- Replace journal `commit`/`write` distinctions with one conditional operation.
- Remove room journal inheritance and the duplicate freshness mechanism.

**Evidence:** duplicate delivery, uncertain append, restart before dispatch,
and writer replacement preserve the existing durability guarantees. Freshness
still advances on relevant messages, not lease renewals. Resume preserves
membership. Unknown definitions fail before execution starts.

### Stage 3: isolate execution and extract transcript storage

- Move provider rendering and execution dependencies into Pi integration.
- Narrow transport dependencies and separate protocol types from stored facts.
- Extract `pi-journal` and separate audit failure from execution failure.
- Normalize tools and isolate workspace binding.

**Evidence:** run the same scripted collaboration in process and through
Cloudflare's JSON boundary. Audit failure after a committed answer cannot
restart reasoning by itself. Context acknowledgement remains exact.

### Stage 4: make the release explain itself

- Update the implemented contracts after their changes land.
- Provide one short example with two specialists, a person, and an assistant.
- Extend that example with persistence, restart, and dynamic seating.
- Show the fallback when an exchange has messages but no summary.
- Test the packed packages from a clean consumer, including types and exports.
- Run the repository gate, applicable chaos tests, and changed rule proofs.

**Use the current implementation as a migration oracle, not a second permanent
engine.** Keep characterization fixtures where useful. Remove obsolete
branches, exports, helpers, and compatibility paths after migration.

## 9. Remaining work beyond the structural changes

**Complete these tasks within the four stages above.** They close gaps between
the refactors and the full release scope. Historical bug reports are leads
for investigation; their old reproduction rates are not current evidence.

### Package and platform readiness

- [ ] Resolve the two installed TypeBox versions. The lockfile currently has
      1.3.7 and 1.3.18. Choose a compatible dependency contract and prove that
      authored schemas typecheck and execute through the Pi adapter.
- [ ] Replace the cast-based scripted model with a valid model value owned by
      the Pi test adapter. Preserve deterministic provider-free tests.
- [ ] Enforce the kernel's import boundaries in linting and the build. Check
      the actual Cloudflare entry under workerd with its documented compatibility
      settings. Do not imply that the Node workspace is platform-neutral.
- [ ] Update package exports, build entries, dependency checks, versioning,
      and publication discovery for `pi-journal` and the narrowed hosting surface.
- [ ] Make the placeholder CLI private and remove promises of `init`, `dev`,
      or `deploy`. Keep Cloudflare private and label it as a reference implementation.
- [ ] Declare example coverage in Knip. Remove the unused `dev` task contract.
      Review Turbo dependencies against actual source and built-package tests;
      remove redundant builds only where the test contract permits it.
- [ ] Test all public packages from packed artifacts in a clean consumer.
      Check ESM imports, declarations, exports, compatible Node versions, and
      the documented GitHub Packages authentication procedure.

**Done when:** package boundaries hold in generated artifacts, the example
consumer runs without monorepo resolution, and publication selects exactly
the intended packages. Importing definitions must retain lazy provider loading.

### Recovery and host procedures

- [ ] Provide a persistent Node example that restarts over SQLite, supplies
      definitions again, resumes pending work, and reacquires exchange handles.
- [ ] Define the host procedure for reconciling recorded human presence with
      surviving connections. A crash must not invent a departure or lose attribution.
- [ ] Specify how local and separated hosts treat inherited leases. Preserve
      authority for a remote runner that may still be alive. Avoid a generic
      “revoke everything” shortcut that changes retry semantics.
- [ ] Test two rooms using the same agent name with different definitions.
      Local lookup must stay scoped to the room. Remote hosts must document how
      deployed definitions match the room configuration.
- [ ] Test reads and resume attempts for an unknown room name. Define the
      missing-room result and prevent accidental composition or audit creation.
      Do not add another storage operation unless current adapters require it.
- [ ] Demonstrate reconnect through message reads and exchange lookup. Verify
      interruption behavior for waiters when a host stops or is superseded.
- [ ] Test one runner owner per room and seat, including duplicate wakes,
      takeover, and delayed cancellation. Keep transcript identity stable across
      audit-write retries.
- [ ] Document application ownership of credentials, network authentication,
      tool-effect idempotency, and shared workspace lifecycle. Examples must not
      imply that a room lease fences a remote API or another process's filesystem.

**Done when:** the supported deployment examples demonstrate recovery with
their real storage and topology. Record their evidence separately from the
private Cloudflare reference tests.

### Failure tests and operational evidence

- [ ] Investigate the historical Cloudflare wake/cut races on the current
      code. Wait for the executor state each assertion requires. Observe whether
      an alarm actually ran; increasing timeouts is not a diagnosis.
- [ ] Move test-only controls and counters, including `hold`, `wakes`, and
      `cuts`, behind a test fixture boundary where feasible. Do not add public
      room APIs solely to satisfy a race-prone test.
- [ ] Recheck the historical duplicate activation-end report using the
      current memory/SQLite chaos harness. Capture lease transitions and emitted
      events on failure. Fix the implementation or invariant that is wrong.
- [ ] Add targeted clock-skew and pause cases for lease expiry and takeover.
      Separate safety assertions from recovery-time expectations.
- [ ] Run a real-model restart scenario in the live tier. Capture the
      interruption point, committed contributions, resumed work, and final result.
      Scripted recovery tests remain the deterministic gate.
- [ ] Verify cancellation when tools do not cooperate immediately. Show which
      room commits are refused and which external effects remain outside control.
- [ ] Run `pnpm check`, applicable chaos sweeps, and the proofs for changed
      rules. Preserve failing seeds and useful traces.

**Done when:** reported races are resolved or shown obsolete with current
evidence. Do not relabel a runtime defect as test flakiness without isolating
the failed ordering assumption.

### Workspace and context behavior

- [ ] Reproduce `/dev/null` behavior on both just-bash backends. Ensure
      discarded output does not create a growing ordinary file. Prefer a narrow
      adapter or upstream fix; document any remaining shell limitations.
- [ ] Retain whole-operation serialization, cleanup after failures, and the
      distinction between `dispose` and `destroy` while extracting tool binding.
- [ ] Measure replay time, steady-state projection work, memory use, and model
      input size on the release examples. Record the history sizes used.
- [ ] Verify summary-based activation context with silence, conflicting
      contributions, multiple people, and a summary overlapping later work.
      Confirm that human participants can still review all source messages
      through exchange reads after those messages leave agent context.
- [ ] Verify that summary source ranges and model-visible numbering remain
      understandable after moving rendering. Do not expose sparse journal positions
      as if they were contiguous message numbers.

**Done when:** the examples fit their reported limits and the documentation
states those limits. Bounded history and additional automatic compaction
policies remain deferred.

### Documentation, examples, and migration

- [ ] Rewrite the root and package READMEs around the release scope. Remove
      obsolete APIs and the claim that shared summary compaction defines the product.
- [ ] Update the implemented design contracts after the corresponding changes
      land. Remove stale session, JSONL storage, and generic-role descriptions.
- [ ] Maintain one short example and its persistence extension. Typecheck the
      actual snippets used in package documentation.
- [ ] Publish migration notes for fixed definitions, name-based seating,
      `participants()`, explicit tool bundles, the Pi tool adapter, and the
      `journal/pi` package move. State any journal schema migration requirements.
- [ ] Explain discussion completion, absent summaries, deliberate silence,
      room-wide cancellation, and live subscription limits in the examples.
- [ ] Document each deployment model's storage, process lifetime, agent
      provisioning, credentials, workspace availability, and restart responsibilities.
- [ ] Assemble release evidence against F1–F9. Publish only after the required
      gates pass.

**Done when:** the public narrative, executable examples, package contents,
and deployment instructions describe the same shipped behavior.

## 10. Deferred work and the reason it waits

**Keep future work here without making it part of 0.1.0.** These items preserve
the useful questions from the older backlog. Revisit them only with a concrete
consumer or a measured limitation.

| Deferred work                                                          | Reason and condition for reconsideration                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Automatic roster thinning, agent self-removal, attention-only updates  | Define in-flight cancellation and host ownership first; revisit when measured participation costs justify new policy |
| Preferences that steer specialist work; an addressable assistant       | Preferences currently shape the final response; broader authority needs explicit context and routing rules           |
| Assistant roster presentation and token cost                           | Measure the single-assistant case; presentation changes alone do not justify a new participation model               |
| Generic roles, multiple summary writers, room-level writers            | No second required role establishes the conflict or composition rules                                                |
| Credentials broker or sidecar proxy                                    | Hosts and domain tools own credentials for 0.1.0; extract only for an actual shared service requirement              |
| OS-user, container, or remote workspace backends                       | Stronger isolation needs provisioning, identity, teardown, and failure contracts                                     |
| Distributed workspace ownership and effect fencing                     | Local resource serialization does not establish cross-host lifecycle ownership                                       |
| Adoption of Pi AgentHarness                                            | Keep Pi Agent for 0.1.0; reconsider when required capabilities justify its session and lifecycle model               |
| Definition hot-loading and version negotiation                         | Fixed bindings remove the local/durable transaction; unknown definitions need a new run                              |
| Manual retry of an exhausted summary                                   | A new question remains the current recovery path; a reset operation needs explicit history and attempt semantics     |
| Bounded replay, history retention, retrieval, compaction, checkpoints  | Measure growth first; any policy must preserve human review and recovery guarantees                                  |
| Durable cross-process subscriptions                                    | Reads and exchange lookup cover reconnect; a stream needs cursor, replay, and retention contracts                    |
| Native timers, external event ingress, business tasks, workflow graphs | Each adds a public mechanism beyond the scoped collaboration contract                                                |
| Simultaneous independent discussions in one room; exchange budgets     | Both change completion and authority rules; use separate rooms and explicit host control today                       |
| A general executor plugin system                                       | Establish and exercise the internal protocol before making it a public framework                                     |
| A property-test shrinker                                               | Adopt when a real failing history is expensive to reduce manually                                                    |
| JSONL torn-tail and multiwriter repair                                 | Room persistence uses memory/SQLite; revisit only if a JSONL adapter is reintroduced                                 |
| Published Cloudflare deployment and CLI commands                       | The private reference lacks the packaging, configuration, and operational evidence of a supported deployment         |

## 11. Disposition of the previous backlog

**This file replaces the old backlog and release review.** Historical item
numbers below provide traceability. Their old measurements and diagnoses are
not carried forward as current facts.

| Previous items                                                            | Disposition                                                                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 2, 3, 27: folds, history growth, room coupling                            | Sections 2–6 own structural work; section 9 owns measurement; bounded history remains deferred                  |
| 4: eager provider loading                                                 | Already addressed on main; retain an import regression check                                                    |
| 6, 7, 9, 10, 11, 12, 44: dependencies, tests, packaging, platform, docs   | Section 9 owns the remaining release tasks; retire stale paths and export claims                                |
| 13–17: preferences, roster changes, assistant participation               | Deferred in section 10; current assistant constraints remain in scope                                           |
| 20, 25, 51: roles and multiple writers                                    | Deferred; the current scope has one explicit assistant role                                                     |
| 21–24: credentials, shell behavior, isolation, Pi foundation              | Fix or verify shell behavior in section 9; keep host credential ownership and Pi Agent; defer broader machinery |
| 26: runtime-wide name collisions                                          | The current host has room-local definitions; retain collision and remote-binding tests, not the old diagnosis   |
| 28–30: presence recovery, exhausted summaries, inherited leases           | Host recovery procedures in section 9; manual summary reset deferred                                            |
| 32, 33, 36: unknown names, shrinking, clock/storage faults                | Test current missing-room and clock behavior; defer shrinkers and obsolete JSONL fault work                     |
| 37–41: tool effects, remote configuration, runners, workspaces, listeners | Sections 5–6 and 9 establish boundaries and recovery tests; distributed services remain deferred                |
| 42, 50, 53: crash and Cloudflare test failures                            | Reproduce on current code and resolve with ordering evidence in section 9                                       |
| 48: model-visible message numbering                                       | Previously completed; preserve its behavior through the rendering refactor                                      |
| 49: concurrent JSONL room writers                                         | The current room harness uses memory/SQLite; retire the obsolete adapter diagnosis                              |

**Track completion through evidence.** Mark a task complete only after its
implementation and relevant checks land. Keep product scope in
[release-0.1.0.md](release-0.1.0.md); record remaining work only here.
