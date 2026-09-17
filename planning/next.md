# Next: a simpler collaboration kernel for 0.1.0

Reviewed on 2026-09-17 against main `b310ff6` and the accepted summary policy
in `9eaaf73`. Three reviewers and the primary agent examined collaboration,
execution, persistence, tools, and package ownership. Deterministic probes found
release work beyond naming and API cleanup. No provider calls were used.
[release-0.1.0.md](release-0.1.0.md) remains the scope definition.

## The model to preserve

**Developers define participants, open rooms, send messages, and read exchanges.**
A definition supplies behavior. A room owns one collaboration journal. A visit
binds a human identity to shared presence. An exchange bounds a discussion.
Tools reach application-owned resources, which can be shared across rooms.

An activation is one agent's authority to work. A lease bounds that authority.
These are hosting concerns. The journal determines active collaboration and
history; no scheduler, task database, or second persistent status model is needed.

| Concern                                                               | Owner                 | Rule                                                              |
| --------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------- |
| Definitions and tools                                                 | Application code      | Fixed definitions per room run; no executable code in the journal |
| Membership, presence, messages, exchanges, claims                     | Room journal          | Pure interpretation of confirmed entries                          |
| Timers, runners, subscriptions, live handles                          | Host                  | Recreate after restart; retain failed cleanup ownership           |
| Model audit                                                           | Pi transcript storage | Audit failure does not change accepted collaboration              |
| Domain files and external effects                                     | Application resources | Independent of journal transactions                               |
| Identity selection, discovery, desired hosting state, delivery outbox | Application           | Explicit entry and stable retry keys; polling observes            |

**Judge a change by the obligation it removes.** Fewer exports are useful when
callers need fewer rules. Renaming a stable concept without removing ambiguity
is lower priority. Preserve the distinction between source discussion and summary,
agent definition and membership, presence and connection, and acceptance and completion.

## Prioritized work

| Order | Work                                                    | Why it comes first                                                       | Status          |
| ----- | ------------------------------------------------------- | ------------------------------------------------------------------------ | --------------- |
| 1     | Execution progress under transport failure              | A lost claim, release, or dispatch can strand accepted work              | In progress     |
| 2     | Delivery integrity and authoritative value ownership    | Acknowledgements and live state must agree with durable facts            | Planned         |
| 3     | Durable exchange execution outcomes                     | Reconnected applications must distinguish silence from exhausted work    | Planned         |
| 4     | Incremental projections and a tested operating envelope | Completed history must not dominate every current operation              | Planned         |
| 5     | Tool execution provenance                               | Reused definitions need a reliable context for application-owned effects | Design decision |
| 6     | Presence and membership semantics                       | Simplify entry, recovery, and repeated membership commands               | Planned         |
| 7     | Application and hosting surfaces                        | Keep ordinary applications independent of execution machinery            | Planned         |
| 8     | Internal modules, exports, and packages                 | Make code ownership and public declarations consistent                   | Planned         |
| 9     | Remaining release evidence                              | Verify the supported deployments and packed consumers                    | Planned         |

**First implementation:** execution progress under transport failure. Deliver
bounded, cancellation-aware host calls and a defined policy for work that never
acquires an executor. Preserve authority checks on late responses.

