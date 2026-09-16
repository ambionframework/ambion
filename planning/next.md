# Next: simplify Ambion for 0.1.0

Reviewed against main `0c98c73`, 2026-09-16, using the
[Relay demo](../examples/persistent/README.md) as the representative application.
Three independent Astra/High reviews covered kernel correctness, application
APIs, and package/executor boundaries. This is a plan, not an implementation or
release certification. [release-0.1.0.md](release-0.1.0.md) remains the scope.

## Direction

**Make the collaboration kernel complete enough that applications do not have
to reconstruct its rules.** Relay should choose identities, rooms, and display
policy; send ordinary messages; read collaboration state; and own its files.
It should not infer completion from a summary, repair presence semantics, or
understand an executor's transcript identity.

Keep the small model: definitions supply behavior, rooms record collaboration,
humans visit and send messages, exchanges bound discussion, and resources hold
domain artifacts. Activations and leases implement execution. They are not a
second task system for the application to manage.

The test for a simplification is **which obligation disappears for a caller or
which source of truth disappears from the implementation**. Fewer method names
alone is not success. Do not collapse distinctions that carry different authority
or lifetime: discussion versus summary, definition versus membership, connection
versus presence, and journal commits versus external effects.

## Priorities

| Order | Work                                                     | What becomes simpler                                                                      | Size                     |
| ----- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------ |
| 1     | Make presence and control acknowledge durable completion | Callers can trust join, leave, stop, and cancellation without protective room-wide queues | Small–medium             |
| 2     | Provide one coherent room and exchange read model        | Relay and Cloudflare stop reconstructing completion and copying history for status        | Medium                   |
| 3     | Finish host/executor ownership and participant naming    | The room no longer constructs Pi execution; participant views contain collaboration facts | Medium                   |
| 4     | Reduce repeated projection work where measured           | One replayable interpretation supports cheap ordinary reads and updates                   | Bounded by measurements  |
| 5     | Close release evidence and consumer gaps                 | Supported configurations are proven from shipped packages                                 | Small independent slices |

**Start with item 1.** The review reproduced correctness failures there. Item 2
is the largest product-facing simplification and should follow immediately.
Do not turn this into another general architecture rewrite before release.
Keep item 1 reviewable: land lifecycle/sender regression fixes first, then
consolidate submission and effect publication in a separate slice.

## 1. Make durable acceptance the public operation boundary

### Findings

[`RoomHost`](../packages/ambion/src/room.ts) serializes journal writes, but some
public operations publish host-local state before those writes succeed:

- `visit()` caches a visit before awaiting its arrival. In an executed review
  reproduction, a second concurrent visit returned while that arrival was
  blocked. Rejecting the arrival and sending through the second handle committed
  a message from an unrecorded human, then rejected because it had no exchange.
- `endVisit()` marks its handle gone before committing departure. Rejecting that
  write and retrying the same `leave()` resolved successfully while the journal
  still reported the human present.
- `stop()` changes phase before completing revocation and departures. With a
  departure append blocked, a second `stop()` resolved while the first was still
  pending and the human was still present.
- `abort(): void` discards the asynchronous revocation result. This is a source
  finding; the review did not execute an abort-write-failure reproduction.

The first three were reproduced against source with a gated memory storage
adapter. They are not yet checked-in regression tests. Relay's per-room queue
masks some concurrency paths; an embedded library caller has no such protection.

### Change

- [ ] Make concurrent join, departure, and stop calls share their in-flight
      operation where appropriate. Do not return usable visit handles or report
      terminal success before their durable operation is confirmed. Resolve
      uncertain writes through the existing journal recovery contract. Close
      admission immediately when needed, but let concurrent callers observe the
      same completion/failure and let a retry finish outstanding durable work.
- [ ] Validate the human sender's recorded presence in the delivery decision,
      inside the serial commit boundary. A handle's local `gone` flag is not
      sufficient authority. Preserve exact-key retries of already committed
      deliveries through a valid visit without creating another message.
- [ ] Put semantic contribution validation in those decisions for both human
      and agent speech. Currently Relay and the `say` tool reject blank text,
      but direct API/protocol calls can bypass that rule. HTTP shape/size limits
      and client-generated delivery keys remain application policy.
- [ ] Make `abort()` awaitable. Its completion means the defined cancellation
      boundary has been durably applied, not that an uncooperative external tool
      has stopped or undone its effects. Specify ordering against concurrent
      sends and newly owed work; do not invent exchange-local cancellation.
