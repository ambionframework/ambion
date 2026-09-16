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

| Scope                        | Work required before release                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| F1: agent configuration      | Fixed definitions per run, name-based membership, normalized typed tools                                       |
| F2: rooms and presence       | One projection, immutable participant views, presence recovery procedure                                       |
| F3: concurrent contributions | One commit boundary, exact acknowledgement, steering and retry tests                                           |
| F4: exchanges and assistant  | Shared seating authority, ordinary assistant membership, closing assignments, summary context and human review |
| F5: persistence              | Generic journal cleanup, uncertain-write recovery, separate audit failures, restart evidence                   |
| F6: tools and workspaces     | Tool normalization, resource/adapter split, workspace behavior verification                                    |
| F7: observation and control  | Ordered notifications, reconnect example, explicit cancellation scope                                          |
| F8: deployment models        | Node memory/SQLite examples, JSON protocol conformance, accurate Cloudflare reference status                   |
| F9: distribution             | Package extraction, compatibility checks, packed-consumer tests, installation and migration docs               |

**Retain the work already on main.** Awaited startup and snapshots, exchange
handles, separate discussion and response waits, and checkpoint removal are
already implemented. Provider catalog loading is deferred until execution.
The current storage test harness covers memory and SQLite.

These are baseline observations, not evidence that the proposed refactors
pass their release gates. Do not repeat completed changes as new work.

**Simplify assistant participation.** Section 5 plans ordinary agent membership,
shared seating authority, and one speaking tool. This replaces the earlier
requirement to reject domain tools on assistant definitions. Closing work
retains its bounded context and publication rules. These changes remain
unimplemented; the recorded evidence below describes the existing behavior.

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

**Steering now has its own transport operation.** `Wake` starts recorded work.
`Steer` carries a recorded message to its exact running activation. The executor
renders that message. Late steering cannot start work or enter another activation.
Reconciliation recovers unread messages from the journal after release or failure.

Applications still use one message API. They do not choose an operation based
on activation or exchange timing. Keep this distinction inside execution and
hosting contracts.

[`steering-delivery.test.ts`](../packages/ambion/test/steering-delivery.test.ts)
checks messages that arrive during release, with lost or delayed steering,
on memory and SQLite. Actor and Cloudflare tests check that steering cannot
schedule work. The former steering payload on `Wake` is removed.

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
Implemented in this change. Executable definitions are captured once; membership remains journaled.

Before this change, `room.seat(agent)` could install a new JavaScript
definition and commit durable membership. The host staged a binding, promoted
it after observation, and repaired uncertain writes. That transaction crossed
two storage models.

Executable functions cannot be recovered from the room journal. A resumed or
remote host already needs definitions supplied separately. Make that existing
requirement explicit at room startup.

### Room API

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
`available` is removed as a second list of executable definitions. The assistant
can select from the reserve. Newly selected agents use the documented default
attention; callers can choose attention when seating explicitly.

This removes per-reserve attention configuration from 0.1.0. Do not add a
second policy map merely to preserve that convenience.

**Address participants by their stable names.** Definitions provide behavior;
names identify participants in a room. Directed messages and `unseat` should
not require callers to retain an executable object.

Room validation still establishes whether a name is present and addressable.
A name, object, or TypeScript brand is not an authorization credential.

**Use `participants()` for the combined room view.** The former `seats()`
method returned humans as well as agents. The room and snapshot now expose
`participants`. Keep `seat` and `unseat` for agent membership operations.

**The seating construction hierarchy is removed.** `AgentSeat`, `SeatedAgent`,
`seated`, `passive`, and `attentive` are gone. Attention belongs directly on
membership configuration and operations. Definition brands and the old
`Participant` definition union are also removed.

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

Resume must validate definitions against durable membership and reserve
requirements before starting execution. It must not reset membership from the
new startup defaults. Preserve `readRoom` without executable definitions.

Persist catalog names and public metadata with the room configuration. Keep
functions and provider bindings outside the journal. Reject duplicate names,
including collisions with the assistant, before writing the configuration.

**Recovery keeps the existing journal format.** Its `agents` and `available`
fields remain disjoint public-metadata partitions of one catalog. They do not
contain executable definitions. Resume preserves membership and attention,
records additional definitions in reserve, and validates again before fencing
a competing run. Every unseated ordinary definition returns to reserve.

**Implementation evidence.** `fixed-definitions.test.ts` exercises immutable
capture, unknown and duplicate names, catalog expansion, human collisions,
and competing resumes on memory and SQLite. `membership-recovery.test.ts`
covers concurrent seating, failed appends, lost confirmations, and failed
recovery reads. Existing assistant selection, steering, retry, unseat, and
summary tests remain in place. Cloudflare persists its per-room catalog names
and tests automatic resume without adding unrelated worker definitions.