**Accepted summary policy:** humans and agents continue from the same recorded
summary. It replaces covered discussion in later agent prompts as inexpensive
context compaction. Detail loss is accepted; the journal retains the source.
Source retrieval, pagination, and changes to summary prompts or replacement
remain deferred. See the [summary contract](../docs/summary.md#shared-context-and-compaction).

## 1. Execution must progress or expose why it cannot

**Confirmed: an unresolved claim or release strands the runner.**
[`runner.ts`](../packages/ambion/src/execution/runner.ts) awaits both calls outside
the cancellation race. Its retry count bounds rejected calls but places no
elapsed bound on an unresolved call. A deterministic probe cut the activation
and queued another wake; the second claim never started in either case.

**Confirmed: work that never claims a lease escapes execution limits.**
[`dispatch`](../packages/ambion/src/room-host.ts) swallows connector faults and
transport rejection. A throwing connector produced eleven attempts in ten fake
seconds, with no error notification and an open exchange. The configured
activation deadline was two seconds and the retry cap was one. Neither policy
covers work before a lease exists.

- [ ] Bound host calls and make claim and release waits cancellation-aware.
      Use host clocks for deterministic deadlines. Capture each call's outcome;
      late replies must not start cancelled work or release another activation.
- [ ] Preserve existing authority when a call's result is unknown. A timeout
      does not establish that the remote operation failed or undo its effects.
      Retries retain the same activation identity and journal fencing.
- [ ] Report dispatch failures through host diagnostics without undoing accepted
      messages. Avoid unhandled promise rejections and unbounded diagnostic noise.
- [ ] Define the policy for work that cannot acquire an executor. Separate
      delivery failure from a failed model attempt. Make any terminal decision
      recoverable from the journal and compatible with delayed claims.
- [ ] Keep timers and local wait ownership in the host/executor. Keep durable
      eligibility and terminal decisions in room rules. Add no task database,
      scheduler hierarchy, or total exchange budget.

**Evidence required:** hung claim and release; cut followed by a new wake;
late successful and stale replies; hung or rejected renewals; synchronous
connector failure; rejected wake delivery; delayed claims; recovery after lost
acknowledgements and restart. Use deterministic clocks and both supported host
models. Verify that stale contributions remain fenced and cleanup owns its work.

## 2. Delivery integrity and one owner for each value

### Delivery keys identify a logical request

**Confirmed: conflicting keys silently acknowledge another request.** Alice
sends `request-1`; Bob sends different text with the same key. Bob receives
Alice's exchange and his message does not land. The same issue affects one
sender reusing a key with different content.

[`Journal`](../packages/journal/src/journal.ts) intentionally deduplicates by
key and entry kind. The [room delivery boundary](../packages/ambion/src/room-host.ts)
must apply the stronger message contract.

- [ ] Bind delivery receipts to operation, author, recipient, and content.
      Return the original receipt for an exact retry. Reject conflicting reuse.
      Document this tightening of the existing first-write-wins behavior.
- [ ] Preserve retry identity across lost acknowledgements, restart, and human
      reentry. Decide key scoping without weakening payload conflict checks.
- [ ] Align adapter key handling. Cloudflare currently drops an explicitly
      supplied empty key through a truthiness check. Preserve it or reject empty
      keys consistently across adapters and the core.

**Evidence required:** exact and conflicting retries; two humans; changed
recipient; concurrent sends; memory and SQLite; restart and Cloudflare RPC.

### The generic journal owns its cache

**Confirmed: returned entries can alter live interpretation without a write.**
Mutating `append()`'s returned body changes a repeated-key result. Reopening the
same storage returns the original body. Public `entries` also exposes a mutable
array. Storage snapshots alone do not protect the journal's cache.

- [ ] Keep the cache private. Make public entries and append results detached
      or deeply immutable, with matching TypeScript contracts.
- [ ] Apply the same ownership rule to callbacks and deduplication results.
      Avoid copying complete history on every append or observation.

**Evidence required:** nested mutations through each public path cannot change
later reads, retry results, sequence allocation, or replay.

### Cloudflare must use admitted identity

**Source-traced: adapter metadata can disagree with the room journal.**
[`visit()`](../packages/cloudflare/src/room-object.ts) writes `metadata.people`
before admission. A cached visit bypasses validation of replacement identity.
After restart, the cache is empty and the replacement conflicts with recorded
identity. Invalid names can also persist before validation. This trace needs a
workerd reproduction before implementation.

- [ ] Reproduce conflicting identity, malformed input, and interrupted admission.
- [ ] Make the journal authoritative for admitted identity and presence.
      Retain only necessary hosting configuration in adapter metadata. Reuse
      the current-visit access work in section 6 where it removes duplicate state.
- [ ] Ensure rejected operations cannot corrupt subsequent send, leave, or
      restart behavior. Handle partial failure without another identity registry.

## 3. Exchanges expose durable execution outcomes

**Confirmed: exhausted work and deliberate silence have equivalent public reads.**
A silent worker and a provider-failed worker with exhausted retries both produce
`closed` with a `silent` summary outcome and only the human question as source.
Independent reads after stop preserve that equivalence. Failure is visible in
live `error` and `abandoned` notifications, while lease facts remain internal.

Closure correctly fixes a discussion boundary. The missing capability concerns
execution health, which the kernel knows. It does not concern answer correctness.

- [ ] Derive operational completion facts in the existing exchange read:
      normal quiescence, cancellation, and exhausted or interrupted work.
- [ ] Preserve relevant per-agent terminal facts for partial failures. Define
      how later successful attempts affect the outcome. Avoid a Boolean success
      field that could imply semantic correctness.
- [ ] Keep durable outcomes separate from transient error objects and provider
      diagnostics. Reconnect must not require an application-maintained event log.

**Evidence required:** silence, no eligible workers, exhausted failures, recovery,
partial failure, cancellation, summaries after failure, and reads after restart.

## 4. Current operations must not repeatedly rebuild settled history

**Measured: completed history remains on the execution and read paths.**
[`evolve`](../packages/ambion/src/room/transition.ts) copies base facts and calls
[`project`](../packages/ambion/src/room/fold.ts), which reconstructs membership,
pending work, and summary obligations. A status read builds all exchange views,
including searches through historical messages and leases.

The probe used actual source functions on Node 26.8.2. Each exchange had one
short question, response, and summary, with two completed leases. Pending and
owed work were zero. These are single-run synthetic measurements without
storage/provider I/O or isolated warmup; they do not establish production capacity.

| Closed exchanges | Journal entries | Initial fold | Status read without messages | Apply a new question |
| ---------------- | --------------- | ------------ | ---------------------------- | -------------------- |
| 100              | 802             | 9 ms         | 1 ms                         | 1 ms                 |
| 1,000            | 8,002           | 590 ms       | 26 ms                        | 48 ms                |
| 4,000            | 32,002          | 10.3 s       | 388 ms                       | 412 ms               |

- [ ] Maintain incremental, journal-derived projections for membership, active
      leases, pending deliveries, and completed exchange outcomes.
- [ ] Avoid rescanning settled work for unrelated entries. Let reads select the
      exchange history they need without reconstructing all historical outcomes.
- [ ] Keep full replay as the reference. Compare incremental results against it
      under cancellation, reseating, late summaries, takeover, and restart.
- [ ] Add reproducible performance evidence and publish a finite supported
      operating envelope. Measure multiple rooms sharing one Node event loop.

This preserves full-history storage and shared summary compaction. Checkpoints,
retention, deletion, and an additional authoritative scheduler are not prerequisites.

## 5. Tools need immutable execution provenance

**Confirmed omission; capability design remains open.**
[`ToolContext`](../packages/ambion/src/types.ts) exposes agent identity, provider
call id, and cancellation. It carries no room, activation, or durable cause.
A shared definition therefore needs per-room closures or separate application
plumbing to associate effects with the collaboration that caused them.

- [ ] Define the minimum immutable execution scope for ordinary tools. Consider
      room, activation, and purpose without exposing mutable room internals.
- [ ] Demonstrate one retry-safe domain operation with a definition reused across
      rooms. Distinguish a provider call id from an application operation key.
- [ ] Keep domain authorization, transactions, and effect idempotency owned by
      the application. Provenance does not make arbitrary effects exactly once.

Validate the need and shape before stabilizing the tool API. Do not add a new
tool framework or require per-room copies of every agent definition by default.

## 6. Presence and membership describe facts

### Presence does not prove reading

[`presence.ts`](../packages/ambion/src/room/presence.ts) advances `since` only
when a human leaves. [`view.ts`](../packages/ambion/src/room/view.ts) calls it
reading progress, and the executor tells agents what the person “has not seen.”
Reading or speaking after return does not advance this cursor. These are
unsupported consumption claims.

- [ ] Name the cursor `lastDeparture` and the derived count
      `messagesSinceDeparture`; render those facts literally. Preserve exclusive
      catch-up behavior. Do not add read receipts to repair a naming error.
- [ ] Update the public visit, protocol, prompts, tests, and presence contract
      together. The stored departure event needs no migration. Protocol field
      renames require coordinated host/executor updates.

### Reacquiring access must not enter the room

Relay's [`mutateHuman`](../examples/persistent/src/server.ts) reads participants,
then calls idempotent `visit()` before sending or leaving. Its queue currently
makes this safe. This is a caller coordination obligation, not a reproduced
Relay race. The library should make the intended operation direct.

- [ ] Preserve `room.visit(human)` as idempotent explicit entry.
- [ ] Provide effect-free access to the current visit by name, returning absent
      when the person is absent. Reconstruct access after recovery without an
      arrival. Use it for stateless send/departure requests and delete the
      participant-check/ensure-entry sequence from Relay and Cloudflare.
- [ ] Keep authoritative send checks inside the journal queue. A stale handle
      cannot restore presence or send after its visit ends. A delayed HTTP
      request that acquires access after deliberate reentry has current authority;
      rejecting stale navigation intent remains application policy. Keep shared identity
      semantics; do not introduce per-tab visits or connection tokens.

### Membership commands should be safe to repeat

[`seat`/`unseat`](../packages/ambion/src/room-host.ts) reject already-satisfied
host requests. Agent membership commits already return `unchanged`.

- [ ] Make exact duplicate host membership commands succeed without another
      entry, wake, or lease change. Keep unknown-name errors.
- [ ] Define different-attention requests explicitly. Do not silently discard
      them or revoke work through an implicit unseat/reseat cycle. Preserve
      current conflict behavior until a dedicated attention change is justified.

**Evidence required:** reading never implies departure or vice versa; crashes
preserve recorded presence; absent access writes nothing; stale handles fail;
retry after deliberate reentry retains the original delivery key and exchange.
Concurrent duplicate membership commands must produce one change.

`RoomSnapshot.participants` contains seated agents and all known humans, including
absent humans. Reserve definitions are separate. Document this precisely; do not
interpret absence from that view as an available identity. Add reserve data only
for a real selection UI, without another definition catalog or participant wrapper.

## 7. One application surface; one hosting surface

**The runtime is an owner, not a freely copyable dependency record.**
[`Runtime`](../packages/ambion/src/host/runtime.ts) exposes storage, model calls,
transcripts, protocol transport, retries, and eviction. A private WeakMap binds
its identity: a spread copy satisfies the interface but cannot host rooms.
PR #146 narrowed the internal room dependency; the public surface remains broad.

**`/transport` now means more than transport.** It exports the runner, executor
construction, audit identity, live-room lookup, wire contracts, and wire helpers.
A developer seeking audit access should not need to infer this history.

- [ ] Use `/hosting` as the single advanced entry, replacing `/transport` in one
      coordinated pre-release migration. Keep the protocol as a clearly named
      section inside that entry. Do not add `/kernel`, `/protocol`, `/executor`,
      and `/audit` public entries without independent consumer needs.
- [ ] Keep `createRuntime` and explicit runtime selection on the application
      path. Encode its factory-owned identity and expose only deliberate public
      operations. Move execution service inspection, audit access, and destructive
      eviction to hosting. Default applications still need no executor setup.
- [ ] Move host-only `reconcile` access off ordinary `Room` when migrating
      Cloudflare alarms. Keep the actual host capability directly accessible
      through `/hosting`; do not introduce a parallel room facade.
- [ ] Use one stream option name (`stream`) at runtime and room scope. Move
      `ModelResolver` to hosting. Preserve supported Pi tool types in tool
      authoring; a new provider-neutral tool SDK would add conversion work.
- [ ] Rename executor-facing seat types by responsibility: `SeatContext` to
      `AgentExecutionContext`, `SeatPort` to `AgentPort`, and `SeatRoom` to
      `RoomProtocol`. Keep `seat`/`unseat` for membership. Rename local variables
      only when they currently call a runner or protocol endpoint a membership.

**Evidence required:** a normal room and persistent multi-room host remain easy
examples; generated declarations expose the intended entries; structural runtime
copies fail at compile time; scripted streams and lazy providers still work.
Preserve Node and Cloudflare composition, independent same-name rooms, audit
identity, inherited leases, and failure cleanup. Public renames must not rename
stored journal fields, transcript IDs, or Durable Object bindings incidentally.

## 8. Files and packages teach ownership

**Move responsibilities before moving paths.**
[`types.ts`](../packages/ambion/src/types.ts) mixes conversation values, definitions,
Pi tool types, clocks, model resolution, lease reasons, and local notifications.
[`host/runtime.ts`](../packages/ambion/src/host/runtime.ts) mixes dependency
contracts, registry state, transport, and default executor construction.
`room-host.ts` imports that concrete composition module for narrow contracts.

Proposed internal organization, retaining private modules:

| Area                | Responsibility and change                                                      |
| ------------------- | ------------------------------------------------------------------------------ |
| `room.ts`           | Application composition and start/resume/read operations                       |
| `conversation.ts`   | Detached message, participant, and exchange values and their guards            |
| `define.ts`         | Agent/human definitions and capture; move tool authoring to `tools.ts`         |
| `tools.ts`          | Typed authoring, bundles, normalization, and Pi adaptation                     |
| `host/contracts.ts` | Narrow clock, room, connector, and lifecycle dependency contracts              |
| `host/runtime.ts`   | Runtime ownership and room registry                                            |
| `host/room.ts`      | Current `room-host.ts`: journal effects, admission, cleanup, notifications     |
| `host/protocol.ts`  | Current `answers.ts`: implement room protocol calls; replace vague `Answering` |
| `room/`             | Pure projection, decisions, queries, and reconciliation policy                 |
| `execution/`        | Pi services, runner, tool binding, rendering, and audit                        |
| `protocol.ts`       | Serialized calls and responses; no journal schema or executable definitions    |
| `journal/`          | Room event vocabulary and its storage adapter                                  |

- [ ] Split `types.ts` by these owners. Keep collaboration values free of model
      and transcript types. Separate local execution diagnostics from durable
      messages in type ownership, while preserving one useful subscription API.
- [ ] Replace ambiguous internal `room/view.ts` with `room/context.ts`,
      `room/read.ts` with `room/snapshot.ts`, and `answers.ts` as above. Retain
      distinct room/executor activation files: authorization and running work
      are different responsibilities. Do not flatten them to save a filename.
- [ ] Make import rules enforce these boundaries against implementation modules,
      including type-only imports. Check emitted declarations as well as source.
- [ ] Tighten `PresenceMessage` as a discriminated union when migrating its
      consumers. Four event kinds currently share optional preferences, identity,
      attention, and author fields. Account explicitly for accepted historical
      shapes before promising stronger fields; types alone cannot repair data.

### Package decisions

Keep the six current packages for 0.1.0. Journal and Pi transcript persistence
already have independent ownership and consumers. Keep workspace resource and
its bound tools in one package. Keep Cloudflare and CLI as deployment choices.

`workspace/resource` avoids an Ambion runtime import, but installing workspace
still installs its declared Ambion dependency. **Import independence is not
installation independence.** Verify minimal packed consumers before claiming it.
Extract a resource-only package only when an independent consumer needs that
installation benefit. Likewise, a standalone executor needs a real installation
or deployment requirement; file separation alone is insufficient.

- [ ] Make `pi-journal/src/index.ts` a small export entry. Move its session
      implementation behind it; keep the existing Pi terminology and package name.
- [ ] Align package descriptions and keywords with the collaboration kernel.
      The main manifest still describes “ambient-aware, always-on agents.”
      Do not imply a scheduler, managed hosting, or filesystem security boundary.
- [ ] Keep storage IDs, binding names, and published package names stable during
      source cleanup. A `SeatObject` class rename needs explicit Cloudflare
      migration evidence; it is not part of routine terminology replacement.

### Learning path

- [ ] Lead with four application concepts: definitions, room, visit, exchange.
      Introduce attention with membership, resources with tools, and activations
      and leases only in hosting. `Agent catalog` is an ordinary definitions list,
      not another object developers must construct.
- [ ] Make `docs/room.md` the kernel overview, replacing the misleading
      `docs/agent.md` entry point. Keep focused presence, exchange, summary,
      durability, and deployment contracts; link shared explanations once.
- [ ] Present Relay as the representative persistent Node application. Label
      `ambion new` accurately as a local Cloudflare project, not the universal
      path for every application. Do not build another CLI host in this pass.
- [ ] Typecheck the short application and hosting examples against packed exports.
      Remove stale completion claims and obsolete source paths as each slice lands.

Planning stays in two files. The completed CLI plan is retired; current usage
belongs in its package README and outstanding work remains below.

## 9. Remaining release evidence

These obligations survive the review. Existing passing tests do not certify
the final 0.1.0 package set.

### Extend the history measurements

Section 4 owns the projection changes and their equivalence tests. Extend its
measurements to Relay polling, memory, provider input size, and multiple rooms.
Publish supported limits before release. Full-history retention and unbounded
exchange duration remain explicit limits.

### Prove shipped configurations

- [ ] Install minimal packed consumers outside the monorepo: journal alone;
      Pi sessions plus journal; embedded Ambion; persistent Node plus workspace;
      resource-only imports; generated CLI/Cloudflare project. A fixture declaring
      all six packages does not prove each consumer's dependency closure.
- [ ] Resolve or justify both TypeBox versions through authored-tool declaration
      and runtime tests. Replace the cast-based scripted `stubModel` with a valid
      execution-owned model. Document any necessary `skipLibCheck` boundary.
- [ ] Verify ESM exports, declarations, package contents, versioning, registry
      read-token instructions, and lockstep CLI/Cloudflare publication.
- [ ] Verify core Node 22.19+, Relay/tooling Node 26.4+, and actual workerd settings
      separately. Check other examples in Knip and remove unused task contracts
      only after inspecting their consumers.

### Recovery and resource evidence

- [ ] Cover missing duplicate-wake, takeover, delayed-cut, audit-retry, clock-skew,
      process-pause, and uncooperative-tool combinations. Preserve surviving
      remote leases and distinguish authority safety from recovery latency.
- [ ] Reproduce historical Cloudflare wake/cut races and duplicate activation-end
      reports on current code. Retain ordering traces. Remove test controls from
      production adapter state where feasible; do not fix races with timeouts.
- [ ] Verify `/dev/null` on both workspace backends. Preserve whole-operation
      serialization, shared ownership, and dispose-versus-destroy behavior.
- [ ] Extend summary evidence for silence, corrections, conflicting constraints,
      multiple humans, late summaries, and message numbering.
- [ ] Run `pnpm check`, targeted chaos, and proofs for changed rules. Retain
      real-provider restart validation and exercise Relay after API migrations.
      Record commit, commands, environment, results, and unresolved limits.

### Release sign-off

- [ ] Audit README, package docs, templates, and design contracts against final
      APIs. State real source/protocol/storage breaks and exact migration steps.
- [ ] Sign off scope F1–F9 with landed implementation and reproducible evidence:
      definitions/tools, participation/delivery, exchanges, persistence,
      observation/control, deployment, and packed distribution.

## Delivered foundations and deliberate limits

PRs #137–#147 delivered durable presence/control, idempotent visits, coherent
room views, partial-creation recovery, contribution validation, executor
composition, and participant vocabulary. Preserve those regressions. Earlier
work established fixed definitions, typed tools, structured activations,
conditional journal commits, workspace ownership, and restart/reconnect evidence.

[PR #148](https://github.com/ambionframework/ambion/pull/148) delivered coherent
`room.read()`, immediate `readExchange()`, explicit close/summary waits, and
`ExchangeRef`. All seven CI checks passed, including real-model tests. Local
validation covered 793 core tests, 36 Relay tests, 23 Cloudflare tests,
39 workspace tests, 6 CLI tests, and packed consumer/generated Worker checks.

The CLI `new`/`dev` workflow and packed/generated-project smoke are implemented.
Its published-prerelease validation is recorded in
[the release run](https://github.com/ambionframework/ambion/actions/runs/35059680708).
PR #147 passed all seven checks, including proofs, Node 22/24, CLI smoke, and
real-provider tests. Historical evidence remains in version control.

Deferred: scheduler ingress, native timers/subscriptions, a task database,
mandatory summaries, automatic exactly-once external effects, another generic
tool SDK, browser-only execution, hosted service, turnkey deployment commands,
and new packages without independent consumers. CLI remote authentication,
automated evaluations, multiple terminal clients, and live activity transport
also remain outside its current two-command scope.

Preserve earlier exclusions: hot-loaded definitions, multiple simultaneous
discussions within one room, per-tab presence tokens, automatic departures,
distributed workspace ownership, automatic summary skipping by message count,
manual summary retry, exchange budgets, and mandatory new storage formats.
Agent source retrieval, pagination, and changes to summary compaction are also
deferred under the accepted shared-summary policy.
