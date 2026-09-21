# Next: the must-have scope for 0.1.0

> **The freeze (2026-09-20, from commit 8a7f0fe).** The public shape is
> frozen. Every change to the main entry and to the journal bodies is
> additive until the `v0.1.0` tag.
>
> - **The main entry is `@ambionframework/ambion`.** Its exports are the
>   names in `packages/ambion/test/package.test.ts`. The host entry
>   `/hosting` and the conformance entry follow the same rule.
> - **The journal bodies are the room event vocabulary** in
>   `packages/ambion/src/journal/events.ts`. `journal/validate.ts` checks
>   them and `room/fold.ts` reads them.
> - **Additive means one of:** a new export, or a new optional body field.
>   A new entry kind or a new member of the message union is a deliberate
>   change. It needs a new golden journal and a review.
> - **The freeze forbids:** to remove or rename an export, to remove or
>   rename a body field, to change a field type or its meaning, and to
>   remove an entry kind.
> - **One body refuses new fields.** The `close` object inside a `cancel`
>   entry has `additionalProperties: false`. A new field there breaks an
>   older reader.
> - **Three guards catch a violation:** the export snapshot
>   (`test/package.test.ts`), the golden journals (`test/golden.test.ts`),
>   and body validation (`test/journal-validation.test.ts`). A red diff on
>   one of them is a violation. Do not write the snapshot again.
> - **The storage promise** is in the "Storage compatibility" paragraph of
>   [durability.md](../docs/durability.md).

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
what is new, written for the 0.1.0 surface. All ten novelties it lists
exist on main. The open work is the release evidence in phase 8, two
documentation steps, and the items below.

## The scope

**Nine functional areas, each with the acceptance it must meet on the
tagged commit.** The phases below deliver them; the items explain them.

| Area                              | Acceptance                                                                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 Definitions and executors      | A definition is a value with one executor. Three executor families run in one room: the Pi loop, the Claude Agent SDK harness, and the Codex SDK harness. A fixed definition set per run; membership changes by name; a fixed seat that agents cannot remove. |
| F2 Rooms, participation, presence | One ordered journal per room; broadcast and directed messages; the attention scale; visits with recorded arrivals and departures; catch-up by position.                                                                                                       |
| F3 Concurrent contributions       | Freshness checked at commit; steering by capability; silence as a result; failures classified as permanent or transient; duplicate speech impossible after a lost reply.                                                                                      |
| F4 Exchanges and summaries        | One open exchange per room; closure by quiescence; outcomes complete, cancelled, exhausted, and awaiting a person; one summary per person who spoke; summaries compact later context; the source stays readable.                                              |
| F5 Persistence and recovery       | Idempotent keys bound to content; conditional appends; writer fencing; leases; a graceful stop that loses no pending work; journal format 1 with golden fixtures.                                                                                             |
| F6 Tools and resources            | Neutral JSON Schema tools; three room tools on every surface; one resource contract with a filesystem binding and a SQL binding; provenance on every tool call.                                                                                               |
| F7 Observation and control        | Detached reads for room, exchange, activation, and step; live events with activation ids; typed refusals; abort and stop with documented scope.                                                                                                               |
| F8 Deployment                     | Embedded Node, persistent Node with SQLite, and Cloudflare Durable Objects, each with restart evidence; a Node template and a Cloudflare template from `ambion new`.                                                                                          |
| F9 Distribution and evidence      | Ten packages on npmjs; packed consumers outside the monorepo; Node 26; the workbench example scripted and live on three families; a conformance suite for executors.                                                                                          |

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
- **The kernel imports no model library.** The Pi, Claude, and Codex
  executors are packages.
- **Speech enters the record through `say` only**, on every executor.
- **The freeze.** The freeze note at the top of this file
  states the rule.
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

**Two lanes run at once.** Steps in different lanes share no files. A step
names the steps it needs; a step with no "Needs" line starts now. **P0**
blocks the tag; **P2** is in scope and can land last.

