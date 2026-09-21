# Next: the must-have scope for 0.1.0

This file is the whole plan for 0.1.0: the scope, the order of the work,
the evidence each step needs, and the reason behind each item.
[backlog.md](backlog.md) holds everything after 0.1.0.
[docs/example.md](../docs/example.md) holds the one example.

**An item lands with its evidence or stays open.** Every checkbox names an
item in [the items](#the-items). A phase closes when its evidence line
holds on main.

## Positioning

**Ambion is a collaboration kernel for agents and humans.** The
[README](../README.md) holds the statement, the key technical facts, and
what is new, written for the 0.1.0 surface. Of the ten novelties it lists,
eight exist on main. Two stay open: any framework through one executor
contract (phase 4) and waiting on a person as a derived outcome (phase 3).

## The scope

**Nine functional areas, each with the acceptance it must meet on the
tagged commit.** The phases below deliver them; the items explain them.

| Area                              | Acceptance                                                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 Definitions and executors      | A definition is a value with one executor. Two executor families run in one room: the Pi loop and the Claude Agent SDK harness. A fixed definition set per run; membership changes by name; a fixed seat that agents cannot remove. |
| F2 Rooms, participation, presence | One ordered journal per room; broadcast and directed messages; the attention scale; visits with recorded arrivals and departures; catch-up by position.                                                                             |
| F3 Concurrent contributions       | Freshness checked at commit; steering by capability; silence as a result; failures classified as permanent or transient; duplicate speech impossible after a lost reply.                                                            |
| F4 Exchanges and summaries        | One open exchange per room; closure by quiescence; outcomes complete, cancelled, exhausted, and awaiting a person; one summary per person who spoke; summaries compact later context; the source stays readable.                    |
| F5 Persistence and recovery       | Idempotent keys bound to content; conditional appends; writer fencing; leases; a graceful stop that loses no pending work; journal format 1 with golden fixtures.                                                                   |
| F6 Tools and resources            | Neutral JSON Schema tools; three room tools on every surface; one resource contract with a filesystem binding and a SQL binding; provenance on every tool call.                                                                     |
| F7 Observation and control        | Detached reads for room, exchange, activation, and step; live events with activation ids; typed refusals; abort and stop with documented scope.                                                                                     |
| F8 Deployment                     | Embedded Node, persistent Node with SQLite, and Cloudflare Durable Objects, each with restart evidence; a Node template and a Cloudflare template from `ambion new`.                                                                |
| F9 Distribution and evidence      | Nine packages on npmjs with provenance; packed consumers outside the monorepo; Node 26; the workbench example scripted and live on two providers; a conformance suite for executors.                                                |

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
  `@ambionframework/ambion/hosting` for hosts and adapters.
- **The kernel imports no model library.** The Claude Agent SDK is a second
  executor package (F10).
- **Speech enters the record through `say` only**, on every executor.
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

**Five lanes run at once.** A lane is a chain of steps that share files.
Steps in different lanes share no files and run in parallel. A step names
the steps it needs; a step with no "Needs" line starts now. Three
priorities sort the work: **P0** blocks the tag; **P1** carries the release
story; **P2** is in scope and can land last.

| Lane | Chain                                                      | Priority |
| ---- | ---------------------------------------------------------- | -------- |
| A    | Phase 2: 16; 17                                            | P0       |
| B    | Phase 4: 2 then 4; 5 and 6 after 4                         | P1       |
| C    | Phase 3: 2                                                 | P1       |
| D    | Phase 8: 1 now; 2 and 3 as each package lands; 4 to 8 last | P0       |
| E    | Phases 6 and 7: each item after the code it describes      | P1       |

**The critical path is 16 and 6.2, then 8.** Start lane A first; when hands
run short, take lane B before lane C, because the adapters carry the
release story.

### Phase 2. The public shape, then the freeze (P0)

**Goal:** every journal field and every read the release needs land, then
the freeze.

- [x] **16.** `format: 1` on the run entry; golden journals per chaos scenario
      with expected folds, replayed in CI; the compatibility promise in
      `durability.md` (D3). Needs phase 3 step 2, because the
      goldens must hold every field and every outcome.
- [ ] **17.** The freeze: a note at the top of this file; additive changes only
      from here to the tag. Needs 16.

**Evidence:** the export snapshot passes with the final names; golden
journals replay.

### Phase 4. Executors and adapters (P1)

**Goal:** two executor families run in one room, proven on fakes in CI.

- [ ] **2.** The executor conformance suite on the scripted executor (D6, F10).
- [ ] **4.** `@ambionframework/claude`: room tools through `createSdkMcpServer`
      per activation; streaming input for steer with the user echo
      advancing `readThrough`; hooks and tool messages as steps; a
      permission request as an `approval` step; policy options passed
      through; a fake executable in CI (F5, F6). Needs 2.
- [ ] **5.** `memory: 'activation' | 'seat'` on both adapters (F9). Needs 4.
- [ ] **6.** `examples/codex`: a thread per activation; the stdio room tools
      server over a local socket; items as steps; `file_change` paths as
      `refs`; a fake `codex` on `PATH` in CI (F6, F10). Needs 4.

**Evidence:** both adapters pass the executor suite on fakes; a room with
one Pi seat and one Claude seat in CI; the assistant
package's prompt shrinks to what the kernel does not enforce.

### Phase 3. Kernel internals (P1)

**Goal:** a current operation costs what the current work costs, and each
mechanism reads in one place.

2. [ ] Exchange outcomes: complete, cancelled, exhausted, `awaiting`;
       `pendingFor(person)`; a summary for each person who spoke (E7).

**Evidence:** outcome reads after restart.

### Phase 6. The workbench example and the user interface (P1)

**Goal:** one example that a new reader runs first, and that the deployment
guide describes. The example is one terminal process with an assistant and
three specialists ([docs/example.md](../docs/example.md)).

2. [ ] The terminal shows steps per activation, the cost per exchange, and
       `awaiting` and `approval` to the person. Needs phase 3 step 2.
3. [ ] `ambion new --template node` derived from the example; the
       Cloudflare template on `read()` (C3). Needs 2.

A second provider for the two live scenarios is optional: Pi's transport
keeps behavior provider-neutral, so add one only if a provider-specific
defect turns up.

**Evidence:** the rooms pass scripted; the live tier runs two scenarios on
one provider; a restart preserves the question.

### Phase 7. Documentation (P1)

**Goal:** a reader meets one voice, one glossary, and one page per
mechanism, with no history of names they never used. Each page starts when
the code it describes lands, so pages run beside the code.

- [ ] **2.** `durability.md`: the format promise, stop semantics, permanent
      failure, commit retry (D3). Needs phase 2 step 16.
- [ ] **3.** `docs/executors.md`: the contract, the steps, the harness matrix,
      how to write an adapter (F). Needs phase 4 step 4.
- [ ] **5.** `docs/patterns.md`: the human patterns table (E7). Needs phase 3
      step 2.
- [ ] **6.** `docs/trust.md`: guarantees between owners, membership authority,
      harness memory (D8, F9). Needs phase 4 step 5.
- [ ] **7.** The `README.md` example typechecked against the packed entries;
      package READMEs; the CLI README; `CONTRIBUTING.md` with the Node
      floors. Needs phase 6 step 3.
- [ ] **8.** A generated API reference per entry with a CI staleness check
      (D10). P2. Needs 7.
- [ ] **9.** The 0.1.0 changelog entry. Last.

**Evidence:** every page in the index has one owner section; the API reference builds in CI; the
README example typechecks against the packed entry.

### Phase 8. Release evidence and sign-off (P0)

**Goal:** the packages install from a public registry, and every claim in
the scope has evidence on the tagged commit.

1. [ ] Publish to npmjs under a prerelease tag; remove the token
       instructions; the release workflow verifies a consumer from npmjs
       (D7). Needs nothing. Start now, because every consumer check below
       installs from it.
2. [ ] Packed consumers outside the monorepo: journal alone; pi-journal
       with journal; kernel with pi; kernel with claude; the workbench; the
       generated Node and Cloudflare projects; the resource-only import.
       Needs 1. Each consumer starts when its packages exist.
3. [ ] One TypeBox version; ESM exports and declarations; package
       contents; lockstep versions. Needs 2.
4. [ ] Node 26 tests and CLI; workerd tests; the historical
       Cloudflare wake and cut races reproduced on current code.
5. [ ] The chaos sweep at 200 seeds; Dafny proofs for every changed rule;
       golden journals; the live tier on one provider; results recorded
       under `planning/evidence/`. Needs phase 2 step 16 and phase 6.
6. [ ] Recovery evidence: duplicate wake, takeover, delayed cut, audit
       retry, clock skew, process pause, uncooperative tool. Needs phase 3
       and phase 4 step 4.
7. [ ] Summary evidence: silence, corrections, conflicting constraints,
       multiple humans, late summaries. Needs phase 3 step 2.
8. [ ] Sign off F1 to F9 above in `planning/evidence/0.1.0.md`; tag
       `v0.1.0`. Needs every step above.

**Evidence:** `npm install @ambionframework/ambion` works without a token;
every consumer above installs and typechecks; the sign-off table names a
commit and a run for each claim.

## The items

Each item states the problem, the solution, and the impact.

### C. Developer experience

**C3. A Node template for `ambion new`.** The README leads with embedded
Node and the CLI creates only a Cloudflare Worker. Add
`--template node`, derived from the workbench with one room and two
definitions, and make it the default.

**C6. Small sharp edges.** A `summary` name no seat holds gives no summary
and no warning; `visit.send()` returns a handle whose `owner` can be another
person; host `seat()` rejects a repeat while the agent tool returns
`unchanged`; the `say` key and a human delivery key share one key space.
Refuse the unheld summary name, add `opened` to
the handle, make the host operation idempotent, and prefix the key kinds.

### D. Scope the release did not name

**D3. A journal format promise with golden fixtures.** The only version
marker is `composition.version`; the `cancel` kind arrived this month and
older runtimes cannot read it; no test replays a journal an earlier build
wrote. Declare format 1, write `format: 1` on the run entry, store golden
journals per chaos scenario with expected folds, replay them in CI, and
state the promise: a 0.1.x runtime reads every 0.1.0 journal.

**Model the format as a header field with a named upgrade path.** The Pi
0.85.1 storage carries a `storageVersion` in its header, and it ships a named
upgrade from format 3 to format 4 that replays the old records into the new
state (`openLegacyV3`, `upgradeLegacyV3ToV4`). Ambion mirrors the shape.
`format: 1` on the run entry is the header field, and the reader dispatches
on it. A later format adds its own reader and one named upgrade, so an older
journal loads through a known path. The golden journals hold the promise: CI
replays a journal each shipped build wrote and checks the fold.

**D6. An executor conformance suite.** Publish `executorConformance` and
run it on every shipped executor, so a third-party executor can prove
conformance.

**D7. A public registry.** Every install path requires a GitHub token.
Publish the nine packages to npmjs with provenance at 0.1.0.

**D8. A trust statement between owners.** No document states what a
foreign agent cannot do (speak under another name, change a summary's
recipient, revive cancelled work), what it can do to others (unseat,
address, steer), and what the kernel does not defend (prompt injection,
tool effects, secrets in transcripts). Write `docs/trust.md` with one table
of guarantees and one of non-guarantees, each linked to its test or
verified rule.

**D10. An API reference.** The docs point at source files for shapes.
Generate a reference per entry from the emitted declarations into
`docs/api/` and fail CI when it is stale.

### E. The kernel story: executors, patterns, artifacts

**The kernel is the protocol, the journal, and the rules.** Everything that
holds a model is an executor. Everything that holds data is a resource.
[`protocol.ts`](../packages/ambion/src/protocol.ts) already honors this: a
seat reaches the room through `view`, `commit`, and `lease`, and the room
reaches a seat through `wake`, `steer`, and `cut`, in plain JSON.

**E3. Neutral room tools and a headless adapter as the proof.** Nothing in
the repository mentions MCP or a headless run. Expose the three room tools
in the hosting entry, serve them over MCP bound to one activation, and add
the Codex example (F6, F10).

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
| Consult privately                   | Every message is visible to every seat  | Another room, by reference                |
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

**F2. Tools at open and a session id on release.** A harness keeps its
session between turns and resumes by id. The executor contract in
`execution/executor.ts` gives a pass the view or a delta. It still needs
the room tools at `open` and a richer result.

```ts
interface ExecutorActivation {
  tools: readonly RoomTool[];
}
interface PassResult {
  stop?: 'length' | 'aborted';
  session?: { harness: string; id: string };
}
```

The driver records `session` on the release.

**F5. Steering by capability, correctness by freshness.** The Claude
adapter advances `readThrough` on the Claude Agent
SDK's `user` echo. A Codex adapter has no `steer` and advances
`readThrough` at the pass boundary, so the driver holds a steer for the
next pass.

**F6. Room tools on every surface.** Write the three room tools once per
adapter in its own form; three fixed schemas need no conversion. Bind each
instance to one activation: in process for Pi, the tool runner, and the
Claude Agent SDK; through a stdio server over a local socket for Codex.
Domain tools written with `defineTool` reach harnesses through the same
stdio server, which serves JSON Schema through the low-level MCP server
API. Pass harness policy through adapter options; a permission request
becomes an `approval` step the application answers.

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
