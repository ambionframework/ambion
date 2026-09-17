# Next: the work to a solid 0.1.0

Rewritten on 2026-09-17 against main `deaaf94`. [release-0.1.0.md](release-0.1.0.md)
owns the scope. [review-0.1.0.md](review-0.1.0.md) owns the analysis: the
confirmed defects, the design and experience items, the scope the release
did not name, the kernel positioning, the harness adapters, and the open
pull requests. [docs/example.md](../docs/example.md) owns the one example.
This file owns the order of the work and the evidence each step needs.

**An item lands with its evidence or stays open.** Every checkbox names
the review item that explains it. A phase closes when its evidence line
holds on main.

## The model to preserve

**Developers define participants, open rooms, send messages, and read
exchanges.** A definition supplies identity and an executor. A room owns
one journal. A visit binds a person to shared presence. An exchange bounds
a discussion. Tools reach application-owned resources. Everything else is a
fold over the journal or a hosting concern.

| Concern                                                       | Owner                 | Rule                                                               |
| ------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------ |
| Definitions, executors, tools                                 | Application code      | Fixed per room run; no executable code in the journal              |
| Membership, presence, messages, exchanges, claims, references | Room journal          | Pure interpretation of confirmed entries                           |
| Model loops, harness sessions, activation steps               | Executor              | One session per activation; steps go to the trace, speech to `say` |
| Files, tables, instruments, and their change logs             | Application resources | Independent of journal transactions; stamped with provenance       |
| Timers, runners, subscriptions, live handles                  | Host                  | Recreated after restart                                            |
| Identity selection, discovery, hosting state, delivery outbox | Application           | Explicit entry and stable retry keys                               |

**Judge a change by the obligation it removes.** Fewer exports are useful
when callers need fewer rules. A rename earns its place only when one name
means two things or two names mean one.

## Decisions taken

- **One example.** The site example and Relay are replaced by the agentic
  lab workspace in [docs/example.md](../docs/example.md).
- **Two entries.** `@ambionframework/ambion` for applications and
  `@ambionframework/ambion/hosting` for hosts and adapters. `/transport`
  goes away before the tag (review B5).
- **The kernel imports no model library.** Pi becomes an executor package,
  and the Claude Agent SDK becomes a second one (review E1, F10).
- **Speech enters the record through `say` only**, on every executor
  (review F4).
- **The freeze.** After phase 2, every change to the main entry and to the
  journal bodies is additive until the tag.
- **Shared summaries.** Humans and agents continue from the same recorded
  summary; the source stays in the journal for review
  ([summary contract](../docs/summary.md)).
- **A public registry.** The packages publish to npmjs at 0.1.0 (review D7).

## The phases

| Phase | Name                              | Starts after | Review items                                                               |
| ----- | --------------------------------- | ------------ | -------------------------------------------------------------------------- |
| 0     | Unblock the tree                  |              | A3, C1, C7, D9, G                                                          |
| 1     | Correctness                       | 0            | A1, A2, D1, the PR #153 kernel slice                                       |
| 2     | The public shape, then the freeze | 1            | B3, B4, B5, B7, B8, C5, C6, D2, D3, D4, D5, E1, E2, E5, E6, F2, F4, F7, F8 |
| 3     | Kernel internals                  | 2            | B1, B2, B9, E7, exchange outcomes                                          |
| 4     | Executors and adapters            | 2            | B6, C2, D6, F3, F5, F6, F9, F10                                            |
| 5     | Resources and artifacts           | 2            | E4, E5, E6                                                                 |
| 6     | The workbench example and the UI  | 3, 4, 5      | C3, docs/example.md                                                        |
| 7     | Documentation                     | 2            | C4, D8, D10, and the pages below                                           |
| 8     | Release evidence and sign-off     | 6, 7         | D7, the scope's F1 to F9                                                   |

Phases 3, 4, and 5 run in parallel after the freeze. Phase 7 starts after
the freeze and finishes with phase 6.

