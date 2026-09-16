# Next: the work to ship Ambion 0.1.0

Delivery plan, 2026-09-16. Updated for executor separation in PR #130,
Pi transcript extraction in PR #131, room value ownership in PR #132,
protocol separation in PR #133, workspace resource separation in PR #134,
and restart/reconnect procedures prepared for review.
[release-0.1.0.md](release-0.1.0.md) defines the positioning, capabilities,
deployment models, and limits. This file owns implementation work and its
completion evidence, including the remaining work from earlier plans.

All proposed changes and unchecked tasks remain outstanding. Existing baseline
features are identified separately. Writing these plans does not implement
or verify the release.

## Recommendation

**Align the implementation with the collaboration kernel scope.** Remove
representations and ownership overlaps that require unrelated mechanisms to
stay synchronized. Executor dependencies and Pi transcript storage now have
explicit boundaries. PR #132 protects accepted room facts at public reads
and local delivery.
PR #133 separates protocol messages from stored event shapes. PR #134
separates workspace resource ownership from Ambion tool binding. The current
priority makes host recovery procedures explicit and tests them across restart.

**Build on the merged foundations.** Fixed definitions, normalized tools,
conditional journal appends, activation purpose, structured context, and
ordinary participation have landed. Preserve their evidence below.

| Order | Change                                 | Main reduction                                                | Scope        |
| ----- | -------------------------------------- | ------------------------------------------------------------- | ------------ |
| 1     | Clarify and test host recovery         | One procedure for presence, client progress, and pending work | Section 9    |
| 2     | Complete package and release contracts | Verify distribution and supported deployment examples         | Sections 8–9 |

PR #130 narrows executor dependencies. PR #131 extracts Pi transcripts.
PR #132 detaches collaboration values at ownership boundaries. Sections 5–7
retain their validation. PR #133 narrows the transport boundary.

Implement these changes in bounded slices. Temporary paths must have a named
removal step. Do not introduce a second permanent participation model.

## 1. Release coverage and current baseline

**Every release capability needs implementation and evidence.** The scope's
feature identifiers map to the work below.

| Scope                        | Work required before release                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| F1: agent configuration      | Fixed definitions per run, name-based membership, normalized typed tools                             |
| F2: rooms and presence       | One projection, immutable participant views, presence recovery procedure                             |
| F3: concurrent contributions | One commit boundary, exact acknowledgement, steering and retry tests                                 |
| F4: exchanges and closing    | Shared seating authority, ordinary membership, closing assignments, summary context and human review |
| F5: persistence              | Generic journal cleanup, uncertain-write recovery, separate audit failures, restart evidence         |
| F6: tools and workspaces     | Tool normalization, resource/adapter split, workspace behavior verification                          |
| F7: observation and control  | Ordered notifications, reconnect example, explicit cancellation scope                                |
| F8: deployment models        | Node memory/SQLite examples, JSON protocol conformance, accurate Cloudflare reference status         |
| F9: distribution             | Package extraction, compatibility checks, packed-consumer tests, installation and migration docs     |

**Retain the work already on main.** Awaited startup and snapshots, exchange
handles, separate discussion and response waits, and checkpoint removal are
already implemented. Provider catalog loading is deferred until execution.
The current storage test harness covers memory and SQLite.

These are baseline observations, not evidence that the proposed refactors
pass their release gates. Do not repeat completed changes as new work.

**Participation is uniform.** PR #128 gives every agent ordinary membership,
shared seating authority, and one speaking tool. Closing work retains its
bounded context and publication rules. Section 5 records the implementation.

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

Attention routes idle agents; active agents receive new context, except their
own contributions. Ordinary and closing executions keep fixed context bounds.
The host checks lease liveness before transport delivery. Replay does not
consult the wall clock.

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
ordinary activation starts and recovery after lost initial sends, on memory
and SQLite. Closing work uses the same dispatch path.

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
  summary: 'editor',
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

The reserve becomes the supplied agents that are currently unseated. `available`
is the recorded reserve partition of one executable catalog. Any live agent can
seat a reserve colleague. Newly seated agents use `broadcast` unless the host
chooses another attention.

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
functions and provider bindings outside the journal. Reject duplicate names
before writing the configuration.