- [ ] Provide a narrow way to use an already-present human without causing an
      arrival. Prefer one option on the existing visit operation over a new
      presence/session hierarchy. It must reject an absent human atomically;
      explicit entry remains the ordinary joining operation. For 0.1.0, a fresh
      HTTP send after departure still requires explicit re-entry, even if it is
      retrying a lost acknowledgement. Once re-entered, the same key returns the
      original exchange; the retry must not add speech or implicitly restore
      presence. A delivery key is not an identity credential.
- [ ] Consolidate the bespoke message/lease/close append adapters into one
      internal submission path using the journal's existing entry/result return.
      Keep expected refusals as data until the public API or protocol boundary;
      remove the decision → `RefusedError` → protocol-result round trip.
      Storage failures remain errors. Do not build a generic command bus.
- [ ] Apply confirmed entries before the next decision, then drain ordered
      notification and transport effects outside the write decision. Today the
      journal's synchronous `hear` callback can construct transport ports during
      append processing. A throwing connector must not turn a persisted message
      into an apparent commit failure. Keep recovered writes on the same
      publication path, without adding another durable queue.
- [ ] Remove Relay's read-presence-then-join workarounds once the contract covers
      them. Retain host serialization needed for catalog changes, start/stop
      admission, and shutdown. Never hold that queue while waiting for a model.

**Verification:** reproduce all three failures first, then pass equivalent
memory and SQLite fault tests, including failure before append and lost
confirmation after append. Cover join/join, join/stop, send/leave, leave/retry,
stop/stop, abort/send, and failed revocation. Retain reconnect, inherited-lease,
late steering, notification ordering, and tool cancellation evidence.
Also cover semantic rejection through direct/protocol/tool calls, throwing
transport connection, and reentrant listeners without commit-queue deadlocks.
Include committed-send → departure → lost-acknowledgement retry: reject while
absent, then return the original result after explicit re-entry. Previously ended
visit handles remain invalid even when the same human enters again.

**Done when:** no successful presence/control response depends on a host-local
flag that disagrees with the confirmed journal. Failed commands cannot leave
orphan human speech. Ordinary API callers need no extra queue to get that safety.

## 2. Make room and exchange state directly readable

### Findings

[`RoomSnapshot`](../packages/ambion/src/room.ts) exposes messages, participants,
and the open exchange. Closed ranges and summary outcomes exist inside the
kernel but are only partially exposed through live waiting handles.

Consequently:

- Relay's [`timelineGroups`](../examples/persistent/index.html) discovers
  discussion groups from `summary.covers`. A declined, absent, or failed summary
  leaves it without the same completion/grouping information.
- [`RoomObject.status`](../packages/cloudflare/src/room-object.ts) invents its
  own `idle | working | completed` interpretation by comparing exchange IDs.
- Relay can read stopped messages but its exchange route requires a live room.
- [`rooms.ts`](../examples/persistent/src/rooms.ts) reads and copies all messages
  for every room's status; incremental message reads copy the history before
  filtering. Separate status and message requests need not represent one moment.
- A close or terminal summary lease can change the answer without producing
  another visible message. A message cursor alone cannot describe those changes.

### Change

- [ ] Define one detached, serializable exchange view using existing close and
      [`summaryCompletion`](../packages/ambion/src/room/exchange.ts) queries.
      Represent open/closed discussion and the fixed closed range separately
      from pending/published/silent/failed summary outcome. Preserve opening
      identity, owner, timestamp, and the published summary reference.
- [ ] Make completed exchanges readable from stopped storage without starting
      agents. Live `exchange.messages()` and `exchange.response()` remain waiting
      conveniences over the same interpretation, not competing state machines.
- [ ] Extend the existing room-read surface with coherent metadata, participant
      and exchange views, and optional messages after an exclusive cursor. Return
      a journal watermark for the committed facts observed, including non-message
      changes. Do not introduce a second counter or a generic patch/feed protocol.
- [ ] Specify cursor scope, full initial read, overlap handling, invalid/future
      cursor behavior, and old exchanges whose summary changes after a newer
      exchange opens. A first implementation may return complete selected
      exchange metadata with incremental messages; correctness precedes paging.
      The watermark is not a whole-response cache validator: activity derived
      from lease expiry can change with time before another entry lands. Return
      time-derived metadata afresh and keep host diagnostics separate.
- [ ] Make status-only reads avoid copying message history. Apply range selection
      before detaching values. Use the same query functions for running and
      stopped rooms; host-local tool activity remains diagnostic data.
- [ ] Distinguish a missing room from an initialized empty room, and expose
      recorded public metadata such as the goal. Reads must not compose a room,
      start execution, or create audit sessions. Use existing storage operations
      unless an actual adapter limitation requires more.