## Phase 0. Unblock the tree

**Goal:** main installs on every supported Node, the open pull requests
are decided, and the live tier can run.

- [ ] Merge PR #152. Note in `durability.md` that a same-key retry is bound
      to its activation (review G).
- [ ] Close PR #73, #67, #63, #60, #58, #48, #44, #40, and #28. Take the
      export-list assertion into phase 2 and the changelog into this phase
      (review G).
- [ ] Hold PR #151; delegation returns by reference in 0.2 (review E8).
      Land the closing-context slice of PR #153 alone in phase 1; keep the
      evals package private (review G).
- [ ] Bump `pi-agent-core` and `pi-ai` to 0.85.1 together in `ambion`,
      `cloudflare`, `pi-journal`, and `workspace`; run the live tier once.
      Merge PR #111, #112, #5, #6, and #7; rebase PR #4 (review G).
- [ ] Restore the provider account. Add a second provider job to the live
      workflow, and fail a job on a credit or authentication error with the
      account's name (review D9).
- [ ] Install on Node 22: load OpenTUI lazily as an optional dependency, or
      move the terminal client to its own package; make the root `engines`
      field true; add a CI step that installs on Node 22 (review C1).
- [ ] Add `CHANGELOG.md` with an `Unreleased` section; every pull request
      that changes a public entry adds a line (review C7).

**Evidence:** CI green on main; `pnpm install` and `pnpm check` on Node 22;
two live jobs green; Dependabot rebases an npm bump.

## Phase 1. Correctness

**Goal:** the two confirmed defects and the retry of permanent failures are
fixed with regressions.

- [ ] Send a commit through the retrying call path under its key; when
      every attempt is lost, end the tool call with an unknown outcome
      (review A1).
- [ ] Let `stop()` end running leases only; an activation that never
      claimed stays pending across the stop; `durability.md` and
      `deployment.md` say one thing (review A2).
- [ ] Classify a provider failure at the executor boundary; carry
      `cause: 'permanent' | 'transient'` on the failed lease end and on the
      `error` and `abandoned` events; abandon a permanent failure at once
      (review D1).
- [ ] Land the closing-context change from PR #153: a closing activation
      reads every message through the close boundary with the divider at
      its exchange (review G).

**Evidence:** the two probes from the review as regressions on memory and
SQLite; a 400 reply abandons in one attempt; a resumed room answers a
question sent before a graceful stop.

## Phase 2. The public shape, then the freeze

**Goal:** every public rename, every journal field, and every read the
release needs land in one window.

### The vocabulary and the runtime

- [ ] `AgentDefinition` becomes `{ name, identity, executor }`; Pi's
      model, instructions, tools, bundles, and guidance move into `pi({})`
      (review E1).
- [ ] `Runtime` loses `stream`, `model`, and `transcripts`; the type is
      branded; `defaultRuntime` is created on first use; `evict` moves to
      hosting (review B4, E1).
- [ ] The executor contract: `open(activation)` returns a session with
      `pass(input)`, optional `steer`, and `close`; the driver stays in the
      kernel and renders a delta for later passes (review E2, F2).
- [ ] Two entries; `/transport` removed; the export list of each entry
      asserted in `package.test.ts` (review B5).
- [ ] One limits vocabulary: `delivery`, `lease`, `activation`, `call`,
      `context`, `message`, `trace` (review B3, D5, F7).
- [ ] `AmbionError` with a closed set of codes at every throw site (review
      B7).
- [ ] An activation id on every execution event; `RoomEvent` and
      `ExecutionEvent` as two families under one `subscribe` (review B8).
- [ ] The naming list: `AgentExecutionContext`, `AgentPort`,
      `RoomProtocol`, `stream`, `lastDeparture`, `messagesSinceDeparture`,
      `ExchangeRead`; the docs say "definitions" (review C5).
- [ ] Room name validation; a refused summary name that no seat holds;
      `opened` on the exchange handle; idempotent host `seat`; prefixed key
      kinds (review C6).