The next structural work item is the generic journal boundary in section 4.

## 4. Give the journal one job

**Keep ordered storage, fencing, and idempotency in the journal package.**
Move every distinction about collaboration into Ambion.

**The implementation uses one conditional append operation.**
[`Journal.append`](../packages/journal/src/journal.ts) accepts a kind, an
optional key, and a synchronous decision evaluated after recovery. The
decision proposes a body or returns a result without writing.

The journal owns sequence allocation, serialized writes, conditional storage
append, duplicate-key lookup, recovery, and writer fencing. It does not know
which entries an agent must have read. The writer fence remains explicit.

The refactor removes `record`, `TRecord`, the message cache, `lastCommitted`,
generic `readThrough`, and the separate `commit` and `write` operations.
Idempotency keys cover every accepted kind. Reusing a key across kinds fails
before the decision runs.

**The room composes the journal with its vocabulary.** The `roomJournal`
factory replaces inheritance. The room projection owns messages and the last
message position. The separate joined-message cache is removed. Seat answers
read this projection directly; their interface no longer exposes a journal.

Keep envelope metadata in one representation internally. A public message
continues to expose `seq` directly. Protection of returned nested values
remains outstanding in section 7.

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

**The room validates stored bodies at this boundary.** Recognized malformed
entries produce a diagnostic before they enter the fold. Unknown kinds stay
outside the vocabulary. Failed validation must not advance the read cursor
past the malformed entry.