| Lane | Chain                                         | Priority |
| ---- | --------------------------------------------- | -------- |
| B    | Phase 8: 1 now; 2 and 3 after it; 4 to 8 last | P0       |
| C    | Documentation: the changelog                  | P2       |

**The critical path is phase 8.** Phase 4 (executors), phase 6 (the
workbench and `ambion new`), and phase 7 (the guides, `trust.md`, and the
README check) are complete on main.

### Phase 7. Documentation, what remains (P2)

- [ ] **9.** The 0.1.0 changelog entry. Last.

**Evidence:** the changelog names each package.

### Phase 8. Release evidence and sign-off (P0)

**Goal:** the packages install from a public registry, and every claim in
the scope has evidence on the tagged commit.

1. [ ] Two release channels (D7). Done: CI publishes a dev build from
       `main` to GitHub Packages under `dev`; `scripts/release.mjs` stages
       an official release on npmjs under `next`, verifies it outside the
       repo, and promotes it to `latest`; no install path needs a token
       for npmjs. Remains, and belongs to the owner: the first real
       `stage`, `verify`, and `promote` from a local machine. CI never
       publishes to npmjs and holds no npmjs token. Every consumer check
       below installs from the staged version.
2. [ ] Packed consumers outside the monorepo: journal alone; pi-journal
       with journal; kernel with pi; kernel with claude; kernel with codex;
       the workbench; the generated Node and Cloudflare projects; the
       resource-only import. `scripts/cli-team-smoke.mjs` exists and no CI
       job runs it; wire it in.
       Needs 1. Each consumer starts when its packages exist.
3. [ ] One TypeBox version; ESM exports and declarations; package
       contents; lockstep versions. Needs 2.
4. [ ] Node 26 tests and CLI; workerd tests; the historical
       Cloudflare wake and cut races reproduced on current code.
5. [ ] The chaos sweep at 200 seeds; Dafny proofs for every changed rule;
       golden journals; the live tier on Pi, Claude, and Codex; results
       recorded under `planning/evidence/`. The live tier of `main` is red
       on one model-sensitive assistant case; diagnose it first. The Claude
       live tier (PR 236) and a Codex value for `AMBION_HARNESS` are open.
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

Each item states the problem, the solution, and the impact.

### D. Scope the release did not name

**D7. A public registry.** Every install path requires a GitHub token.
Publish the ten packages to npmjs at 0.1.0.

## Package decisions

**Ten published packages, one private, one example.** Each package has
one concern and one independent consumer.

| Package                       | Concern                                                       | Depends on          |
| ----------------------------- | ------------------------------------------------------------- | ------------------- |
| `@ambionframework/journal`    | The append-only journal and its storage contract              |                     |
| `@ambionframework/pi-journal` | Pi transcript sessions over journal storage                   | journal             |
| `@ambionframework/ambion`     | The kernel: protocol, journal vocabulary, rules, room, driver | journal             |
| `@ambionframework/pi`         | The Pi executor                                               | ambion, pi-journal  |
| `@ambionframework/claude`     | The Claude Agent SDK executor                                 | ambion              |
| `@ambionframework/codex`      | The Codex SDK executor over a stdio room tools server         | ambion              |
| `@ambionframework/workspace`  | The resource contract and the just-bash Pi binding            | ambion, pi          |
| `@ambionframework/assistant`  | The assistant definition                                      | ambion, pi          |
| `@ambionframework/cloudflare` | Rooms and seats as Durable Objects                            | ambion, journal, pi |
| `@ambionframework/cli`        | `ambion new` and `ambion dev`                                 | ambion              |
| `@ambionframework/evals`      | Private until its own work-left list closes                   | ambion              |
| `examples/workbench`          | The one example: Pi, Claude, and Codex seats                  | all of the above    |

Storage ids, binding names, and published names stay stable through the
source moves. A `SeatObject` class rename needs Cloudflare migration
evidence and is not part of this plan.