- [ ] A `fixed` seat attribute; the summary writer fixed by default; an
      agent's unseat of a fixed seat refused (review D4).
- [ ] `limits.context.messages` and `limits.message.bytes`, with defaults
      that keep current behavior (review D5).

### The record and the reads

- [ ] `refs` on spoken messages and summaries; `ambion://room/<name>` and
      `ambion://room/<name>/exchange/<from>` (review E5).
- [ ] `activation`, `exchange`, and `room` on `ToolContext` (review E6).
- [ ] The `Step` vocabulary; a trace journal per activation; coalesced
      deltas; `limits.trace`; a trace policy per definition; live `step`
      events (review F4, F7).
- [ ] `activations` on the exchange read; `readActivation(name, id)`
      (review F8).
- [ ] Usage on `activation_end` and on the release entry; a closed
      exchange sums the usage of its activations (review D2).
- [ ] `format: 1` on the run entry; golden journals under
      `test/fixtures/journals/` replayed in CI; the compatibility promise in
      `durability.md` (review D3).

### The freeze

- [ ] A note in `release-0.1.0.md`: the main entry and the journal bodies
      take additive changes only until the tag.

**Evidence:** generated declarations list two entries and the export
snapshot passes; a scripted executor passes the driver suite; a fixed seat
refuses an agent's unseat; `readActivation` returns steps; golden journals
replay; `activation_end` carries usage.

## Phase 3. Kernel internals

**Goal:** a current operation costs what the current work costs, and each
mechanism reads in one place.

- [ ] Evolve the projection per entry: people, roster, the open exchange,
      pending activations by seat, owed drafts by close; keep `foldRoom` as
      the reference; one property test compares both under cancellation,
      reseating, late summaries, takeover, and restart (review B1).
- [ ] Split `room-host.ts` into room, people, dispatch, waits, and control;
      add a file line budget to the lint gate (review B2).
- [ ] Exchange outcomes: complete, cancelled, exhausted, and `awaiting` a
      person; `pendingFor(person)` on the room read; a summary for each
      person who spoke in the exchange (review E7; scope F4).
- [ ] The Cloudflare room object exposes the core surface plus `start`;
      `messages`, `participants`, and `status` go away; alarms reach
      `reconcileRoom` through hosting (review B9).

**Evidence:** the equivalence property test; the envelope table remeasured
at 100, 1,000, and 4,000 closed exchanges; outcome reads after restart; the
Cloudflare template on `read()`.

## Phase 4. Executors and adapters

**Goal:** two executor families run in one room, proven on fakes in CI.

- [ ] `@ambionframework/pi`: the `Agent` kept across passes; `prompt()`
      with the delta; `readThrough` from the provider request boundary; the
      Pi journal as its private audit (review F2, F5).
- [ ] `@ambionframework/claude` on the Claude Agent SDK: `say`, `seat`,
      and `unseat` through `createSdkMcpServer` per activation; streaming
      input for steer, with the user echo advancing `readThrough`; hooks
      and tool messages mapped to steps; a permission request as an
      `approval` step; `permissionMode`, `allowedTools`, `canUseTool`, and
      `maxBudgetUsd` passed through (review F5, F6).
- [ ] `examples/codex`: a thread per activation; a stdio room tools server
      over a local socket; items mapped to steps; `file_change` paths as
      `refs` (review F6, F10).
- [ ] Three prompt parts and `renderDelta`; the default speaking policy as
      one exported constant a definition can replace; prompt snapshots for
      an ordinary and a closing activation (review B6, F3).
- [ ] `memory: 'activation' | 'seat'` on both adapters (review F9).
- [ ] `@ambionframework/ambion/testing`: `scripted`, `speak`, `quiet`,
      `callTool`, `byAgent`, `fakeClock`, `settled`; the `stubModel` cast
      removed; the repository's tests on the published entry (review C2).
- [ ] Conformance suites: storage, transport, and executor, published;
      each shipped adapter passes on a fake (review D6, F10).

