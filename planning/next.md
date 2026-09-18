# Next: the must-have scope for 0.1.0

This file is the whole plan for 0.1.0: the scope, the order of the work,
the evidence each step needs, and the reason behind each item.
[backlog.md](backlog.md) holds everything after 0.1.0.
[docs/example.md](../docs/example.md) holds the one example. Rewritten on
2026-09-17 against main `deaaf94` from a review that read the runtime, the
journal, the adapters, the examples, the docs, the four harness SDKs, and
the open pull requests; two deterministic probes confirmed the defects in
phase 1.

**An item lands with its evidence or stays open.** Every checkbox names an
item in [the items](#the-items). A phase closes when its evidence line
holds on main.

## Positioning

**Ambion is a collaboration kernel for agents and humans.** The
[README](../README.md) holds the statement, the key technical facts, and
what is new, written for the 0.1.0 surface. Of the nine novelties it lists,
the first five exist on main. The last four land in phases 2, 4, and 5: any
framework through one executor contract, the trace beside the record,
artifacts by reference, and waiting on a person as a derived outcome.

## The scope

**Nine functional areas, each with the acceptance it must meet on the
tagged commit.** The phases below deliver them; the items explain them.

| Area                              | Acceptance                                                                                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 Definitions and executors      | A definition is a value with one executor. Two executor families run in one room: the Pi loop and the Claude Agent SDK harness. A fixed definition set per run; membership changes by name; a fixed seat that agents cannot remove.    |
| F2 Rooms, participation, presence | One ordered journal per room; broadcast and directed messages; the attention scale; visits with recorded arrivals and departures; catch-up by position; refs on messages.                                                              |
| F3 Concurrent contributions       | Freshness checked at commit; steering by capability; silence as a result; failures classified as permanent or transient; duplicate speech impossible after a lost reply.                                                               |
| F4 Exchanges and summaries        | One open exchange per room; closure by quiescence; outcomes complete, cancelled, exhausted, and awaiting a person; one summary per person who spoke; summaries compact later context; the source stays readable.                       |
| F5 Persistence and recovery       | Idempotent keys bound to content; conditional appends; writer fencing; leases; a graceful stop that loses no pending work; journal format 1 with golden fixtures; usage on every release entry.                                        |
| F6 Tools and resources            | Neutral JSON Schema tools; three room tools on every surface; one resource contract with a filesystem binding and a SQL binding; provenance on every tool call; bounded context and message size.                                      |
| F7 Observation and control        | Detached reads for room, exchange, activation, and step; live events with activation ids; typed refusals; abort and stop with documented scope; cost per exchange.                                                                     |
| F8 Deployment                     | Embedded Node, persistent Node with SQLite, and Cloudflare Durable Objects, each with restart evidence; the Cloudflare object on the core read model; a Node template and a Cloudflare template from `ambion new`.                     |
| F9 Distribution and evidence      | Nine packages on npmjs with provenance; packed consumers outside the monorepo; Node 22 and 24; the workbench example with nine scenarios scripted and live on two providers; conformance suites for storage, transport, and executors. |

**Deployment models.** The same rules serve four placements.

| Model                         | Placement                         | Persistence               | 0.1.0 support                                                         |
| ----------------------------- | --------------------------------- | ------------------------- | --------------------------------------------------------------------- |
| Embedded Node application     | Room and executors in one process | In-memory journals        | Supported for development, tests, and ephemeral lifetimes             |
| Persistent Node service       | An application-managed service    | SQLite journals           | Supported; the workbench example is the reference host                |
| Separate room and agent hosts | Calls cross the JSON protocol     | Each host chooses storage | Extension contract with a published conformance suite                 |
| Cloudflare Durable Objects    | One object per room, one per seat | Each object's SQLite      | Publishable adapter used by `ambion new`; deployment commands pending |

**Limits the release states.** Full history stays in storage and replay,
and the context window is bounded only by the configured limit. Activation
deadlines and retry caps impose no total exchange budget. Tools can repeat
after failure; applications own effect idempotency. A crash records no
departure. Recovery time depends on lease expiry and host topology. The
journal is no task database, credential service, or transaction
coordinator. Native timers, external event subscriptions, and scheduler
ingress are future work.

## Decisions taken

- **One example.** The site example and Relay are replaced by the agentic
  lab workspace in [docs/example.md](../docs/example.md).
- **Two entries.** `@ambionframework/ambion` for applications and
  `@ambionframework/ambion/hosting` for hosts and adapters. `/transport`
  goes away before the tag (B5).
- **The kernel imports no model library.** Pi becomes an executor package
  and the Claude Agent SDK a second one (E1, F10).
- **Speech enters the record through `say` only**, on every executor (F4).
- **The freeze.** After phase 2, every change to the main entry and to the
  journal bodies is additive until the tag.
- **Shared summaries.** Humans and agents continue from the same recorded
  summary; the source stays in the journal
  ([summary contract](../docs/summary.md)).
- **A public registry.** The packages publish to npmjs at 0.1.0 (D7).
- **Delegation waits.** Tasks and working rooms return by reference after
  0.1.0 ([backlog](backlog.md)).

## The model to preserve

| Concern                                                       | Owner                 | Rule                                                                 |
| ------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------- |
| Definitions, executors, tools                                 | Application code      | Fixed per room run; no executable code in the journal                |
| Membership, presence, messages, exchanges, claims, references | Room journal          | Pure interpretation of confirmed entries                             |
| Model loops, harness sessions, activation steps               | Executor              | One session per activation; steps to the trace, speech through `say` |
| Files, tables, instruments, and their change logs             | Application resources | Independent of journal transactions; stamped with provenance         |
| Timers, runners, subscriptions, live handles                  | Host                  | Recreated after restart                                              |
| Identity selection, discovery, hosting state, delivery outbox | Application           | Explicit entry and stable retry keys                                 |

**Judge a change by the obligation it removes.** Fewer exports are useful
when callers need fewer rules. A rename earns its place only when one name
means two things or two names mean one.

## The order of work

**The critical path is phase 0, 1, 2, 4, 6, then 8.** Phases 3, 5, and 7
run beside it after the freeze. Inside a phase, the steps are numbered in
execution order, and a step names the step it needs. Three priorities sort
the work: **P0** blocks other work or the tag; **P1** carries the release
story; **P2** is in scope and can land last.

| Phase | Name                              | Priority | Starts after | Blocks     |
| ----- | --------------------------------- | -------- | ------------ | ---------- |
| 0     | Unblock the tree                  | P0       |              | 1          |
| 1     | Correctness                       | P0       | 0            | 2          |
| 2     | The public shape, then the freeze | P0       | 1            | 3, 4, 5, 7 |
| 4     | Executors and adapters            | P1       | 2            | 6          |
| 5     | Resources and artifacts           | P1       | 2            | 6          |
| 3     | Kernel internals                  | P1       | 2            | 6          |
| 6     | The workbench example and the UI  | P1       | 3, 4, 5      | 8          |
| 7     | Documentation                     | P1       | 2            | 8          |
| 8     | Release evidence and sign-off     | P0       | 6, 7         | the tag    |

When phases 3, 4, and 5 compete for the same hands, take them in the order
4, 5, 3: the adapters carry the story, the resources feed the example, and
the fold has the least user-visible surface.

### Phase 0. Unblock the tree (P0)

**Goal:** main installs on every supported Node, the open pull requests
are decided, and the live tier can run.

1. [ ] Merge PR #152; note in `durability.md` that a same-key retry is
       bound to its activation (A3).
2. [ ] Close the nine stale pull requests in the [backlog](backlog.md);
       take the export-list assertion into B5 and the changelog into C7.
3. [ ] Hold PR #151; schedule the closing-context slice of PR #153 for
       phase 1; keep the evals package private.
4. [ ] Bump `pi-agent-core` and `pi-ai` to 0.85.1 together in `ambion`,
       `cloudflare`, `pi-journal`, and `workspace`; merge PR #111, #112,
       #5, #6, and #7; rebase PR #4. Needs 1.
5. [ ] Install on Node 22 (C1). Needs 4, because the lockfile moves once.
6. [ ] Restore the provider account; add the second provider job; fail a
       job on a credit or authentication error with the account's name
       (D9). Run the live tier once after 4.
7. [ ] Add `CHANGELOG.md` with an `Unreleased` section (C7).

**Evidence:** CI green on main; `pnpm install` and `pnpm check` on Node 22;
two live jobs green; Dependabot rebases an npm bump.

### Phase 1. Correctness (P0)

**Goal:** the two confirmed defects and the retry of permanent failures are
fixed with regressions, before any rename touches the same files.

1. [ ] `stop()` ends running leases only; pending work survives a graceful
       stop (A2). First, because it loses data today.
2. [ ] Retry a commit under its key; an unknown outcome ends the tool call
       (A1).
3. [ ] Classify provider failures; abandon a permanent failure at once
       (D1). Needs 2, because both change the release path in the runner.
4. [ ] A closing activation reads every message through the close boundary
       with the divider at its exchange (the PR #153 slice).

**Evidence:** the two probes as regressions on memory and SQLite; a 400
reply abandons in one attempt; a resumed room answers a question sent
before a graceful stop.

### Phase 2. The public shape, then the freeze (P0)

**Goal:** every public rename, every journal field, and every read the
release needs land in one window, in an order where each step builds on
the one before it and no file is reshaped twice.

1. [ ] `AgentDefinition` becomes `{ name, identity, executor }`; Pi's
       fields move into `pi({})`; `Runtime` loses `stream`, `model`, and
       `transcripts` (E1).
2. [ ] The executor contract: `open(activation)` returns a session with
       `pass`, optional `steer`, and `close`; the driver (leases, renewals,
       cuts, the wake queue, freshness, delta passes) moves out of the
       runner and the activation into the kernel (E2, F2). Needs 1.
3. [ ] Brand `Runtime`; create the default on first use; narrow the
       application view to `clock` and `storage` (B4). Needs 1.
4. [ ] Two entries, `.` and `/hosting`; `/transport` removed; the export
       list of each entry asserted (B5). Needs 2 and 3, because hosting
       holds the driver and the executor types.
5. [ ] `AmbionError` with codes at every throw site (B7). Needs 4, so the
       files are in their final place.
6. [ ] An activation id on every execution event; `RoomEvent` and
       `ExecutionEvent` under one `subscribe` (B8). Needs 4.
7. [ ] One limits vocabulary (B3), with the `context`, `message`, and
       `trace` groups present and at their current defaults.
8. [ ] A `fixed` seat with the summary writer fixed by default (D4), and
       the sharp edges: room name validation, the unheld summary name,
       `opened` on the handle, idempotent host `seat`, prefixed key kinds
       (C6). Needs 5 for the typed refusals.
9. [ ] `limits.context.messages` and `limits.message.bytes` (D5). Needs 7.
10. [ ] `refs` on spoken messages and summaries; room URIs; `refs` on the
        `say` parameters (E5).
11. [ ] `activation`, `exchange`, and `room` on `ToolContext`, supplied by
        the driver (E6). Needs 2.
12. [ ] The `Step` vocabulary; the trace journal per activation;
        `limits.trace`; the trace policy per definition; live `step`
        events (F4, F7). Needs 6, 7, and 10.
13. [ ] Usage on `activation_end` and on the release entry; a closed
        exchange sums its activations (D2). Needs 2 and 12.
14. [ ] `activations` on the exchange read; `readActivation` (F8). Needs
        12 and 13.
15. [ ] The naming list (C5): `AgentExecutionContext`, `AgentPort`,
        `RoomProtocol`, `lastDeparture`, `messagesSinceDeparture`,
        `ExchangeRead`. Last of the renames, once every type has its final
        home.
16. [ ] `format: 1` on the run entry; golden journals per chaos scenario
        with expected folds, replayed in CI; the compatibility promise in
        `durability.md` (D3). Last, because the goldens must hold every
        field above.
17. [ ] The freeze: a note at the top of this file; additive changes only
        from here to the tag.

**Evidence:** generated declarations list two entries and the export
snapshot passes; a scripted executor passes the driver suite; a fixed seat
refuses an agent's unseat; `readActivation` returns steps; golden journals
replay; `activation_end` carries usage.

### Phase 4. Executors and adapters (P1)

**Goal:** two executor families run in one room, proven on fakes in CI.

1. [ ] `@ambionframework/ambion/testing`: `scripted`, `speak`, `quiet`,
       `callTool`, `byAgent`, `fakeClock`, `settled`; the `stubModel` cast
       removed; the repository's tests moved onto it (C2). First, because
       every later step tests on it.
2. [ ] The executor conformance suite on the scripted executor (D6, F10).
       Needs 1.
3. [ ] `@ambionframework/pi`: the Pi executor moved out of the kernel; the
       `Agent` kept across passes; `prompt()` with the delta; the Pi
       journal as its private audit (F2, F5). Needs 2.
4. [ ] Three prompt parts and `renderDelta`; the default speaking policy as
       one replaceable constant; prompt snapshots for an ordinary and a
       closing activation (B6, F3). Needs 3.
5. [ ] `@ambionframework/claude`: room tools through `createSdkMcpServer`
       per activation; streaming input for steer with the user echo
       advancing `readThrough`; hooks and tool messages as steps; a
       permission request as an `approval` step; policy options passed
       through; a fake executable in CI (F5, F6). Needs 2 and 4.
6. [ ] `memory: 'activation' | 'seat'` on both adapters (F9). Needs 3
       and 5.
7. [ ] `examples/codex`: a thread per activation; the stdio room tools
       server over a local socket; items as steps; `file_change` paths as
       `refs`; a fake `codex` on `PATH` in CI (F6, F10). Needs 5.
8. [ ] The storage and transport conformance suites, published and run on
       memory, SQLite, the in-process transport, and the Cloudflare RPC
       transport (D6).

**Evidence:** both adapters pass the executor suite on fakes; a room with
one Pi seat and one Claude seat in CI; prompt snapshots; the assistant
package's prompt shrinks to what the kernel does not enforce.

### Phase 5. Resources and artifacts (P1)

**Goal:** artifacts are references on the record with provenance behind
them, and the workspace is one binding of one resource contract.

1. [ ] The neutral resource contract at `@ambionframework/workspace/resource`;
       just-bash and its Pi tools as the Pi binding (E4).
2. [ ] A change log in the workspace binding keyed by activation, with
       `changes({ exchange })` (E6). Needs 1 and phase 2 step 11.
3. [ ] A read-only SQL resource over `node:sqlite` with `query` and
       `record` tools, for the example (E4). Needs 1.
4. [ ] The instrument resource for the example, with approval on a limit.
       Needs 3 and phase 4 step 5 for the `approval` step.
5. [ ] Workspace `/dev/null` and the backend matrix on both backends.

**Evidence:** two resources on one contract; "what changed during this
exchange" answered from the change log; a summary that cites a ref.

### Phase 3. Kernel internals (P1)

**Goal:** a current operation costs what the current work costs, and each
mechanism reads in one place.

1. [ ] The incremental projection with the equivalence property test under
       cancellation, reseating, late summaries, takeover, and restart (B1).
       First, because it is the largest risk and the outcomes build on it.
2. [ ] Exchange outcomes: complete, cancelled, exhausted, `awaiting`;
       `pendingFor(person)`; a summary for each person who spoke (E7).
       Needs 1.
3. [ ] `room-host.ts` split by mechanism with a file budget in the gate
       (B2). Needs 1, so the split moves the incremental code once.
4. [ ] The Cloudflare object on the core read model; alarms through
       `reconcileRoom` in hosting (B9). Needs 3.

**Evidence:** the equivalence test; the envelope remeasured at 100, 1,000,
and 4,000 closed exchanges; outcome reads after restart; the Cloudflare
template on `read()`.

### Phase 6. The workbench example and the user interface (P1)

**Goal:** one example that a new reader runs first, that the deployment
guide describes, and that the drill-down UI is built on.

1. [ ] Remove `examples/site` and `examples/persistent`; move their reports
       and `docs/assistant-acceptance.md` under `planning/evidence/` (C7).
2. [ ] `examples/workbench` per [docs/example.md](../docs/example.md): the
       definitions, the SQL resource, the library workspace, the
       instrument, the persistent host with a room per project, the
       library files. Needs phases 4 and 5.
3. [ ] The nine scenarios on the scripted executor, including the restart
       scenario in a fresh process. Needs 2.
4. [ ] The user interface: projects, room, exchange, activation, steps;
       live steps merged by activation, pass, and index; cost per exchange;
       `awaiting` and `approval` shown to the person (F8). Needs 3 and
       phase 3 step 2.
5. [ ] The scenarios on the live tier, on two providers. Needs 3.
6. [ ] `ambion new --template node` derived from the example; the
       Cloudflare template on `read()` (C3). Needs 2 and phase 3 step 4.

**Evidence:** the nine scenarios pass scripted on memory and SQLite; the
live tier runs them on two providers; a restart preserves the question; the
Design Agent runs on the Claude adapter while the rest run on Pi.

### Phase 7. Documentation (P1)

**Goal:** a reader meets one voice, one glossary, and one page per
mechanism, with no history of names they never used. Each page follows the
code it describes, so the order follows the phases above.

1. [ ] `docs/room.md`: the overview and the glossary; the index leads with
       it; `agent.md` becomes the definitions and tools page (C4, C5).
       After phase 2.
2. [ ] `durability.md`: the format promise, stop semantics, permanent
       failure, commit retry (A1, A2, D1, D3). After phase 2.
3. [ ] `docs/envelope.md`: the limits table and the measured envelope (B3,
       B1, D5). After phase 3 step 1.
4. [ ] `docs/executors.md`: the contract, the steps, the harness matrix,
       how to write an adapter (F). After phase 4 step 5.
5. [ ] `docs/resources.md`: the contract, references, provenance;
       `workspace.md` becomes the Pi binding page (E4 to E6). After
       phase 5.
6. [ ] `docs/patterns.md`: the human patterns table (E7). After phase 3
       step 2.
7. [ ] `docs/trust.md`: guarantees between owners, membership authority,
       harness memory (D8, D4, F9). After phase 4 step 6.
8. [ ] Retire the residue: rule citations, migration notes, package
       descriptions, comment voice, `demos/README.md` (C4). After 1.
9. [ ] `README.md` around the workbench; package READMEs; the CLI README;
       `CONTRIBUTING.md` with the Node floors. After phase 6 step 3.
10. [ ] A generated API reference per entry with a CI staleness check
        (D10). P2; after 9.
11. [ ] The 0.1.0 changelog entry. Last.

**Evidence:** every page in the index has one owner section; no numbered
rule citations remain in source; the API reference builds in CI; the
README example typechecks against the packed entry.

### Phase 8. Release evidence and sign-off (P0)

**Goal:** the packages install from a public registry, and every claim in
the scope has evidence on the tagged commit.

1. [ ] Publish to npmjs under a prerelease tag; remove the token
       instructions; the release workflow verifies a consumer from npmjs
       (D7). First, because every consumer check below installs from it.
2. [ ] Packed consumers outside the monorepo: journal alone; pi-journal
       with journal; kernel with pi; kernel with claude; the workbench; the
       generated Node and Cloudflare projects; the resource-only import.
       Needs 1.
3. [ ] One TypeBox version; ESM exports and declarations; package
       contents; lockstep versions. Needs 2.
4. [ ] Node 22 and 24 tests; Node 26 CLI; workerd tests; the historical
       Cloudflare wake and cut races reproduced on current code.
5. [ ] The chaos sweep at 200 seeds; Dafny proofs for every changed rule;
       golden journals; the live tier on two providers; results recorded
       under `planning/evidence/`.
6. [ ] Recovery evidence: duplicate wake, takeover, delayed cut, audit
       retry, clock skew, process pause, uncooperative tool.
7. [ ] Summary evidence: silence, corrections, conflicting constraints,
       multiple humans, late summaries.
8. [ ] Sign off F1 to F9 above in `planning/evidence/0.1.0.md`; tag
       `v0.1.0`. Needs every step above.

**Evidence:** `npm install @ambionframework/ambion` works without a token;
every consumer above installs and typechecks; the sign-off table names a
commit and a run for each claim.

## The items

Each item states the problem, the solution, and the impact. The review of
2026-09-17 established the facts; file links point at main `deaaf94`.

### A. Correctness

**A1. Retry a commit under its key before reporting it lost.**
[`runner.ts`](../packages/ambion/src/execution/runner.ts) retries a claim and
a release up to `call.attempts` times and sends a commit once. When the
reply is lost, the `say` tool throws, and a model that repeats itself lands
the same message twice under a new tool call id; a probe recorded three
commits and two identical answers. Send a commit through the retrying path
with the same key, and end the tool call with an unknown outcome when every
attempt is lost. Duplicate speech after a lost reply becomes impossible.

**A2. Let unclaimed work survive a graceful stop.** `stop()` in
[`room-host.ts`](../packages/ambion/src/room-host.ts) ends every entry in
`state.due` as `revoked`, and [`lease.ts`](../packages/ambion/src/room/lease.ts)
counts a revoked lease at the message position as answered, so a resumed
room never wakes the seat. A probe showed the crash path preserving a
question and the stop path discarding it; Relay's shutdown calls `stop()`
for every room. Let stop end running leases only and write nothing for an
activation that never claimed. A deploy restart loses no accepted question.

**A3. Bind delivery keys and identity to journal facts.** A reused delivery
key acknowledges another person's message, the journal exposes its mutable
cache, and the Cloudflare object writes a person's identity before
admission. PR #152 fixes all three with one new journal method,
`entriesFrom(start)`, and no new room API. Merge it first.

### B. Architecture

**B1. Fold the journal incrementally.** `state()` calls `evolve()` per new
entry, and [`fold.ts`](../packages/ambion/src/room/fold.ts) recomputes people,
roster, exchange, pending wakes, and owed drafts from the whole history on
each call; 1,000 closed exchanges cost 590 ms to fold and 48 ms per new
question, and 4,000 cost 10 seconds and 412 ms. PR #152 adds a clone per
heard entry. Make `RoomState` an evolving projection with indexes that one
entry updates, keep `foldRoom` as the reference, and add one property test
that compares both under cancellation, reseating, late summaries, takeover,
and restart. A room with a year of history answers at the speed of one with
a day.

**B2. Split the room host by mechanism.** `room-host.ts` holds 1,468 lines
and seven mechanisms; the complexity rule bounds a function and nothing
bounds a file. Cut it into `host/room.ts` (phases, compose, recover,
`submit`, `hear`), `host/people.ts` (visits), `host/dispatch.ts` (ports,
delivery state, send, steer, cut), `host/waits.ts` (exchange handles), and
`host/control.ts` (reconcile, alarm, stop, abort, evict), each over a
narrow view of the room, and add a file line budget to the gate.

**B3. One vocabulary for limits.** The runtime exposes `wake.resend`,
`wake.expiry`, `wake.deadline`, `retry.attempts`, `retry.backoff`,
`call.attempts`, and `call.timeout`, beside the constants `AUDIT_ATTEMPTS`
and `PASSES`; the names do not say what they bound. Rename by scope and keep
the defaults.

```ts
limits: {
  delivery: { resend: 5_000 },
  lease: { ttl: 60_000, deadline: 600_000 },
  activation: { attempts: 3, backoff: (n) => n * 30_000 },
  call: { attempts: 2, timeout: 10_000 },
  context: { messages: Infinity },
  message: { bytes: Infinity },
  trace: { toolOutputBytes: 65_536, stepsPerPass: 1_000 },
}
```

**B4. Give the runtime a nominal identity.** `Runtime` is structural, its
identity lives in a private `WeakMap`, and a spread copy fails at the first
call. `defaultRuntime` is created at import. Brand the type, narrow the
application view to `clock` and `storage`, move the rest to hosting, and
create the default on first use.

**B5. Two entries: application and hosting.** `/transport` exports the
runner, the execution services, the audit id, the live-room lookup, and the
wire types; the main entry exports `Room.reconcile()` and `runtime.evict()`,
which only hosts call. Ship `.` and `/hosting`, remove `/transport`, and
assert the sorted export list of each entry in `package.test.ts`.

**B6. Separate mechanism text from speaking policy in prompts.**
[`render.ts`](../packages/ambion/src/execution/render.ts) holds about 11,600
characters of prompt text and the assistant package 7,700 more; part
describes the mechanism and part is speaking policy that every agent gets
and no definition can replace. Keep the mechanism text in the kernel, export
the policy as one `DEFAULT_GUIDANCE` a definition can replace, and snapshot
the rendered prompts.

**B7. Typed refusals.** The core throws 75 plain `Error` values; Relay and
the template map them by reading the message. Add `AmbionError` with a
closed set of codes (`room_stopped`, `room_running`, `no_composition`,
`missing_definition`, `visit_ended`, `not_present`, `unknown_participant`,
`duplicate_name`, `invalid_name`, `invalid_tool`, `refused`, `stale`,
`superseded`) and keep the messages.

**B8. Activation identity on every execution event.** `activation_start`,
`activation_end`, `conflict`, `tool_execution_*`, and `error` carry no
activation id; the Cloudflare seat object substitutes the seat's current
one. Add `activation` to every event an activation raises and split the
union into `RoomEvent` and `ExecutionEvent` under one `subscribe`.

**B9. Keep the Cloudflare object on the core read model.** The room object
still exposes `messages()`, `participants()`, and a `status()` with an
`exchangeState` the core does not define, and takes agent names where the
core takes definitions. Expose the core surface plus `start` and
`ensureStart`, and move the template to `read()`.

### C. Developer experience

**C1. Install on the supported Node floor.** Every manifest declares Node
`>=22.19`; `@opentui/core` declares `>=26.4`, and `.npmrc` sets
`engine-strict=true`, so `pnpm install` fails on Node 22 before it installs
anything, and Dependabot cannot rebase npm bumps. Load OpenTUI lazily as an
optional dependency or move the terminal client to its own package; make
the root `engines` true; install on Node 22 in CI.

**C2. Publish the deterministic test tools.** The scripted stream and the
fake clock live in `test/support`; PR #153 re-implements the stream three
times and polls `reconcile()` and `read()` to wait for a quiet room.
Publish `@ambionframework/ambion/testing` with `scripted`, `speak`,
`quiet`, `callTool`, `byAgent`, `fakeClock`, and `settled(room)` built on
the public read; remove the `stubModel` cast.

**C3. A Node template for `ambion new`.** The README leads with embedded
Node and the CLI creates only a Cloudflare Worker. Add
`--template node`, derived from the workbench with one room and two
definitions, and make it the default.

**C4. Retire pre-release residue.** Eight source comments cite numbered
rules that `docs/agent.md` no longer has; four migration notes describe
renames before any release; the core manifest describes "a minimalist
framework for ambient-aware, always-on agents"; `demos/README.md` names a
removed API. Fix each before the tag, and state two limits the docs omit:
passes share no model context without an adapter session, and a second
person's question inside an open exchange belongs to that exchange.

**C5. One word, one meaning.** "Seat" names membership, the `seats` map,
the `seat()` operation, the executor dependencies, and the wire. "Exchange"
names five types. `streamFn` and `stream` name one thing. `Visit.since` is a
departure position with a cursor's name.

| Current                     | Proposed                     |
| --------------------------- | ---------------------------- |
| `SeatContext`               | `AgentExecutionContext`      |
| `SeatPort` / `SeatRoom`     | `AgentPort` / `RoomProtocol` |
| `streamFn` (room option)    | `stream`, then into `pi({})` |
| `Visit.since`               | `Visit.lastDeparture`        |
| `ContextParticipant.unseen` | `messagesSinceDeparture`     |
| `ExchangeSnapshot`          | `ExchangeRead`               |
| "catalog" (docs)            | "definitions"                |

**C6. Small sharp edges.** `startRoom` validates participant names and
never the room name; a `summary` name no seat holds gives no summary and
no warning; `visit.send()` returns a handle whose `owner` can be another
person; host `seat()` rejects a repeat while the agent tool returns
`unchanged`; the `say` key and a human delivery key share one key space.
Validate the room name, refuse the unheld summary name, add `opened` to
the handle, make the host operation idempotent, and prefix the key kinds.

**C7. Lighten the planning and evidence files.** `demos/` holds 4.4 MB of
generated HTML; `docs/assistant-acceptance.md` is a dated review; no
changelog exists. Move dated evidence under `planning/evidence/`, add
`CHANGELOG.md`, and require an entry from every pull request that changes a
public entry.

### D. Scope the release did not name

**D1. Classify a permanent failure and stop retrying it.**
[`activation.ts`](../packages/ambion/src/execution/activation.ts) treats every
provider error alike and the reconcile rule retries with backoff to the
cap; the live tier on 2026-09-17 spent three activations and 90 seconds on
a 400 "credit balance is too low" before an `abandoned` event and a silent
close. Carry `cause: 'permanent' | 'transient'` on the failed lease end
and on the `error` and `abandoned` events; abandon a permanent failure at
once.

**D2. Usage and cost on every activation.** Pi's `AssistantMessage` carries
`usage` with tokens and cost, and the runner persists those messages;
nothing sums them, and the prompt tells agents that attention costs money.
Sum usage at release, put it on `activation_end` and the release entry, and
let a closed exchange sum its activations.

**D3. A journal format promise with golden fixtures.** The only version
marker is `composition.version`; the `cancel` kind arrived this month and
older runtimes cannot read it; no test replays a journal an earlier build
wrote. Declare format 1, write `format: 1` on the run entry, store golden
journals per chaos scenario with expected folds, replay them in CI, and
state the promise: a 0.1.x runtime reads every 0.1.0 journal.

**D4. Membership authority for independently owned agents.** Any ordinary
activation can unseat any agent, including the summary writer, after which
every exchange closes with no summary; the assistant package instructs its
model to keep itself seated. Add `fixed: true` on a seat, fix the summary
writer by default, and refuse an agent's unseat of a fixed seat in
`transition.ts`; the host can always seat and unseat.

**D5. Bounded activation context and message size.** Every ordinary
activation renders the whole record, and only a summary writer compacts;
the kernel accepts a message of any size. Add `limits.context.messages`
(the open exchange whole, then earlier exchanges newest first, with an
omission line) and `limits.message.bytes` with a typed refusal, both
defaulting to current behavior.

**D6. Conformance suites for storage and transport.** Five storage cases
exist in `packages/journal/test/storage.test.ts` and transport cases only in
workerd; neither is published, so a Postgres storage or a queue transport
cannot prove conformance. Publish `storageConformance`,
`transportConformance`, and `executorConformance`, and run them on every
shipped adapter.

**D7. A public registry.** Every install path requires a GitHub token.
Publish the nine packages to npmjs with provenance at 0.1.0.

**D8. A trust statement between owners.** No document states what a
foreign agent cannot do (speak under another name, change a summary's
recipient, revive cancelled work), what it can do to others (unseat,
address, steer), and what the kernel does not defend (prompt injection,
tool effects, secrets in transcripts). Write `docs/trust.md` with one table
of guarantees and one of non-guarantees, each linked to its test or
verified rule.

**D9. Provider evidence beyond one account.** The live tier runs one
provider on one key; on 2026-09-17 every live run failed on that account's
balance. Run two providers as separate jobs and fail on a credit or
authentication error with the account's name.

**D10. An API reference.** The docs point at source files for shapes.
Generate a reference per entry from the emitted declarations into
`docs/api/` and fail CI when it is stale.

### E. The kernel story: executors, patterns, artifacts

**The kernel is the protocol, the journal, and the rules.** Everything that
holds a model is an executor. Everything that holds data is a resource.
[`protocol.ts`](../packages/ambion/src/protocol.ts) already honors this: a
seat reaches the room through `view`, `commit`, and `lease`, and the room
reaches a seat through `wake`, `steer`, and `cut`, in plain JSON.

**E1. Take Pi out of the kernel vocabulary.** The room reads two fields of
a definition, `name` and `identity`; every other field is Pi's, and
[`types.ts`](../packages/ambion/src/types.ts) imports Pi's result, callback,
execution mode, and model types. `Runtime` carries a Pi stream, resolver,
and transcript opener. Let a definition be `{ name, identity, executor }`,
move Pi's fields into `pi({ model, instructions, tools })`, and remove the
three Pi fields from `Runtime`. The composition entry already stores only
name, identity, and attention, so stored rooms are unaffected.

**E2. One executor contract and one activation driver.** The runner and
the activation hold a neutral half (claims, renewals, cuts, the wake queue,
the pass loop, freshness) and a Pi half (building an `Agent`, steering it,
reading its stop reason, persisting its transcript). Keep the driver in the
hosting entry and reduce a framework to the contract in F2. Ship Pi as
`@ambionframework/pi`.

**E3. Neutral room tools and a headless adapter as the proof.** Nothing in
the repository mentions MCP or a headless run. Expose the three room tools
in the hosting entry, serve them over MCP bound to one activation, and add
the Codex example (F6, F10).

**E4. The workspace as one binding among many.** All five workspace source
files import Pi; the resource owner (`openResource`, `use`, `dispose`,
`destroy`) is neutral and already has its own entry. Keep that entry as the
resource contract, make just-bash and its Pi tools the Pi binding, and add
a read-only SQL resource over `node:sqlite` in the example.

**E5. Artifact references on the record.** Agents write files and the
record never mentions them; a summary cannot cite what it summarizes; a
message cannot point at another room. Let a spoken message and a summary
carry `refs`, a list of URIs the kernel validates, stores, renders, and
never reads behind. Give rooms `ambion://room/<name>` and
`ambion://room/<name>/exchange/<from>`. Add `refs` to the `say` parameters.

**E6. Provenance for resources.** `ToolContext` carries the agent, the
call id, the signal, and an update callback, and no activation, exchange,
or room. Add the three as immutable fields, supplied by the driver, and let
the workspace binding keep a change log keyed by activation with
`changes({ exchange })`.

**E7. The human patterns the room represents.** The table reads the
primitives against common patterns; two gaps need a rule.

| Pattern                             | Today                                   | Gap                                       |
| ----------------------------------- | --------------------------------------- | ----------------------------------------- |
| Ask and get an answer               | Exchange, close, optional summary       |                                           |
| Ongoing room over days              | Visits, presence, catch-up, resume      |                                           |
| Broadcast, no reply owed            | A said message; seats may stay silent   |                                           |
| Bring in a specialist               | Reserve, `seat`, directed say           |                                           |
| Steer work in progress              | Steer between provider requests         |                                           |
| Two people in one discussion        | Second question joins the open exchange | Summary reaches the owner only            |
| Waiting on a person                 | The exchange closes when agents stop    | "Done" and "waiting on you" read the same |
| Approve before an agent acts        | A directed question to a person         | The wait has no representation            |
| Stop one agent, keep the room       | `unseat` revokes its lease              | Document it                               |
| Consult privately                   | Every message is visible to every seat  | Another room, by reference (E5)           |
| Delegate to a working group         | PR #151 proposes tasks                  | Backlog                                   |
| Vote, sign off, structured decision | Application tools and artifacts         | Outside the kernel by design              |
| Scheduled check-in                  | Backlog: timers                         |                                           |

Derive `awaiting` for a closed exchange whose last spoken message is
directed at a person who has said nothing since; add `pendingFor(person)`
to the room read; let the closing commit address any person whose message
lies in the exchange's range, one summary each. No new entry kind and no
timer.

### F. Harness adapters and the activation trace

**Four surfaces, two families.** Pi's agent core and the Anthropic SDK tool
runner give the caller the loop. The Claude Agent SDK and the Codex SDK own
the loop and hand back events. The matrix reads the four as their sources
describe them on 2026-09-17.

| Capability         | Pi agent core                                                              | Anthropic SDK tool runner          | Claude Agent SDK                                                                              | Codex SDK                                                                           |
| ------------------ | -------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Loop owner         | Caller                                                                     | SDK helper, caller hosted          | Harness                                                                                       | Harness                                                                             |
| Steer during a run | `agent.steer(message)`, after the current turn's tool calls                | Between turns                      | `prompt` as `AsyncIterable<SDKUserMessage>`                                                   | None; the next `run` on the same thread                                             |
| Cut                | `agent.abort()`                                                            | `stream.controller.abort()`        | `query.interrupt()` or `abortController`                                                      | `TurnOptions.signal`                                                                |
| Stream             | `message_update` with `text_delta` and `thinking_delta`                    | `content_block_delta`              | `includePartialMessages` gives `stream_event`                                                 | `item.started`, `item.updated`, `item.completed`                                    |
| Thinking           | `ThinkingContent` blocks and deltas                                        | `thinking` blocks                  | `thinking` blocks in assistant messages                                                       | `reasoning` items                                                                   |
| Tool calls         | `tool_execution_start`, `_update`, `_end` with `args`, `result`, `isError` | Runner hooks and `tool_use` blocks | `tool_use`, `tool_result`; `PreToolUse`, `PostToolUse`, `PostToolUseFailure` hooks            | `command_execution`, `file_change`, `mcp_tool_call`, `web_search` items with status |
| Room tools         | `AgentTool` with TypeBox parameters                                        | `betaZodTool` or JSON Schema       | `createSdkMcpServer` with `tool()`, or a stdio MCP server                                     | A stdio MCP server through `config.mcp_servers`                                     |
| Usage              | `AssistantMessage.usage`: tokens and cost                                  | `message.usage`                    | `usage` and `cost` on messages; a `cost` message                                              | `turn.completed.usage`: tokens, no cost                                             |
| Failure            | `stopReason` `error` with `errorMessage`; `length`; `aborted`              | Typed errors with `status`         | `result` subtypes; the `StopFailure` hook                                                     | `turn.failed`; `error` items                                                        |
| Resume             | Session tree in the Pi journal                                             | The caller's history array         | `resume`, `continue`, `forkSession`, `resumeSessionAt`                                        | `resumeThread(id)`                                                                  |
| Policy             | The caller's tools                                                         | The caller's tools                 | `permissionMode`, `allowedTools`, `canUseTool`, `PermissionRequest`, `maxBudgetUsd`, `effort` | `sandboxMode`, `approvalPolicy`, `modelReasoningEffort`, `networkAccessEnabled`     |
| Place              | None                                                                       | None                               | `cwd`, `additionalDirectories`                                                                | `workingDirectory`, `additionalDirectories`                                         |

Every surface streams text, thinking, and tool activity with enough
identity to rebuild a step list. Every surface reports usage. Two take a
message during a run and two do not, so steering is a capability an
adapter declares, and correctness rests on freshness alone.

**F2. A session with passes as the executor contract.** A harness keeps
its session between turns and resumes by id; the Pi executor builds a new
`Agent` per pass and rereads the whole record. Make the unit a session and
the pass a turn on it.

```ts
interface Executor {
  open(activation: {
    spec: ActivationSpec;
    tools: readonly RoomTool[];
    trace: TraceSink;
    signal: AbortSignal;
  }): Promise<ExecutorSession>;
}
interface ExecutorSession {
  pass(input: PassInput): Promise<PassResult>;
  steer?(steer: Steer): Promise<void>;
  close(): Promise<void>;
}
type PassInput =
  { kind: 'view'; view: ActivationView } | { kind: 'delta'; since: Seq; view: ActivationView };
interface PassResult {
  readThrough: Seq;
  stop: 'stopped' | 'length' | 'aborted';
  failure?: { cause: 'permanent' | 'transient'; error: Error };
  session?: { harness: string; id: string };
}
```

The driver keeps the lease, the renewal, the cut, the wake queue, the
freshness check, and the decision to run another pass; it renders a delta
for every pass after the first and records `session` on the release.

**F3. Three prompt parts and a delta.** The renderer returns `mechanism`
(per kernel version), `agent` (per definition), and `context` (per pass);
each adapter places them: the Pi system prompt, the Anthropic `system` with
`cache_control`, the Claude Agent SDK `appendSystemPrompt`, a Codex
preamble or `AGENTS.md`. `renderDelta(view, since)` renders a later pass.

**F4. Speech through `say`; one step vocabulary.** A harness ends a turn
with text, and none of it is speech in the room. The record takes speech
through `say` only, and every other output maps to one step:

```ts
type Step =
  | { type: 'pass'; pass: number; input: 'view' | 'delta'; through: Seq }
  | { type: 'thinking'; text: string; final: boolean }
  | { type: 'text'; text: string; final: boolean }
  | { type: 'tool_call'; call: string; name: string; input: unknown }
  | { type: 'tool_result'; call: string; output: unknown; error?: string }
  | {
      type: 'room';
      call: string;
      intent: Intent;
      result: 'committed' | 'unchanged' | 'missed' | 'refused' | 'stale';
      seq?: Seq;
    }
  | { type: 'steer'; seq: Seq; consumed: boolean }
  | { type: 'approval'; call: string; name: string; decision?: 'allow' | 'deny' }
  | {
      type: 'usage';
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost?: number;
    }
  | { type: 'end'; stop: PassResult['stop']; failure?: PassResult['failure'] };
```

Every step carries `activation`, `pass`, `at`, and an index. Pi deltas and
tool events, Anthropic content blocks, Claude Agent SDK messages and hooks,
and Codex items each map onto these ten kinds; a Codex `file_change` names
paths that become `refs`.

**F5. Steering by capability, correctness by freshness.** The driver
delivers a steer to `session.steer` when the adapter defines it and holds
it for the next pass otherwise. `readThrough` advances only on evidence:
Pi's provider request, the Claude Agent SDK's `user` echo, and for Codex
the pass boundary. An unconsumed steer or a moved record triggers a delta
pass.

**F6. Room tools on every surface.** Write the three room tools once per
adapter in its own form; three fixed schemas need no conversion. Bind each
instance to one activation: in process for Pi, the tool runner, and the
Claude Agent SDK; through a stdio server over a local socket for Codex.
Domain tools written with `defineTool` reach harnesses through the same
stdio server, which serves JSON Schema through the low-level MCP server
API. Pass harness policy through adapter options; a permission request
becomes an `approval` step the application answers.

**F7. The activation trace, durable and live.** The Pi transcript is
written once at the end of an activation, in Pi's shape, so nothing is
visible while an agent works. Let the driver write every step to
`ambion/trace/<room>/<activation>` as it arrives, coalesced per block,
bounded by `limits.trace`, under a per-definition policy
`trace: { thinking: 'omit' | 'summary' | 'full', toolOutput: 'omit' | 'full' }`,
and emit the same steps live as `{ type: 'step', activation, step }`. Keep
the Pi journal as the Pi executor's private audit.

**F8. The drill-down read path.** `readRoom` lists exchanges;
`readExchange` gains `activations` (id, seat, attempt, purpose, outcome,
usage, harness session) from the leases in its range; `readActivation`
returns steps by pass from the trace journal; `subscribe` streams steps
with an activation id. Steps order by activation, pass, and index, so a UI
merges live and read the way it merges messages by `seq`.

**F9. Harness memory across activations.** `memory: 'activation'` opens a
session per activation; `memory: 'seat'` resumes one harness session per
seat across activations and records the id with each release. Freshness
governs speech in both modes; the trust page states that a seat with memory
holds state the record does not show.

**F10. Ship two adapters and test them with fakes.** `@ambionframework/pi`
and `@ambionframework/claude` ship in 0.1.0 with `examples/codex` beside
them. The executor conformance suite runs each on a fake: a scripted
`streamFn`, a fake executable through `pathToClaudeCodeExecutable`, a fake
`codex` on `PATH`. It drives a wake, a first pass, a say, a missed say, a
delta pass, and a release; a cut during a tool call; a steer consumed and
held; a permanent and a transient failure; usage on release; the trace
journal's contents.

## Package decisions

**Nine published packages, one private, two examples.** Each package has
one concern and one independent consumer.

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

## History

PRs #137 to #150 delivered durable presence and control, idempotent visits,
coherent room views, partial-creation recovery, contribution validation,
executor composition, participant vocabulary, coherent reads, the assistant
package, and bounded executor waits. Earlier work established fixed
definitions, typed tools, structured activations, conditional journal
commits, workspace ownership, and restart evidence. Those regressions stay.