**Recovery keeps the version 2 journal format.** Its `agents` and `available`
fields remain disjoint public-metadata partitions of one catalog. They do not
contain executable definitions. Resume preserves membership and attention,
records additional definitions in reserve, and validates again before fencing
a competing run. Every unseated ordinary definition returns to reserve.

**Implementation evidence.** `fixed-definitions.test.ts` exercises immutable
capture, unknown and duplicate names, catalog expansion, human collisions,
and competing resumes on memory and SQLite. `membership-recovery.test.ts`
covers concurrent seating, failed appends, lost confirmations, and failed
recovery reads. Existing steering, retry, unseat, and summary tests remain in
place. Cloudflare persists its per-room catalog names
and tests automatic resume without adding unrelated worker definitions.

Section 4 records the completed generic journal boundary.

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
continues to expose `seq` directly. Section 7 records protection of returned nested values.

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
Section 5 records the activation representation changes.

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

| Purpose     | Reference      | Additional facts           | Room tools              |
| ----------- | -------------- | -------------------------- | ----------------------- |
| `respond`   | Source message | None                       | `say`, `seat`, `unseat` |
| `summarize` | Fixed close    | Person and source boundary | `say`                   |

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

**Syntax grants no authority.** The room checks the referenced journal fact and
seat eligibility. Claims require pending work or an existing live lease.
Renewals, releases, views, and contributions require a live lease. The room
derives purpose again when a contribution reaches its write queue.

**Summary requests use the regular `say` shape.** The room supplies the author,
recipient, and covered range from the validated purpose. It ignores extra
client metadata and refuses a second summary for the same exchange. Public
summary messages keep their existing fields.

**Implementation evidence:**

- `pnpm check`: 660 tests passed, including 553 core tests and 16 workerd tests.
- `pnpm chaos`: all 710 expanded crash, takeover, replay, and history tests passed.
- Regression tests reject malformed IDs, missing journal facts, and expired leases.
- Summary tests prove room-owned metadata, duplicate refusal, and fixed context boundaries.
- Executor tests prove purpose-specific tools and compile-time rejection of removed fields.
- Participant definitions reject names that cannot produce canonical activation IDs.
- External releases cannot abandon unclaimed work; another seat cannot settle a summary.

**Subsequent execution work:** PR #124 moved rendering to the executor.
Participation, narrower interfaces, and separate audit failure remain below.

### Simplify participation and closing work