**Evidence:** both adapters pass the executor suite on fakes; a room with
one Pi seat and one Claude seat in CI; prompt snapshots; the assistant
package's prompt shrinks to what the kernel does not enforce.

## Phase 5. Resources and artifacts

**Goal:** artifacts are references on the record with provenance behind
them, and the workspace is one binding of one resource contract.

- [ ] The resource contract stays neutral at `@ambionframework/workspace/resource`;
      just-bash and its Pi tools become the Pi binding (review E4).
- [ ] A SQL resource over `node:sqlite` with `query` and `record` tools, in
      the example (review E4).
- [ ] A change log in the workspace binding keyed by activation, with
      `changes({ exchange })` (review E6).
- [ ] The instrument resource for the example: readiness, run, and
      measurement tools, with approval on a limit (docs/example.md).
- [ ] Workspace `/dev/null` and the backend matrix on both backends.

**Evidence:** two resources on one contract; "what changed during this
exchange" answered from the change log; a summary that cites a ref.

## Phase 6. The workbench example and the user interface

**Goal:** one example that a new reader runs first, that the deployment
guide describes, and that the drill-down UI is built on.

- [ ] Remove `examples/site` and `examples/persistent`; move their reports
      and `docs/assistant-acceptance.md` under `planning/evidence/`
      (review C7).
- [ ] Build `examples/workbench` per [docs/example.md](../docs/example.md):
      six definitions with executors chosen by environment, the SQL
      resource, the library workspace, the instrument, one persistent host
      with a room per project, the library files, and the tests.
- [ ] The user interface: projects, room, exchange, activation, steps; live
      steps merged by activation, pass, and index; cost per exchange;
      `awaiting` and `approval` shown to the person (review F8).
- [ ] The nine scenarios in docs/example.md on the scripted executor, and
      the restart scenario in a fresh process.
- [ ] `ambion new --template node` derived from the example with one room
      and two definitions; the Cloudflare template on `read()` (review C3).

**Evidence:** the nine scenarios pass scripted on memory and SQLite; the
live tier runs them on two providers; a restart preserves the question; the
Design Agent runs on the Claude adapter while the rest run on Pi.

## Phase 7. Documentation

**Goal:** a reader meets one voice, one glossary, and one page per
mechanism, with no history of names they never used.

- [ ] `docs/room.md`: the overview and the glossary; `docs/README.md` leads
      with it; `agent.md` becomes the definitions and tools page (review
      C4, C5).
- [ ] `docs/patterns.md`: the human patterns table and the two rules that
      close it (review E7).
- [ ] `docs/executors.md`: the executor contract, the step vocabulary, the
      harness matrix, and how to write an adapter (review F).
- [ ] `docs/resources.md`: the resource contract, references, and
      provenance; `workspace.md` becomes the Pi binding page (review E4 to
      E6).
- [ ] `docs/trust.md`: guarantees and non-guarantees between owners,
      membership authority, harness memory (review D8, D4, F9).
- [ ] `docs/envelope.md`: the limits table and the measured envelope
      (review B3, B1, D5).
- [ ] `durability.md`: the format promise, stop semantics, permanent
      failure, commit retry (review A1, A2, D1, D3).
- [ ] Retire the residue: rule citations in source comments, pre-release
      migration notes, package descriptions and keywords, comment voice,
      `demos/README.md` (review C4).
- [ ] A generated API reference per entry under `docs/api/`, with a CI
      staleness check (review D10).
- [ ] `README.md` rewritten around the workbench; package READMEs; the CLI
      README; `CONTRIBUTING.md` with the Node floors.
- [ ] The 0.1.0 entry in `CHANGELOG.md`.

**Evidence:** every page in the index has one owner section; a grep for
numbered rule citations finds none; the API reference builds in CI; the
README example typechecks against the packed entry.

## Phase 8. Release evidence and sign-off

**Goal:** the packages install from a public registry, and every claim in
the scope has evidence on the tagged commit.