- [ ] Replace Relay's summary-based grouping and Cloudflare's completion inference
      with that view. Keep collapse controls, a direct single reply, human prompts,
      and final-answer presentation in the UI. Closure does not certify quality.

**Verification:** no summary configured, writer declines, writer removed,
exhausted/failed summary, silence, one reply, multiple humans, a late summary
beside a newer exchange, and stopped-room reads. Check close-only and
lease-only watermark advances; consistent cuts during writes and recovery;
reads on either side of lease expiry without an intervening append;
retained snapshots cannot be mutated into room state; local/JSON and
memory/SQLite parity. Existing [summary query tests](../packages/ambion/test/summary-completion-query.test.ts)
are the starting point, not a reason to add another completion implementation.

**Done when:** both product clients can explain a completed discussion without
finding a summary or consulting activation events. Room-list polling does not
copy every conversation. The journal remains the only durable authority.

### Simplify Relay's catalog after the read contract exists

Relay correctly owns room discovery and desired running/stopped state. Its
`goal` and `started` fields also duplicate journal facts. A crash after composition
commits but before `started` is saved deserves an explicit recovery case.

- [ ] Use the recorded metadata/existence result to recover partially completed
      creation and choose start versus resume. Delete duplicate catalog facts
      where possible; retain provisional creation intent if needed to recover a
      catalog insertion that preceded the journal. Do not pretend both writes
      are one transaction or erase the initialization gap by renaming it.
- [ ] Keep hosting intent, credentials, identity selection, HTTP authorization,
      file previews, and shutdown resource ownership in the application.

No kernel catalog, room supervisor, HTTP framework, or browser SDK is needed.
Outbox persistence, stale HTTP-response suppression, and navigation intent are
real client concerns and remain in Relay. Shared files do not imply shared
conversation context or cross-room atomicity.

## 3. Finish ownership boundaries and names

### Compose execution outside the room

The earlier executor separation is real, but `RoomHost` still stores `stream`,
`model`, and `transcripts`, chooses `inProcessTransport`, and constructs a large
`SeatContext`. Cloudflare's runner creates a runtime to obtain execution
services, while its RPC connector only needs room/agent identity.

- [ ] Move Pi model resolution, provider calls, transcript setup, and local runner
      construction into execution composition. Give the room a configured
      connector that captures those services and returns execution ports.
- [ ] Remove those fields/imports and the local-executor fallback from
      `RoomHost`; remove the temporary room runtime from Cloudflare runner setup.
      Preserve fixed per-run definitions, room-specific scripted streams, and
      room-local lookup of identically named agents.
- [ ] Keep a thin default facade: ordinary applications still define agents and
      start rooms without manually assembling an executor. Advanced placement
      continues through the existing hosting/transport boundary.
- [ ] Organize internal components by ownership: pure collaboration queries and
      decisions, journal/host effects, and Pi execution. Move `seat/` execution
      code to `execution/` and use `AgentRunner` for `SeatActor` when touching
      that boundary. Membership is a seat; execution is a runner.

**Verification:** import checks forbid Pi execution/transcript imports from
room policy and `RoomHost`; host execution composition may import them. Default imports retain lazy provider
loading. Preserve executor, protocol, steering, provider, audit-isolation,
restart, and workerd tests. Check generated declarations as well as source.
The default execution path must remain shorter to explain than the extension path.

### Finish the participant vocabulary

`participants()` still returns `SeatInfo`, including humans. Its agent variant
also exposes a Pi `sessionId`; the protocol then explicitly omits that field.

- [ ] Rename to `ParticipantInfo`, `AgentParticipantInfo`, and
      `HumanParticipantInfo`; rename the internal query to `participantsOf`.
- [ ] Remove transcript IDs from participant views. Move `seatSessionId` from
      the root API to explicit execution/audit access through the existing
      hosting entry. Preserve its stored identity algorithm and transcript names.
- [ ] Delete old aliases during the pre-0.1 migration, update both clients and
      declarations, and document the source break. Do not rename agent, human,
      visit, exchange, attention, or journal for cosmetic consistency.

**Type safety:** retain discriminated participant, exchange, and outcome values;
make illegal combinations unrepresentable instead of adding optional fields to
one status bag. Keep typed tool schemas and one normalized tool representation.
Names arriving over HTTP still require runtime validation; a TypeScript brand
is not authorization. Keep Pi execution construction and transcript types out
of collaboration interfaces. Retain the supported Pi result/update types in
tool authoring and `fromPiTool`; do not invent a second provider-neutral tool SDK.

### Extraction decisions

