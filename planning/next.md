# Next: a simpler collaboration kernel for 0.1.0

Reviewed against main `31f2621`, after
[PR #147](https://github.com/ambionframework/ambion/pull/147) merged.
This review traces Relay, public declarations, package entries, and internal
ownership. Parallel reviewers examined application APIs, packages, and navigation.
[release-0.1.0.md](release-0.1.0.md) remains the scope definition.
The implementation slices below distinguish current work from later proposals.

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

| Order | Work                                                                 | Benefit                                                                     | Scope                     |
| ----- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------- |
| 1     | Complete conversation reads and recoverable summary context          | Clients and agents can inspect source without reconstructing exchange rules | Two medium slices         |
| 2     | Make presence and membership vocabulary match recorded facts         | Remove false reading claims and unnecessary command coordination            | Small slices              |
| 3     | Define one application surface and one hosting surface               | Ordinary users stop navigating executor machinery                           | Medium source migration   |
| 4     | Align files, exports, packages, and learning paths with those owners | The repository and declarations teach the same model                        | Bounded structural slices |
| 5     | Measure growing histories and close release evidence                 | Optimize demonstrated costs and prove shipped configurations                | Measurement dependent     |

**First implementation:** kernel-owned, immediate exchange reads and explicit
names for waits. This removes Relay's duplicated range selection and supplies
the foundation for agent source retrieval. The summary capability gap is the
highest product risk identified here; do not let naming work postpone it.

### Delivery slices

| Slice | Deliverable                                                                                                | Status              |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------------------- |
| 1A    | `room.read`, immediate `readExchange`, explicit close/summary waits, `ExchangeRef`, and consumer migration | Prepared for review |
| 1B    | Bounded source retrieval from captured activation context and corrected summary guidance                   | Next after 1A       |
| 2A    | Factual departure vocabulary; no implied read receipts                                                     | Planned             |
| 2B    | Effect-free current-visit access and exact-repeat membership commands                                      | Planned             |
| 3     | Application/runtime ownership and one `/hosting` entry                                                     | Planned             |
| 4     | Internal ownership modules, declaration/package checks, and learning-path cleanup                          | Planned             |
| 5     | History measurements, remaining recovery evidence, and release sign-off                                    | Planned             |

Slice 1A returns an `ExchangeSnapshot` containing the exchange view, original
discussion, and observed watermark. Missing exchanges return `undefined`.
Positive safe-integer references are required. Reads never wait for completion.
Existing wait results and errors remain unchanged under explicit names.
The Cloudflare live-wait methods use the same names; HTTP routes remain stable.
Source retrieval and summary behavior stay in 1B so each contract is reviewable.

**1A evidence:** `pnpm format` and `pnpm check` passed. The gate included
793 core tests, 36 Relay tests, 23 Cloudflare tests, 39 workspace tests, and
6 CLI tests. The core total includes 22 new exchange-read cases across memory
and SQLite storage. Packed consumer type checks and the generated Worker dry
run passed. Adversarial review found no remaining blocker. CI evidence belongs
to the implementation PR.

## 1. One source discussion, available through coherent reads

### Findings at the reviewed baseline

**Relay reconstructed exchange semantics.**
[`rooms.ts`](../examples/persistent/src/rooms.ts) searched a snapshot's exchanges,
calculated the closing boundary, removed summaries, and filtered messages.
Those rules already belong to the kernel.

**Read-like method names could wait indefinitely.**
[`ExchangeHandle`](../packages/ambion/src/room-host.ts) exposed `messages()` as a
wait for close and `response()` as a wait for an optional summary. Room messages
were immediate reads. `RoomHost.snapshot()` existed but was absent from
`Room`; callers repeated the room name and runtime through `readRoom`.

**A personalized summary becomes every agent's shared memory.**
[`summary.ts`](../packages/ambion/src/execution/summary.ts) asks the writer to
omit facts unrelated to its recipient's next action.
[`render.ts`](../packages/ambion/src/execution/render.ts) then replaces covered
source messages for later agents. Its prompt suggests using tools for omitted
facts, but the built-in tools expose only speech and membership operations.
Domain tools need not contain facts spoken in the room.

A deterministic `renderRecord` reproduction used two messages containing an
export limit of **731 records**, followed by a valid short summary, “Friday is
feasible.” The source retained 731; the rendered context omitted it. This proves
source omission, not an observed model mistake. No provider calls were used.

### Changes

- [x] Expose one coherent `room.read(options)` using the existing snapshot path.
      Keep `readRoom(name, options)` for records without a running handle.
      Retain one pure read implementation and detached returned values.
      Migrate ordinary observation from `messages()` and `participants()` to
      this read, then remove redundant public convenience methods.
- [x] Add `readExchange(roomName, from, options)` for an immediate exchange view
      and its original discussion. Use the same selector for running and stopped
      records. A missing exchange must be explicit; reading never starts work.
- [x] Rename waits to `waitForClose()` and `waitForSummary()`. Preserve the
      existing returned discussion and optional summary initially. Rename the
      identity value `Exchange` to `ExchangeRef` when migrating its consumers;
      keep `ExchangeView` for recorded state and `ExchangeHandle` for live waits.
      Remove superseded aliases before 0.1.0.
- [ ] Give ordinary agents bounded, read-only access to the source of replaced
      ranges. Original messages already reach `ActivationView`; first expose
      them through an executor tool over that captured context. Share the pure
      range selector with application reads. No new transport call is needed
      while the context already contains the source. Restrict access to closed
      ranges available to that activation, with message/byte limits and explicit
      continuation. Summaries retain their recipient and source provenance.
      Retrieval must not publish a contribution, seat an agent, or open an exchange.
      A historical read must not advance the activation's freshness cursor.
- [ ] Replace instructions that treat a summary as complete truth or assume
      domain tools can recover conversational facts. Preserve optional closing
      work through the ordinary `say` tool. No second summarizer or summary kind.

The preferred direction preserves compact context with recoverable source.
Until retrieval exists, retaining source is the conservative fallback. Disabling
replacement changes the documented compaction behavior and requires an explicit
scope update. A shorter prompt alone does not solve inaccessible evidence.

**Evidence required:** open/closed/stopped/missing exchanges; silent, failed,
and late summaries; exclusive cursors; recovery and superseded runs; invalid
ranges; detached values. A later specialist must retrieve an omitted constraint
from the exact source after restart. Keep source retrieval bounded and distinguish
journal sequences from displayed message numbers.

## 2. Presence and membership describe facts

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

`participants()` currently contains seated agents and all known humans, including
absent humans. Reserve definitions are separate. Document this precisely; do not
interpret absence from that view as an available identity. Add reserve data only
for a real selection UI, without another definition catalog or participant wrapper.

## 3. One application surface; one hosting surface

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

## 4. Files and packages teach ownership

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

## 5. Measurements and release gates

These obligations survive the review. Existing passing tests do not certify
the final 0.1.0 package set.

### Measure before optimizing

- [ ] Measure Relay-shaped histories with explicit room/message/lease counts:
      cold replay, unchanged polls, append/renewal, memory, and provider input size.
      Separate status copies, projection work, and provider latency.
- [ ] Optimize only measured repeated work. Keep one disposable projection and
      pure event application. Compare incremental results with full replay,
      retained prior values, and fault/restart histories.
- [ ] Publish supported limits. Full history and unbounded exchange duration
      remain explicit limits; checkpoints and retention systems are outside scope.

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
      multiple humans, late summaries, source retrieval, and message numbering.
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
The bounded source-read tool above addresses a demonstrated capability gap;
it does not introduce a general retrieval or retention system.