**Implemented in [PR #128](https://github.com/ambionframework/ambion/pull/128).**
Treat the former assistant as an ordinary
agent with an explicit closing assignment. Every agent has authority to seat
supplied colleagues and one speaking tool. Exchange completion and summary
coverage remain room guarantees.

**Share seating authority.** Ordinary message activations receive reserve
identities and the `seat` tool. Agents can recruit colleagues when the
discussion reveals missing expertise. The room validates supplied definitions,
records the author, and wakes each newly seated agent.

- [x] Permit seating from every ordinary agent's live activation. Preserve
      fixed executable definitions, lease validation, and journal attribution.
- [x] Return an already-seated result for concurrent requests naming the same
      colleague. Do not append duplicate membership events or repeat activation.
      Validate the live activation before accepting this no-op.
- [x] Keep consumed-context acknowledgement independent of seating success.
      Duplicate membership requests do not append, wake, or acknowledge.
      Reject unknown definitions and names belonging to human participants.
- [x] Remove the dedicated `select` purpose, selection-only tools, and special
      opening dispatch. Ordinary agents receive the same room tools.
- [x] Keep empty rooms valid. To start agent work, the host seats at least one
      agent whose attention accepts the message. Use existing membership;
      do not add an opening-recipient API.

**Share unseating authority.** Every ordinary activation receives `unseat`.
The room validates the name, revokes the target's live work, and settles any
pending assignment. The calling agent may unseat itself.

- [x] Allow an activation to unseat any seated agent, including itself.
- [x] Refuse unknown names and human names.
- [x] Settle removed summary work. Reseating the writer must not revive it.

**Use `say` for closing publication.** A closing activation receives
`say({ text })`. The room derives the recipient and source range from the
recorded closing assignment. Keep the internal summary event and its meaning.

- [x] Replace the model-facing `summarise` tool with a closing binding of `say`.
      Keep ordinary speech subject to consumed-context freshness checks.
- [x] Preserve the fixed exchange range while later messages arrive. Refuse
      duplicate publication and writes without the assigned live activation.
- [x] Keep closing publication from waking idle agents or holding another
      exchange open. Preserve existing delivery behavior for active agents.
- [x] Preserve summary-based context replacement, original discussion reads,
      response completion, deliberate silence, retries, and terminal failure.
- [x] Keep recipient preferences inside the assigned closing context. Closing
      publication remains constrained to that exchange and its room tool.

**Remove special assistant membership.** An agent assigned closing work can
also receive ordinary messages, use its domain tools, and seat colleagues.
Attention controls ordinary activation. Closing work has its own recorded
purpose, context boundary, and publication authority.

- [x] Replace the separate assistant definition path with an ordinary agent
      definition and an optional closing assignment by name.
- [x] Remove forced `none` attention, the ordinary-response prohibition, and
      assistant-only membership restrictions. Settle pending closing work when
      its writer leaves. Do not silently reassign its writer.
- [x] Preserve one active execution per seat when ordinary work and closing
      work overlap. Exclude closing execution from discussion completion;
      keep queued ordinary work visible to that completion query.
- [x] Keep at most one assigned writer per close. Record the assignment so
      restart and response queries agree about outstanding work.

**Keep activation purposes without a role framework.** Retain ordinary message
work and exchange-closing work. Avoid a generic role registry or capability
configuration system.

- [x] Update activation derivation, context selection, tool binding, routing,
      and completion together. Remove obsolete assistant-specific branches.
- [x] Define an explicit migration or version rejection for recorded assistant
      compositions and `opened` activation IDs. Do not silently reinterpret
      old histories or retain a permanent compatibility execution path.
- [x] Verify concurrent seating, self-unseating, empty-roster startup, a
      seated closing writer, removal during pending work, and closing work
      overlapping later discussion. Retain summary isolation and recovery tests.
- [x] Update examples, public contracts, and migration notes after implementation.

**Implementation evidence:** ordinary membership, self-unseating, closing `say`,
fixed summary boundaries, one active lease per seat, removal and reseat fences,
no-op membership results, and version 2 history rejection are covered by the
focused room, transition, summary, host, and replay tests. Focused checks pass
with memory and SQLite coverage. `pnpm format` and `pnpm check` pass,
including 580 core tests, 37 workspace tests, and 17 Cloudflare tests.
Expanded chaos passes 728 tests. All seven PR checks pass, including the live
provider suite and contract verification. PR #127's generated CLI team is
updated to the same agent catalog and summary assignment. The integrated gate
also passes with 18 Cloudflare tests and six CLI tests. The packed CLI consumer
smoke passes, including the generated worker's Wrangler build.

### Separate protocol data from provider execution

**Merged:** [PR #124](https://github.com/ambionframework/ambion/pull/124).

**Historical PR #124 carried structured collaboration context.** Its view
contained the permitted purpose, participant facts, selected messages, and
their context boundary. At that point the protocol still represented three
purposes: response, selection, and summary. `seat/render.ts` rendered these
values with the executor's local definition; the view did not carry a model
name or rendered strings.

**Historical participant boundaries remain evidence for the protocol work.**
Human entries included presence and reading progress. Selection received
reserve identities, while summary received its recipient's reading
preferences. Nested data was detached from the room projection before an
executor received it. The participation refactor below removes selection and
makes all ordinary activations use the ordinary participant and reserve view;
closing context remains separately bounded.
Context messages omit stored reading preferences. Audit session IDs remain
on the public participant query and stay outside collaboration context.

**Rendering stays pure and has one input contract.** The renderer reads the
activation view and local definition. The former `RoomView`, `PersonView`, and
`SeatSpeaking` representations are removed. Summary compaction, presence
dividers, and consumed-context acknowledgement keep their existing behavior.

**Implementation evidence:**

- `pnpm check`: 665 tests passed, including 558 core tests and 16 workerd tests.
- `pnpm chaos`: all 710 expanded recovery tests passed.
- All three historical purposes passed JSON round trips with no undefined fields.
- Tests cover nested snapshot isolation and reserve, preference, and summary boundaries.
- A before/after comparison produced identical prompts for response, selection, and summary.
- Luna/High's adversarial review found no remaining blockers.

Model resolution, private agent instructions, Pi messages, tool adaptation, and
transcript writing belong with the executor. The room does not need a model
catalog or a provider stream to decide whether a contribution can commit.

**Merged:** [PR #130](https://github.com/ambionframework/ambion/pull/130).

**Executor dependencies use an explicit boundary.**
`Transport.connect(room, context)` receives a plain `SeatRoom` facade and the
existing `SeatContext`. The facade exposes only `view`, `commit`, and `lease`.
The context supplies one captured definition and its local execution services.
The returned port retains `wake`, `steer`, and `cut` with exact activation ids.

The runtime registry keeps lifecycle control separately. Its public lookup
returns only room calls. The protocol answer layer receives `now()` and no
longer requires the provider-bearing runtime. In-process and Cloudflare
transports use the same call surface; remote execution supplies dependencies
locally.

**Scope:** retain the public room API, journal format, activation behavior,
provider loading, audit isolation, and context acknowledgement. The transport
adapter signature changes. Section 6 records Pi transcript extraction and
the subsequent separation of protocol values from stored facts.

**Validation:** `pnpm format` and `pnpm check` pass, including 586 core tests,
18 workerd tests, 37 workspace tests, and six CLI tests. Expanded recovery
passes all 728 tests. The packed CLI consumer smoke passes with a Wrangler
build. Independent tests cover the actual facade, room-local overrides, JSON
calls, notifications, and stale connections after eviction and resume.

Review preserved live snapshot ordering with pending journal writes; a new
regression covers memory and SQLite. Luna/High implemented the slice and a
second Luna/High review found no remaining production blockers. All seven CI
checks pass, including live provider tests and contract verification. CI
exposed live-test assumptions
about an implicitly added coordinator. Live fixtures now use explicit agent
catalogs and summary assignments. Failure attribution and silence assertions
remain strict. The invalid-credentials probe passes locally against the provider.

**Do not add a general executor plugin framework.** Establish a narrow internal
contract and test it with the in-process and Cloudflare hosts. Pi remains the
supported model loop for 0.1.0.

### Separate execution progress from audit progress

**Only consumed context advances acknowledgement.** Retain the Pi context
tracking that proves which messages actually entered a provider request.
Rendering, queuing, or renewing a lease cannot acknowledge unseen messages.
This complexity protects a real collaboration guarantee.

**Audit isolation is merged in PR #126.** The executor determines the model
outcome independently of transcript persistence. Successful speech and silence
complete normally when auditing fails. Genuine provider failures retain their
execution retry policy.

Audit writes retry once with stable entry identities and captured payloads.
Failed session opens can be attempted again. Exhausted writes emit a separate
`audit_error` containing the agent and activation identity. In-process and
Cloudflare hosts retain that diagnostic. Unconfirmed audit data can be lost
on process failure; accepted contributions remain in the room journal.

**Implementation evidence:**

- `pnpm format` and `pnpm check` passed: 686 repository tests, including
  578 core tests and 17 workerd tests. Unchanged package tests used the cache.
- `pnpm chaos` passed all 710 expanded recovery tests.
- The pre-fix silence regression fails on memory and SQLite because audit
  failure leaves the exchange pending. Both pass with the change.
- Tests cover speech, silence, closing work, provider failure, context refresh,
  cuts during blocked audits, notification failures, and session reopening.
- Lost acknowledgement plus a failed recovery read exercises the audit retry.
  It preserves captured payloads and stores each transcript entry once.
- A workerd test verifies remote audit diagnostics and exchange completion.
- Luna/High implemented the change. Independent Luna/High and parent reviews
  found no remaining implementation blockers.

Retries are bounded by attempt count. Storage operations still share the
activation lifetime; this change adds no background or durable audit queue.

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

Keep summary assignment in the room and summary guidance in the seat
executor. Prompts and tool schemas stay with Pi integration.

### Extract Pi transcript storage

**Merged:** [PR #131](https://github.com/ambionframework/ambion/pull/131).
`@ambionframework/pi-journal` replaces the removed `journal/pi` subpath. Its
[`index.ts`](../packages/pi-journal/src/index.ts) implements Pi session storage and
depends on Pi's transcript model. It can serve Pi applications without Ambion.

The generic journal has no Pi peer, transcript types, or session implementation.
The new package depends on `journal` and Pi; neither dependency imports it.
`SessionOpener` and `piSessions` retain their API. Session operations, storage
names, and mutation formats are unchanged. Existing transcripts need no migration.

**Validation:** all seven CI checks pass, including live provider tests.
`pnpm check` passes with 30 journal tests, 20 Pi session tests, 586 core tests,
18 workerd tests, 37 workspace tests, and six CLI tests. The Pi tests retain
memory and SQLite coverage, query conformance, conflict recovery, and lost
acknowledgement recovery. Core tests retain audit isolation and lazy loading.

Two packed consumers check declarations and execution outside the workspace.
The generic journal works without Pi. Pi sessions work without the Ambion
runtime. The removed subpath fails explicitly. Release discovery includes
the new package. These standalone consumer checks pass locally. The packed CLI smoke
passes through generated project typechecking and a Wrangler dry run.

Import restrictions preserve the dependency direction. Runtime consumers,
examples, manifests, aliases, and migration instructions use the new package.

### Separate protocol values from stored events

**Merged:** [PR #133](https://github.com/ambionframework/ambion/pull/133).

**The transport contract contains execution protocol values.** `protocol.ts` contains
requests, replies, activation context, and JSON checks. `journal/events.ts`
contains stored event shapes. `room/lease.ts` owns the projected lease state.
Lease end reasons remain shared by protocol and journal events.

The transport entry stops exporting `Close`, `Composition`, `Fence`,
`Seating`, `LeaseChange`, and `LeaseHold`. Executors continue to use the same
`SeatRoom` calls and `SeatPort` delivery operations. Hosts read collaboration
history through room snapshots and exchange handles. No new package or
storage-schema subpath is introduced.

The journal format, history version, and protocol JSON shapes are unchanged.
Import restrictions keep the journal and protocol independent. Cloudflare
retains its runtime API and verifies stored facts through test-local observations.

**Validation:** `pnpm format` and `pnpm check` pass with 610 core tests,
18 workerd tests, 30 journal tests, 20 Pi session tests, 37 workspace tests,
and six CLI tests. The packed consumer compiles an external transport and
rejects imports of all six internal types. Generated project typechecking
and the Wrangler dry run pass. Import probes verify both forbidden dependency
directions. Luna/High's independent review found no blockers. All seven CI
checks pass, including live provider tests.

### Keep workspace ownership intact

**Merged:** [PR #134](https://github.com/ambionframework/ambion/pull/134).

**One resource owner has an Ambion adapter.**
`resource.ts` owns connection, complete-operation serialization, and lifecycle.
It accepts a `ResourceBackend` with `connect`, `destroy`, and optional `dispose`.
`workspace.ts` adds a stable tool bundle through `tools.ts`. Tool calls and
direct operations use the same owner and queue.

The root `openWorkspace`, `Workspace`, and `WorkspaceBackend` remain compatible.
The additive `/resource` entry exposes `openResource`, its types, and the
existing backends without loading the collaboration runtime. Resource
declarations do not depend on Ambion tool types. The package retains the
Ambion dependency for its root adapter.

This adds no package, generic resource framework, or second lifecycle.
Pi harness tools and execution environments retain their existing contracts.
Further extraction requires a second consumer with a concrete need.

**Validation:** 39 workspace tests pass. Existing lifecycle tests retain
facade coverage. Added tests cover a backend without tools and shared queue
revocation across direct operations and bound tools. Typechecks and the build
pass. The packed consumer compiles both public entries and exercises memory
and directory resources while rejecting Ambion imports. The root facade,
generated CLI project typecheck, and Wrangler dry run pass. Independent
Luna/High review found no blockers. `pnpm format` and `pnpm check` pass.
Import probes reject Ambion and adapter imports from resource and backend modules.
All seven CI checks pass, including live provider tests.

### Keep the release surface deliberate

| Previous or current structure                     | Proposed treatment                        | Reason                                                                |
| ------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `AgentSeat`, `SeatedAgent`, three seating helpers | Remove                                    | Membership is plain room configuration                                |
| `seats()` / `SeatInfo`                            | `participants()` / `ParticipantInfo`      | The returned view includes humans and agents                          |
| `SeatActor`                                       | `AgentRunner` within Pi integration       | Names execution rather than durable membership                        |
| `ActivationSpec` plus repeated grants             | One canonical activation value            | One discriminator determines authority                                |
| `wire.ts`                                         | Split protocol values from journal events | Network requests and persisted facts have different contracts         |
| Broad `RunningRoom` / `Answering` interfaces      | Narrow calls and explicit dependencies    | Adapters cannot reach arbitrary host state                            |
| `Close.wakes[0]` internally                       | `summaryBy`                               | A close designates at most one summary writer                         |
| `Composition` internally                          | `RoomConfiguration`                       | Names the durable configuration fact directly                         |
| `journal/pi`                                      | `pi-journal` package                      | Pi storage has a separate consumer and dependency set                 |
| Local development CLI                             | Publish with the Cloudflare adapter       | Local project creation and room testing follow [the CLI plan](cli.md) |

**Preserve useful established names.** Keep room, agent, visit, exchange,
attention, and journal. Do not rename human to person or attention to routing
merely for stylistic consistency.

Keep transport details behind the existing `/transport` subpath. The current
slice removes persisted event and lease projection exports from that surface.
The published Cloudflare adapter supports the local CLI. Keep deployment
commands outside this local development milestone.

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
does not itself replace source messages. Summary execution reads its fixed
range. Ordinary execution reads the context allowed by its response activation.

**Human participants can review the original exchange.** Keep all source
messages in the journal and expose the fixed discussion through
`exchange.messages()`. Clients can expand a summary into that discussion for
review. This does not restore the source range to later agent activations.

Verify that rendering and client reads preserve this distinction. Summaries
and uncovered messages accumulate, so context size can still grow. State that
limit explicitly. A future retention policy must preserve human review and
recovery guarantees. Do not make a context-management framework a release gate.

### Make values safe to retain

**Merged:** [PR #132](https://github.com/ambionframework/ambion/pull/132).

**Protect facts at ownership boundaries.** Room reads,
exchange results, protocol replies, notifications, and steering now detach
collaboration values. Copies include nested source ranges and routing arrays.
Commit and lease requests, read filters, and seating options are captured
before asynchronous work. Each notification listener and steering recipient
receives its own value. Error notifications preserve the original exception.

The change adds no public type, lifecycle state, or storage format. Internal
projections stay shallow. Existing public signatures let callers edit their
own copies without changing the room or another consumer.

**Validation:** all seven CI checks pass, including live provider tests.
Ten public ownership regressions fail on the previous code across memory and
SQLite. All 24 ownership tests pass after the fix. They cover reads, summaries,
open exchanges, listener isolation, commit replies, missed context, steering,
and request capture. They compare live values with independent journal replay.
`pnpm check` passes, including 610 core tests and 18 workerd tests. Expanded
recovery passes all 728 tests.

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

### Completed foundations

The shared projection and dispatch rules, fixed definitions, normalized tools,
conditional journal appends, activation purpose, and structured context are
implemented. Sections 2–5 and 7 retain their behavior and test evidence.

### Completed: isolate audit failures

Merged in [PR #126](https://github.com/ambionframework/ambion/pull/126) and
present on main at `662e427`. Execution outcomes are separate from transcript
writes; bounded audit retries preserve collaboration completion.

### Completed: simplify participation

PR #128 implements shared seating, closing publication through `say`, and
ordinary membership with an optional closing assignment. Selection and
special opening dispatch are removed.

**Evidence:** concurrent seating records one membership change. Restart,
writer removal, and overlapping ordinary and closing work preserve completion.
Summary boundaries, recipient preferences, and source review stay intact.

**Validation:** see section 5 for the current checks and regression coverage.
PR #128 contains the implementation and integration with the CLI template.

### Stage 2: isolate execution and extract transcript storage

- Preserve the executor boundary and validation merged in PR #130.
- Preserve protocol and stored-event separation merged in PR #133.
- Preserve Pi transcript extraction and audit isolation merged in PR #131.
- Preserve workspace resource and tool separation merged in PR #134.

**Evidence:** run the same scripted collaboration in process and through
Cloudflare's JSON boundary. Audit failure after a committed answer cannot
restart reasoning by itself. Context acknowledgement remains exact.

### Stage 3: finish state ownership and recovery

- Isolate mutable host resources from immutable collaboration facts.
- Protect returned values and validate contributions at commit.
- Finish the recovery procedures and failure cases in section 9.

**Evidence:** returned values cannot mutate room state. The same recorded
history produces the same membership, pending work, exchange boundaries,
and responses. Recheck uncertain appends, removal, retries, and writer takeover.

### Stage 4: make the release explain itself

- Update the implemented contracts after their changes land.
- Provide one short example with two specialists, a person, and an optional summary writer.
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
- [x] Include the CLI and Cloudflare adapter in lockstep package discovery.
      Use `ambion new` as the only project-creation path.
- [x] Publish `0.1.0-alpha.1` under `next` through the release workflow.
      [The release check](https://github.com/ambionframework/ambion/actions/runs/35059680708)
      verified registry installation, project types, and the generated Worker bundle.
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

**Prepared for review: document and test the host recovery contract.**
[`deployment.md`](../docs/deployment.md#restore-human-presence) describes
restoring visits, confirming departures, recovering exchange handles, and
replaying client history. It distinguishes per-client acknowledged cursors
from `Visit.since`, which records the person's last departure.

Recovery preserves an unexpired lease for a surviving remote runner. A lost
local runner waits for expiry before retry. Calls must reach the current room
host. No recovery mode, scheduler state, or presence timeout is added.

**Evidence:** 14 reconnect tests and four inherited-lease tests exercise
public APIs on memory and SQLite. A process test saves client identifiers,
kills Node with an active lease, and recovers through a fresh process over
SQLite. History replay and live notifications merge by sequence without
losing a message or displaying an overlap twice. Independent review found
no runtime blocker, and this slice changes no runtime API or behavior.

The process test uses a scripted model and explicit clock. A concise
application example and real-model restart test remain separate release
requirements. `pnpm format` and `pnpm check` pass with 629 core tests,
18 workerd tests, 39 workspace tests, 30 journal tests, 20 Pi session tests,
and six CLI tests. The new recovery coverage accounts for 19 core tests.

- [ ] Provide a persistent Node example that restarts over SQLite, supplies
      definitions again, resumes pending work, and reacquires exchange handles.
- [x] Define the host procedure for reconciling recorded human presence with
      surviving connections. A crash must not invent a departure or lose attribution.
- [x] Specify how local and separated hosts treat inherited leases. Preserve
      authority for a remote runner that may still be alive. Avoid a generic
      “revoke everything” shortcut that changes retry semantics.
- [ ] Test two rooms using the same agent name with different definitions.
      Local lookup must stay scoped to the room. Remote hosts must document how
      deployed definitions match the room configuration.
- [ ] Test reads and resume attempts for an unknown room name. Define the
      missing-room result and prevent accidental composition or audit creation.
      Do not add another storage operation unless current adapters require it.
- [x] Demonstrate reconnect through message reads and exchange lookup. Verify
      interruption behavior for waiters when a host stops or is superseded.
- [ ] Test one runner owner per room and seat, including duplicate wakes,
      takeover, and delayed cancellation. Keep transcript identity stable across
      audit-write retries.
- [ ] Document application ownership of credentials, network authentication,
      tool-effect idempotency, and shared workspace lifecycle. Examples must not
      imply that a room lease fences a remote API or another process's filesystem.

**Done when:** the supported deployment examples demonstrate recovery with
their real storage and topology. Record their evidence separately from the
Cloudflare adapter tests.

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
- [x] Retain whole-operation serialization, cleanup after failures, and the
      distinction between `dispose` and `destroy` while extracting tool binding.
      Section 6 records the implementation and validation merged in PR #134.
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
| Cloudflare deployment commands                                         | The adapter supports local CLI use; managed deployment needs configuration and operational evidence                  |

## 11. Disposition of the previous backlog

**This file replaces the old backlog and release review.** Historical item
numbers below provide traceability. Their old measurements and diagnoses are
not carried forward as current facts.

| Previous items                                                            | Disposition                                                                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 2, 3, 27: folds, history growth, room coupling                            | Sections 2–6 own structural work; section 9 owns measurement; bounded history remains deferred                  |
| 4: eager provider loading                                                 | Already addressed on main; retain an import regression check                                                    |
| 6, 7, 9, 10, 11, 12, 44: dependencies, tests, packaging, platform, docs   | Section 9 owns the remaining release tasks; retire stale paths and export claims                                |
| 13–17: preferences, roster changes, assistant participation               | Section 5 moves closing work to ordinary agents; broader preferences and removal policy remain deferred         |
| 20, 25, 51: roles and multiple writers                                    | Section 5 removes special membership and selection purpose; generic roles and multiple writers remain deferred  |
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