| Component                       | 0.1.0 treatment                                                     | Rationale                                                                                               |
| ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Generic journal                 | Keep existing independent package                                   | Ordered storage, idempotency, fencing, and recovery already have a standalone consumer                  |
| Pi transcript storage           | Keep existing `pi-journal` package                                  | Audit persistence has a different vocabulary and consumer from collaboration                            |
| Collaboration queries/decisions | Cohesive internal module in `ambion`                                | One semantic authority; another npm package would add a public contract without a new consumer          |
| Host and Pi runner composition  | Separate internal components; keep default facade and hosting entry | Local and Cloudflare placement already exercise the seam; no plugin registry required                   |
| Workspace resource and tools    | Keep one package and existing `/resource` entry                     | One resource owner/queue already serves direct access and bound tools; do not re-extract completed work |
| Relay HTTP/outbox/catalog       | Keep in the example                                                 | Authentication, network retry policy, and discovery belong to the application                           |
| Shared browser/CLI rendering    | Keep presentation local                                             | Reuse exchange data, not a UI state framework                                                           |

A future independently distributed Pi executor or workspace adapter needs an
actual consumer and a dependency/installation benefit. File separation alone
does not justify another package. No new public package is required by this plan.

## 4. Remove repeated work without adding a second state model

[`evolve`](../packages/ambion/src/room/transition.ts) copies base collections and
calls `project`; [`project`](../packages/ambion/src/room/fold.ts) refolds people,
membership, exchanges, and pending work. Each closed exchange can scan messages
and leases again. This is a code observation, not a measured latency claim.

- [ ] First measure Relay-shaped histories at stated room/message/lease counts:
      cold replay, unchanged polling, append/renewal cost, memory, and provider
      input size. Separate status-copy cost from projection and model latency.
- [ ] After item 2 removes unnecessary reads/copies, update only the affected
      parts of the projection where measurements justify it. Keep indexes inside
      the same disposable projection; no independently persisted status tables.
- [ ] Keep replay/application pure: confirmed entry plus prior state gives new
      state; time and retry policy are explicit decision/query inputs. Remove
      redundant conversions and catalog unions before adding caches.
- [ ] Compare incremental results against full replay over generated histories,
      retained earlier values, and fault/restart cases. Preserve public value
      detachment while avoiding copies of data the caller did not request.

Roster/reserve and pending/owed/due are derived views, not automatically separate
sources of truth. Do not redesign composition-v2 or add checkpoints merely to
reduce field count. Membership recovery and existing journals are more valuable
than cosmetic schema normalization.

**Done when:** publish measurements and supported limits. Any optimization must
remove measured repeated work and retain a replay oracle. Unbounded history and
context remain explicit 0.1.0 limits; this is not a retention-system project.

## 5. Release gates still required

### Package and platform readiness

- [ ] Exercise minimal packed consumers outside the monorepo: journal alone,
      Pi sessions with journal, embedded Ambion, Relay-style persistent Node with
      journal/workspace, and the generated CLI/Cloudflare project. Existing
      independent journal/resource and generated-project checks remain evidence.
      Do not rely on a fixture declaring all six packages directly to prove
      Node consumers' dependency closure.
- [ ] Resolve or explicitly justify the two TypeBox versions (`1.3.7` and
      `1.3.18` in the reviewed lockfile) through authored-tool declaration and
      runtime tests. Replace the cast-based `stubModel` with a valid scripted
      model owned by execution/test composition. Do not hide incompatible
      declarations behind `skipLibCheck` without recording the reason.
- [ ] Check ESM exports, migration breaks, forbidden imports, versioning, packed
      contents, release discovery, and GitHub Packages read-token instructions.
      Preserve lazy provider loading and the existing lockstep CLI/Cloudflare
      publication path; do not create a second package list.
- [ ] State and verify supported runtimes separately: library Node 22.19+,
      Relay/tooling Node 26.4+ as currently documented, and Cloudflare with its
      actual workerd compatibility settings. A Node filesystem is not a Worker
      filesystem. Do not claim the Node 22 test job proves every Node 26 example.
- [ ] Narrow tooling cleanup to remaining gaps: Relay is already in Knip;
      inspect other examples, remove the unused `dev` task contract if still
      unused, and remove redundant builds only against actual test inputs.

### Recovery, failure, workspace, and context evidence

- [ ] Extend the existing runner-ownership tests only for uncovered combinations
      of duplicate wakes, takeover, delayed cancellation, and audit retry.
      Preserve a surviving remote runner's valid lease; do not revoke all leases
      at restart to make local recovery appear faster.