- [ ] Publish to npmjs under `@ambionframework`; remove the token
      instructions; the release workflow verifies a consumer from npmjs
      (review D7).
- [ ] Packed consumers outside the monorepo: journal alone; pi-journal with
      journal; kernel with pi; kernel with claude; the workbench; the
      generated Node and Cloudflare projects; the resource-only import.
- [ ] One TypeBox version; ESM exports and declarations checked; package
      contents; lockstep versions.
- [ ] Node 22 and 24 tests; Node 26 CLI; workerd tests; the historical
      Cloudflare wake and cut races reproduced on current code.
- [ ] The chaos sweep at 200 seeds; Dafny proofs for every changed rule;
      golden journals; the live tier on two providers; the commit, the
      commands, and the results recorded under `planning/evidence/`.
- [ ] Recovery evidence: duplicate wake, takeover, delayed cut, audit retry,
      clock skew, process pause, uncooperative tool.
- [ ] Summary evidence: silence, corrections, conflicting constraints,
      multiple humans, late summaries.
- [ ] Sign off the scope's F1 to F9 against landed implementation; tag
      `v0.1.0`.

**Evidence:** `npm install @ambionframework/ambion` works without a token;
every consumer above installs and typechecks; the sign-off table in
`planning/evidence/0.1.0.md` names a commit and a run for each claim.

## Package decisions

**Nine published packages, one private, two examples.** Each package has
one owner concern and one independent consumer.

| Package                       | Concern                                                       | Depends on          |
| ----------------------------- | ------------------------------------------------------------- | ------------------- |
| `@ambionframework/journal`    | The append-only journal and its storage contract              |                     |
| `@ambionframework/pi-journal` | Pi transcript sessions over journal storage                   | journal             |
| `@ambionframework/ambion`     | The kernel: protocol, journal vocabulary, rules, room, driver | journal             |
| `@ambionframework/pi`         | The Pi executor                                               | ambion, pi-journal  |
| `@ambionframework/claude`     | The Claude Agent SDK executor                                 | ambion              |
| `@ambionframework/workspace`  | The resource contract and the just-bash Pi binding            | ambion, pi          |
| `@ambionframework/assistant`  | The assistant definition                                      | ambion, pi          |
| `@ambionframework/cloudflare` | Rooms and seats as Durable Objects                            | ambion, journal, pi |
| `@ambionframework/cli`        | `ambion new` and `ambion dev`                                 | ambion              |
| `@ambionframework/evals`      | Private until its own work-left list closes                   | ambion              |
| `examples/workbench`          | The one example                                               | all of the above    |
| `examples/codex`              | The Codex adapter over the stdio room tools server            | ambion              |

Storage ids, binding names, and published names stay stable through the
source moves. A `SeatObject` class rename needs Cloudflare migration
evidence and is not part of this plan.

## Deferred past 0.1.0

- Delegation to a working room, rebuilt by reference (review E8).
- A published Codex adapter package; the example covers the surface.
- Publishing `@ambionframework/evals`.
- A bounded projection with checkpoints; the incremental fold keeps full
  replay.
- Automatic admission expiry for unclaimed work.
- A durable subscription service across processes.
- Native timers, external event subscriptions, and scheduler ingress. The
  first ingress is a notice from a resource, routed by attention like a
  message, with a ref and no author.
- Per-tab presence, automatic departures, hot-loaded definitions, multiple
  simultaneous discussions in one room, exchange budgets, distributed
  workspace ownership, manual summary retry.

## History

PRs #137 to #150 delivered durable presence and control, idempotent visits,
coherent room views, partial-creation recovery, contribution validation,
executor composition, participant vocabulary, coherent reads, the assistant
package, and bounded executor waits. Earlier work established fixed
definitions, typed tools, structured activations, conditional journal
commits, workspace ownership, and restart evidence. Those regressions stay.
The review of 2026-09-17 found the two defects in phase 1 with
deterministic probes and recorded the rest of this plan.