**Merged:** [PR #122](https://github.com/ambionframework/ambion/pull/122).
The next structural item is the activation representation in section 5.

**Implementation evidence:**

- `pnpm check` passes: 629 package tests and two report tests, with builds,
  type checks, lint, formatting, and dependency checks.
- `pnpm chaos` passes all 710 expanded recovery cases on memory and SQLite.
- Journal tests cover conditional decisions, permanent keys, writer fences,
  uncertain appends, callback failures, and storage positions distinct from sequences.
- Room tests verify that recovery updates the projection before decisions,
  and lease entries do not advance message freshness.
- Twenty validation cases cover stored variants, malformed nested fields,
  timestamps, unknown kinds, and replay. Prototype names remain unknown kinds.
- The obsolete generic freshness proof is removed. The key ownership rule
  has generated Dafny contracts. CI verifies the formal contracts.

The adversarial review also covers keys reused across entry kinds or writers,
async decisions from JavaScript callers, and invalid-history cursor handling.

## 5. Make execution a narrow boundary

### One activation representation

**Merged:** [PR #123](https://github.com/ambionframework/ambion/pull/123).
`ActivationSpec` holds its identity and one tagged `ActivationPurpose`.
The old `cause`, `grant`, `opening`, and `closing` fields are removed.

| Purpose     | Reference        | Additional facts                | Room tool   |
| ----------- | ---------------- | ------------------------------- | ----------- |
| `respond`   | Source message   | None                            | `say`       |
| `select`    | Exchange opening | Person and reserve limit        | `seat`      |
| `summarize` | Exchange opening | Person and fixed close boundary | `summarise` |

**Context progress belongs to the view.** `ActivationView.through` names the
supplied input boundary. The executor acknowledges it only when the provider
consumes that input. Summary input keeps its recorded boundary while a later
exchange runs. Purpose selects both the permitted contribution and room tool.

**One codec owns the durable ID format.** `activation-id.ts` validates and
encodes the existing `message`, `opened`, and `closed` prefixes. It rejects
noncanonical IDs and unsafe sequence or attempt numbers. The stored format
is unchanged. The room resolves a closed ID through its recorded close to
obtain the exchange's opening position.

Lease projections retain their recorded IDs. Consumers share the codec when
they classify recorded attempts. Carrying decoded values through these folds
remains a possible follow-up; this change adds no identity cache or second
lease authority.

**Syntax grants no authority.** The room checks the referenced cause and seat
eligibility. Claims require pending work or an existing live lease. Renewals,
releases, views, and contributions require a live lease. The room derives
purpose again when a contribution reaches its write queue.

**Summary requests contain text only.** The room supplies the author,
recipient, and covered range from the validated purpose. It ignores extra
client metadata and refuses a second summary for the same exchange. Public
summary messages keep their existing fields.

**Implementation evidence:**

- `pnpm check`: 660 tests passed, including 553 core tests and 16 workerd tests.
- `pnpm chaos`: all 710 expanded crash, takeover, replay, and history tests passed.
- Regression tests reject malformed IDs, invalid roles, missing causes, and expired leases.
- Summary tests prove room-owned metadata, duplicate refusal, and fixed context boundaries.
- Executor tests prove purpose-specific tools and compile-time rejection of removed fields.
- Participant definitions reject names that cannot produce canonical activation IDs.
- External releases cannot abandon unclaimed work; another seat cannot settle a summary.

**Remaining execution work:** structured context, narrower executor
interfaces, and separate audit failure remain below. This activation change
does not move rendering or transcript ownership.

### Simplify assistant participation and closing work

**Planned; not implemented.** Treat the assistant as an ordinary agent with
an explicit closing assignment. Give every agent authority to seat supplied
colleagues. Expose one speaking tool. Keep exchange completion and summary
coverage as room guarantees.

**Share seating authority.** Ordinary message activations receive reserve
identities and the `seat` tool. Agents can recruit colleagues when the
discussion reveals missing expertise. The room validates supplied definitions,
records the author, and wakes each newly seated agent.

- [ ] Permit seating from every ordinary agent's live activation. Preserve
      fixed executable definitions, lease validation, and journal attribution.
- [ ] Return an already-seated result for concurrent requests naming the same
      colleague. Do not append duplicate membership events or repeat activation.
- [ ] Remove the dedicated `select` purpose, selection-only tools, and special
      opening dispatch after ordinary participation supplies their behavior.
- [ ] Define initial participation for an empty roster. Require an initial
      participant or an explicit opening recipient before removing selection.

Agent-driven unseating is a separate decision. If added, reuse membership
validation, lease revocation, cancellation, and pending-work settlement.
Shared seating authority does not establish those removal rules.

**Use `say` for closing publication.** A closing activation receives
`say({ text })`. The room derives the recipient and source range from the
recorded closing assignment. Keep the internal summary event and its meaning.

- [ ] Replace the model-facing `summarise` tool with a closing binding of `say`.
      Keep ordinary speech subject to consumed-context freshness checks.
- [ ] Preserve the fixed exchange range while later messages arrive. Refuse
      duplicate publication and writes without the assigned live activation.
- [ ] Keep closing publication from waking idle agents or holding another
      exchange open. Preserve existing delivery behavior for active agents.
- [ ] Preserve summary-based context replacement, original discussion reads,
      response completion, deliberate silence, retries, and terminal failure.
- [ ] Keep recipient preferences inside the assigned closing context. Closing
      publication remains constrained to that exchange and its room tool.

**Remove special assistant membership.** An agent assigned closing work can
also receive ordinary messages, use its domain tools, and seat colleagues.
Attention controls ordinary activation. Closing work has its own recorded
cause, context boundary, and publication authority.

- [ ] Replace the separate assistant definition path with an ordinary agent
      definition and an optional closing assignment by name.
- [ ] Remove forced `none` attention, the ordinary-response prohibition, and
      assistant-only membership restrictions. Define how removal settles any
      pending closing assignment before allowing it.
- [ ] Preserve one active execution per seat when ordinary work and closing
      work overlap. Closing work must not delay discussion closure.
- [ ] Keep at most one assigned writer per close. Record the assignment so
      restart and response queries agree about outstanding work.

**Keep activation causes without a role framework.** The current code has no
`Role` type. Its distinction lives in `ActivationPurpose` and assistant policy.
Retain ordinary message work and exchange-closing work. Remove `select` and
avoid a generic role registry or capability configuration system.

- [ ] Update activation derivation, context selection, tool binding, routing,
      and completion together. Remove obsolete assistant-specific branches.
- [ ] Define compatibility for recorded assistant compositions and `opened`
      activation IDs. Preserve their original recovery meaning or provide an
      explicit migration; do not silently reinterpret old histories.
- [ ] Verify concurrent seating, empty-roster startup, an addressable closing
      writer, removal during pending work, and closing work overlapping later
      discussion. Retain summary isolation and recovery tests.
- [ ] Update examples, public contracts, and migration notes after implementation.

**Done when:** ordinary agents share seating and speech operations, and only
closing work retains the extra context and publication constraints. Replay,
response waits, source review, and summary compaction keep their guarantees.

### Separate protocol data from provider execution

**Structured collaboration context is prepared for review.** The protocol
carries the permitted purpose, participant facts, selected messages, and their
context boundary. `seat/render.ts` renders these values with the executor's
local definition. The view no longer carries a model name or rendered strings.

**One participant list supplies public facts.** Human entries include presence
and reading progress. Selection alone receives reserve identities. A summary
alone receives its recipient's reading preferences. Nested data is detached
from the room projection before an executor receives it.
Context messages omit stored reading preferences. Audit session IDs remain
on the public participant query and stay outside collaboration context.

**Rendering stays pure and has one input contract.** The renderer reads the
activation view and local definition. The former `RoomView`, `PersonView`, and
`SeatSpeaking` representations are removed. Summary compaction, presence
dividers, and consumed-context acknowledgement keep their existing behavior.

**Implementation evidence:**

- `pnpm check`: 665 tests passed, including 558 core tests and 16 workerd tests.
- `pnpm chaos`: all 710 expanded recovery tests passed.
- All three purposes pass JSON round trips with no undefined fields.
- Tests cover nested snapshot isolation and reserve, preference, and summary boundaries.
- A before/after comparison produced identical prompts for response, selection, and summary.
- Luna/High's adversarial review found no remaining blockers.

Model resolution, private agent instructions, Pi messages, tool adaptation, and
transcript writing belong with the executor. The room does not need a model
catalog or a provider stream to decide whether a contribution can commit.

**Next: narrow the executor dependencies.** The current
[`RunningRoom`](../packages/ambion/src/host/runtime.ts) exposes
room calls, model services, transcripts, definitions, notifications, and
eviction to transports. Replace that broad interface with the existing three
room calls and separately supplied executor dependencies.

Keep the six operations: `view`, `commit`, `lease`, `wake`, `steer`, and `cut`.
Starting and steering already use separate operations. Preserve their exact
activation identity while narrowing the protocol dependencies.

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

### Tools have one normal form

**Implemented: tools use one typed execution interface.** `defineTool` keeps
schema-based inference for author callbacks. `AmbionTool` stores captured
metadata and exposes `invoke(unknown, ToolContext)`. Invocation validates
arguments before it calls the typed callback. Native Pi tools enter through
`fromPiTool`; the executor has no brand check or alternate calling convention.

Agents accept explicit `tools` and `bundles` inputs. Definition construction
flattens bundles once and combines their guidance. Tool arrays contain typed
values. Raw Pi tools and bundles in `tools` fail type checking. Invalid runtime
inputs fail at the definition boundary. Workspace resources retain their own
owner and contribute their tools through `bundles`.

The adapters preserve argument preparation, execution mode, cancellation,
call identifiers, streamed updates, and structured results. Only documented
tool data fields are captured. Callback functions keep their identities.

**Evidence:** `tool-types.test.ts` checks schema inference, heterogeneous tool
arrays, rejected input types, and malformed runtime inputs. The Pi adapter
suite checks invocation, schema validation, argument preparation, and caller
mutation. Existing bundle, workspace, and fixed-definition tests cover the
ownership boundaries.

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
- Normal operation and recovery share dispatch. Steering has a separate
  transport operation with no fallback activation identity.
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
| Preferences that steer specialist work                                 | Preferences remain scoped to closing work; broader use needs explicit context rules                                  |
| Assistant roster presentation and token cost                           | Measure after the participation simplification in section 5; additional presentation policy remains deferred         |
| Generic roles, multiple summary writers, room-level writers            | Section 5 retains one closing assignment; no consumer establishes broader conflict or composition rules              |
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

| Previous items                                                            | Disposition                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 2, 3, 27: folds, history growth, room coupling                            | Sections 2–6 own structural work; section 9 owns measurement; bounded history remains deferred                           |
| 4: eager provider loading                                                 | Already addressed on main; retain an import regression check                                                             |
| 6, 7, 9, 10, 11, 12, 44: dependencies, tests, packaging, platform, docs   | Section 9 owns the remaining release tasks; retire stale paths and export claims                                         |
| 13–17: preferences, roster changes, assistant participation               | Section 5 plans shared seating and ordinary assistant membership; broader preferences and removal policy remain deferred |
| 20, 25, 51: roles and multiple writers                                    | Section 5 removes special membership and selection purpose; generic roles and multiple writers remain deferred           |
| 21–24: credentials, shell behavior, isolation, Pi foundation              | Fix or verify shell behavior in section 9; keep host credential ownership and Pi Agent; defer broader machinery          |
| 26: runtime-wide name collisions                                          | The current host has room-local definitions; retain collision and remote-binding tests, not the old diagnosis            |
| 28–30: presence recovery, exhausted summaries, inherited leases           | Host recovery procedures in section 9; manual summary reset deferred                                                     |
| 32, 33, 36: unknown names, shrinking, clock/storage faults                | Test current missing-room and clock behavior; defer shrinkers and obsolete JSONL fault work                              |
| 37–41: tool effects, remote configuration, runners, workspaces, listeners | Sections 5–6 and 9 establish boundaries and recovery tests; distributed services remain deferred                         |
| 42, 50, 53: crash and Cloudflare test failures                            | Reproduce on current code and resolve with ordering evidence in section 9                                                |
| 48: model-visible message numbering                                       | Previously completed; preserve its behavior through the rendering refactor                                               |
| 49: concurrent JSONL room writers                                         | The current room harness uses memory/SQLite; retire the obsolete adapter diagnosis                                       |

**Track completion through evidence.** Mark a task complete only after its
implementation and relevant checks land. Keep product scope in
[release-0.1.0.md](release-0.1.0.md); record remaining work only here.