- [ ] Reproduce the historical Cloudflare wake/cut races and duplicate
      activation-end report on current code before diagnosing them. Keep seeds
      and ordering traces. Move `hold`/`wakes`/`cuts` test controls out of production
      adapter state where feasible; increasing timeouts is not a fix.
- [ ] Add any missing clock-skew/process-pause and uncooperative-tool cases.
      Separate authority safety from recovery latency; files and remote effects
      are not part of the journal transaction.
- [ ] Verify `/dev/null` on both workspace backends; fix growing ordinary-file
      behavior if reproduced. Retain whole-operation serialization and
      dispose-versus-destroy tests. Do not replace resource ownership with runtime
      auto-discovery or agent-owned cleanup.
- [ ] Audit summary-context coverage for silence, corrections/conflicts, multiple
      humans, overlapping later work, original discussion review, and readable
      message numbering. Add missing cases rather than duplicate existing tests.
- [ ] Run `pnpm check`, targeted chaos sweeps, and proofs for changed rules.
      Preserve the real-provider restart gate and exercise Relay after the API
      changes. Record exact commands, commit, result, environment, and remaining
      limits; a historical passing count does not certify the final release.

### Documentation and scope sign-off

- [ ] Audit root/package READMEs, generated examples, and design contracts against
      final APIs; they already use the collaboration-kernel narrative. Typecheck
      actual snippets. Extend existing migration notes with the new read/control
      contracts and participant names; state any real storage/protocol break.
- [ ] Update stale progress claims in the scope document, including participation
      described as in progress. Explain accepted versus completed operations,
      silent/failed summaries, shared identity presence, room-wide cancellation,
      local diagnostics, deployment ownership, and effect idempotency consistently.
- [ ] Sign off F1–F9: definitions/tools (F1/F6), presence and concurrent delivery
      (F2/F3), exchanges (F4), persistence (F5), observation/control (F7), supported
      deployment models (F8), and packed distribution (F9). Every gate needs
      landed implementation and reproducible evidence before publishing 0.1.0.

## Already delivered: preserve, do not schedule again

- Fixed definitions and name-based membership; typed normalized tools; separate
  activation and steering; structured executor context; conditional journal
  appends; detached public values; separate protocol and stored event shapes.
- Independent journal and Pi transcript packages; workspace resource/tool
  separation; audit failure isolation; documented reconnect and inherited-lease
  procedures. Existing packed tests prove several of these boundaries.
- Relay and real-model restart validation merged in PR #136. The README flow
  explanation landed in `0c98c73`. This is now the reference consumer, not an
  unfinished “persistent Node example” task.
- Same-named agents with different definitions already have coverage in
  [`bindings.test.ts`](../packages/ambion/test/bindings.test.ts); missing-composition
  resume rejection is covered in [`restart.test.ts`](../packages/ambion/test/restart.test.ts).
  Missing-room read semantics and partial creation remain item 2.
- The CLI/Cloudflare prerelease and package discovery exist. Packed checks and
  migrations need updates for actual changes, not another initial extraction.

### Simplify participation and closing work

This earlier scope-linked work is complete: every agent has ordinary membership,
can seat/unseat colleagues, and speaks through `say`. A closing activation has
bounded context and publication authority. Keep that model; neither Relay's
coordinator nor its optional summary writer becomes a privileged assistant type.

## Deliberately outside this release

- A scheduler, business-task database, workflow graph, generic role registry,
  hot-loaded definitions, multiple summary writers, or multiple simultaneous
  discussions within one room. None removes a demonstrated Relay obligation.
- Per-tab presence tokens, heartbeat expiry, automatic departures, or a managed
  connection service. Shared human presence and client navigation are different
  concerns; add a new presence model only for an explicit product requirement.
- Automatic summary skipping based solely on message count. One internal reply
  may still need a human-facing answer or preferences. First remove the UI's
  dependence on summary existence; measure redundant closing calls before
  changing their semantics. A direct single-reply display remains supported.
- New client/executor/plugin frameworks, distributed workspace ownership,
  credential brokers, stronger sandbox backends, and turnkey deployment commands.
  Each needs an independent consumer and operational contract.
- Retention/checkpoints/retrieval, exchange budgets, broader preference routing,
  roster-thinning policies, manual summary retry, Pi AgentHarness adoption,
  JSONL repair, and a custom property-test shrinker. Revisit only with measured
  limits or a concrete failing case, not as prerequisites for conceptual polish.

**Release criterion:** Relay becomes a smaller application because Ambion owns
its collaboration semantics completely. The default path remains easy to teach,
while the durable and remote execution contracts retain their precision.
