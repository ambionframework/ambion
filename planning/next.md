# Next: simplify Ambion for 0.1.0

Reviewed against main `3391145`, after
[PR #143](https://github.com/ambionframework/ambion/pull/143) merged.
The [Relay demo](../examples/persistent/README.md) is the reference consumer.
Two follow-up Astra/High reviews and isolated SQLite/browser reproductions
revisited the earlier subsystem review. Findings below distinguish reproduced
failures from proposed contracts. [release-0.1.0.md](release-0.1.0.md) owns scope.

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

## State ownership and assumptions

**The journal remains the source of active collaboration.** Pure queries derive
presence, membership, discussion boundaries, and execution obligations from it.
A scheduler or another durable status store would duplicate that authority.

| State                                                | Owner               | Recovery                                                             |
| ---------------------------------------------------- | ------------------- | -------------------------------------------------------------------- |
| Selected human/room, drafts, pending HTTP deliveries | Browser application | Restore saved intent; retry delivery keys; refresh views             |
| Room discovery and desired running/stopped state     | Relay catalog       | Reopen selected rooms; retain provisional creation parameters        |
| Presence, membership, speech, closes, leases         | Room journal        | Replay recorded facts; resume pending obligations                    |
| Handles, admission queues, timers, subscriptions     | Host process        | Reconstruct services; retain failed cleanup ownership until resolved |
| Model transcripts                                    | Pi journal          | Restore execution audit independently of collaboration               |
| Shared domain files                                  | Workspace resource  | Reopen the directory; serialize individual operations                |

**Commands and reads have different effects.** Entry ensures presence through
idempotent `visit`; sending contributes through that visit. Departure ends shared
presence. Polling should observe those facts. A selected room is browser intent;
it does not prove that the human remains present.

**A summary is an optional result of a closed discussion.** Its absence cannot
identify an open discussion. Both states must be readable from journal facts.

**Successful control requires completed durable work.** An empty host handle
slot does not prove that stop recorded departure and revoked execution authority.
Creation likewise spans a catalog write and a journal append. Recovery must
inspect their separate outcomes.

**Shared files remain application state.** All Relay rooms use one workspace
owner. Its queue orders individual operations. Multiple tool calls and journal
entries do not form one transaction, and rooms retain separate conversation context.

## Priorities

| Order | Work                                                              | What becomes simpler                                                                      | Size                  |
| ----- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------- |
| 1     | Repair Relay stop retries and separate polling from entry         | Commands retain cleanup ownership; observation cannot undo departure                      | Small slices          |
| 2     | Provide coherent room/exchange reads and recover partial creation | Clients use recorded completion; catalog initialization stops competing with the journal  | Medium, staged        |
| 3     | Finish cancellation and contribution validation                   | Direct callers can trust control completion and contribution rules                        | Bounded slices        |
| 4     | Finish host/executor ownership and participant naming             | The room no longer constructs Pi execution; participant views contain collaboration facts | Medium                |
| 5     | Reduce repeated projection work where measured                    | Ordinary reads and updates reuse one replayable interpretation                            | Measurement dependent |
| 6     | Close release evidence and consumer gaps                          | Supported configurations are proven from shipped packages                                 | Independent slices    |

**Items 1–2 merged in PRs #140–#142:** failed-stop recovery, explicit browser
entry, coherent room/exchange reads, and partial-creation recovery.
Item 3 defines cancellation through one atomic journal entry, merged in
PR #143. The stop cleanup fix is prepared for review. Contribution validation
is next.

## 1. Keep commands and observation coherent in Relay

### Findings

**Failed stop loses its retry owner.** `stopEntry` clears `entry.room` in
`finally`, including when a departure append fails. The kernel permits retrying
that handle. Relay discards it and the next stop reports success without retrying.

An isolated SQLite reproduction injected one failure before departure committed.
The first stop rejected. The second returned `stopped`, with the human still
present and zero departure entries. No model calls occurred.

**Polling can undo a shared departure.** The browser's `refreshSelectedPresence`
calls join whenever its selected room reports the human absent. A browser-script
reproduction with an already restored selection issued `PUT .../humans/alice`
during polling. A departure in another tab can therefore cause automatic reentry.
The kernel's shared-presence contract is correct; Relay must choose entry policy.

### Change

- [x] Retain ownership of a failed stop until its durable cleanup succeeds.
      Prevent ordinary admission through a stopped or failed handle. Repeated
      stop requests must retry cleanup and report its actual result.
- [x] Define resume and shutdown behavior while cleanup remains unresolved.
      Separate desired hosting state from running state and failed cleanup.
      Do not let handle existence alone determine either admission or success.
      Save stopped hosting intent after cleanup. An unacknowledged stop can
      resume after restart and remains retryable.
- [x] Keep polling read-only. Enter on room selection or deliberate restoration
      after reload. If a later snapshot reports absence, require deliberate
      reentry before sending again. Show that state in the composer.
- [x] Pause queued delivery after a presence rejection. Retain its original key
      and text; retry after explicit entry. A rejected late send must not cause
      polling to recreate presence and flush the message automatically.

Keep one idempotent `visit(human)` operation. It ensures presence; `send`
contributes through that visit; `leave` ends it. Add no lookup mode or per-tab
presence token. Relay owns serialized checks for navigation, catalog changes,
and lifecycle admission. Never hold that queue while waiting for a model.

**Verification:** inject stop failures before append and after commit; retry
through HTTP; test concurrent stop, resume, and shutdown. Preserve newer-run
fencing. Exercise two tabs sharing one human, deliberate reload restoration,
late sends, and polling after departure. Assert absence and original delivery
keys, not only HTTP status or local flags.
After committed send → departure, the same-key retry must reject while absent.
After explicit reentry, it returns the original exchange without another message.
The ended visit handle remains invalid.

**Done when:** a successful stop confirms durable cleanup, and background reads
cannot recreate presence. Both behaviors use the existing kernel contracts.

## 2. Make room and exchange state directly readable

**Merged in PR #142:** one detached read contract supplies initialization,
metadata, exchange outcomes, and selective messages. Relay and Cloudflare use
these journal facts; live exchange handles retain their waiting contracts.

### Findings

Before this change, `RoomSnapshot` exposed messages, participants, and the open
exchange. Closed ranges and summary outcomes existed inside the kernel but were
only partially exposed through live waiting handles.

The resulting caller obligations were:

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

- [x] Define one detached, serializable exchange view using existing close and
      [`summaryCompletion`](../packages/ambion/src/room/exchange.ts) queries.
      Represent open/closed discussion and the fixed closed range separately
      from pending/published/silent/failed summary outcome. Preserve opening
      identity, owner, timestamp, and the published summary reference.
- [x] Make completed exchanges readable from stopped storage without starting
      agents. Live `exchange.messages()` and `exchange.response()` remain waiting
      conveniences over the same interpretation, not competing state machines.
- [x] Extend the existing room-read surface with coherent metadata, participant
      and exchange views, and optional messages after an exclusive cursor. Return
      a journal watermark for the committed facts observed, including non-message
      changes. Use `Journal.lastSeq`, the accepted journal sequence. Preserve
      `RoomState.lastSeq`, the message cursor used for close boundaries. Do not
      introduce a second counter or a generic patch/feed protocol.
- [x] Specify cursor scope, full initial read, overlap handling, invalid/future
      cursor behavior, and old exchanges whose summary changes after a newer
      exchange opens. A first implementation may return complete selected
      exchange metadata with incremental messages; correctness precedes paging.
      The watermark is not a whole-response cache validator: activity derived
      from lease expiry can change with time before another entry lands. Return
      time-derived metadata afresh and keep host diagnostics separate.
- [x] Make status-only reads avoid copying message history. Apply range selection
      before detaching values. Use the same query functions for running and
      stopped rooms; host-local tool activity remains diagnostic data.
- [x] Distinguish a missing room from an initialized empty room, and expose
      recorded public metadata such as the goal. Reads must not compose a room,
      start execution, or create audit sessions. Preserve an open exchange in
      stopped storage until a recorded close exists. Use existing storage operations
      unless an actual adapter limitation requires more.
- [x] Replace Relay's summary-based grouping and Cloudflare's completion inference
      with that view. Keep collapse controls, a direct single reply, human prompts,
      and final-answer presentation in the UI. Invalidate rendering on metadata
      changes as well as messages. Closure does not certify quality.

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

Relay correctly owns discovery and desired running/stopped state. Its `started`
flag competes with journal initialization. An isolated SQLite reproduction failed
the catalog save after composition succeeded. Creation rejected, but the room
remained usable. After unseating `builder`, restarting restored its initial seat
because the catalog selected `startRoom`. No model calls occurred.

The recorded goal belongs to the journal after initialization. Relay still needs
provisional creation parameters before that commit.

- [x] Use the recorded metadata/existence result to recover partially completed
      creation and choose start versus resume. Delete duplicate catalog facts
      where possible; retain provisional creation intent if needed to recover a
      catalog insertion that preceded the journal. Do not pretend both writes
      are one transaction or erase the initialization gap by renaming it.
- [x] Keep hosting intent, credentials, identity selection, HTTP authorization,
      file previews, and shutdown resource ownership in the application.

**Verification:** fail before composition and after composition but before the
catalog save. Restart and verify initialization recovery, the recorded goal,
and retained membership changes. Recovery reads must not execute agents.
Resuming must not apply initial seats over recorded membership.

No kernel catalog, room supervisor, HTTP framework, or browser SDK is needed.
Outbox persistence, stale HTTP-response suppression, and navigation intent are
real client concerns and remain in Relay. Shared files do not imply shared
conversation context or cross-room atomicity.

## 3. Complete control and contribution contracts

- [x] Make `abort()` awaitable. One `cancel` entry ends prior work and closes
      the current discussion without assigning a summary. Previously pending
      summaries become failed; terminal outcomes remain unchanged. Later
      messages can start fresh work. Same-handle retries retain the command key
      until confirmation, so uncertain commits cannot cancel later work twice.
      Merged in PR #143 with all seven CI checks passing.
- [x] Define completion as confirmation of durable authority changes.
      External cuts remain best effort. Provider termination and reversal of
      file or remote effects stay outside the journal transaction. See the
      [cancellation contract](../docs/durability.md#cancellation).
- [x] Settle all recorded execution obligations before stop acknowledges.
      Revoke running leases regardless of expiry, then remaining pending work,
      including unread steering. Decide each revocation after journal recovery;
      confirm completion through a fresh queued decision. Preserve the open
      exchange and existing departure/fencing contracts. This fix is prepared
      for review; it has not merged.
- [ ] Reject blank human and agent contributions inside collaboration decisions.
      Relay and `say` already reject them, but direct API/protocol calls can
      bypass that rule. Keep HTTP shape/size limits in the application.

**Verification:** concurrent sends, newly owed summary work, failed and uncertain
cancellation appends, retry, newer-run fencing, and uncooperative tools.
Exercise semantic validation through direct, protocol, and tool paths. Preserve the lifecycle and
submission regression suites from PRs #137–#139.

## 4. Finish ownership boundaries and names

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

## 5. Remove repeated work without adding a second state model

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

## 6. Release gates still required

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

Keep one explanation for each contract. Documentation should preserve purpose,
product requirements, invariants, tradeoffs, operational duties, and a map to
code/tests. Link implementation details instead of copying interfaces or
narrating algorithms. Examples should teach usage; historical implementation
status belongs in version control rather than permanent design guides.

The concise documentation pass landed in PR #138, including corrected scope
status. The final API audit and release sign-off remain.

- [ ] Audit root/package READMEs, generated examples, and design contracts against
      final APIs; they already use the collaboration-kernel narrative. Typecheck
      actual snippets. Extend existing migration notes with the new read/control
      contracts and participant names; state any real storage/protocol break.
- [ ] Explain accepted versus completed operations,
      silent/failed summaries, shared identity presence, room-wide cancellation,
      local diagnostics, deployment ownership, and effect idempotency consistently.
- [ ] Sign off F1–F9: definitions/tools (F1/F6), presence and concurrent delivery
      (F2/F3), exchanges (F4), persistence (F5), observation/control (F7), supported
      deployment models (F8), and packed distribution (F9). Every gate needs
      landed implementation and reproducible evidence before publishing 0.1.0.

## Already delivered: preserve, do not schedule again

- PRs [#137](https://github.com/ambionframework/ambion/pull/137),
  [#138](https://github.com/ambionframework/ambion/pull/138), and
  [#139](https://github.com/ambionframework/ambion/pull/139) landed durable
  presence/stop acknowledgement, typed submission with ordered publication,
  and journal-validated idempotent visits. Each passed all seven CI checks.
  Preserve storage recovery, concurrent operation, sender-presence, reentrant
  listener, connector failure, and run-fencing coverage.
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
  PR #142 adds missing-room reads and partial-creation recovery.
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
