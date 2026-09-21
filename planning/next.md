# Next: the scope for 0.2.0

> **The compatibility rule since 0.1.0.** 0.1.0 shipped on 2026-09-21 from
> commit 4026bdf, with ten packages on npmjs. Its public shape stands until
> the 0.2.0 tag. Every change to the main entry and to the journal bodies is
> additive, unless an item below names a deliberate break.
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
> - **The rule forbids:** to remove or rename an export, to remove or
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
>   [durability.md](../docs/durability.md). A journal that 0.1.0 wrote stays
>   readable.

This file is the whole plan for 0.2.0: the scope, the order of the work,
the evidence each step needs, and the reason behind each item.
[backlog.md](backlog.md) holds everything after 0.2.0. The
[changelog](../CHANGELOG.md) records what 0.1.0 shipped.
[simplify.md](simplify.md) proposes the consolidation and hygiene work the
owner can fold into this scope.

**An item lands with its evidence or stays open.** Every checkbox names an
item in [the items](#the-items). A phase closes when its evidence line
holds on main.

## Positioning

**Ambion is a collaboration kernel for agents and humans.** The
[README](../README.md) holds the statement and the key technical facts.
0.1.0 makes a room a place that agents and people use when they ask a
question. 0.2.0 makes a room a place that stays useful between questions:
work that starts from an event, work that other rooms take on, and a
release that anyone can repeat.

## The scope

**Four themes, each with the acceptance it must meet on the tagged
commit.** The phases below deliver them; the items explain them. This scope
is a proposal from the 0.1.0 backlog. The owner sets the final list.

| Theme                     | Acceptance                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W Wake sources            | A room wakes a seat on a notice from a resource, on a timer, and on a scheduler tick, each with a durable start and restart evidence. An `awaiting` exchange expires on a stated bound.        |
| D Delegation by reference | A working room is a room. A message that carries a ref to it delegates the work. The origin exchange awaits the working room, and one message with a ref returns the result. No task database. |
| S Scale of the record     | A checkpoint entry lets a resume skip settled history. Full replay stays the reference and the two agree on every golden journal.                                                              |
| R Release and hygiene     | A release that a trusted CI workflow runs with provenance. A dev build stamp that follows the next release. An API reference that CI keeps fresh.                                              |

**Carried from 0.1.0.** The pull requests that wait stay open: #151, #153,
#171, #234, the Pi pair (#113 and #114), and the dependency bumps.

**Deployment models.** The same rules serve four placements.

| Model                         | Placement                         | Persistence               | Support                                                               |
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
coordinator. Timers and scheduler ingress arrive with theme W and not
before.

## Decisions taken

- **One example.** The agentic lab workspace in
  [docs/example.md](../docs/example.md) stays the one example.
- **Two entries.** `@ambionframework/ambion` for applications and
  `@ambionframework/ambion/hosting` for hosts and adapters.
- **The kernel imports no model library.** The Pi, Claude, and Codex
  executors are packages.
- **Speech enters the record through `say` only**, on every executor.
- **Shared summaries.** Humans and agents continue from the same recorded
  summary; the source stays in the journal
  ([summary contract](../docs/summary.md)).
- **Two release channels.** CI publishes a dev build of `main` to GitHub
  Packages under `dev`. The owner stages, verifies, and promotes an official
  release on npmjs from a local machine with `scripts/release.mjs`.
- **Delegation has no task database.** A working room is a room, and a ref
  connects the two ([backlog](backlog.md)).

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

**Two lanes run at once.** A step names the steps it needs; a step with no
"Needs" line starts now. **P0** blocks the tag. **P1** carries the release
story. **P2** can land last.

| Lane | Chain                                 | Priority |
| ---- | ------------------------------------- | -------- |
| A    | Phase 1: 1 to 4, then phase 2: 1 to 4 | P0       |
| B    | Phase 3: 1 to 3 now; 4 after phase 1  | P1       |

**The critical path is the notice, then the timer.**

### Phase 1. Wake sources (P0)

**Goal:** a room wakes from an event and not only from a person.

- [ ] **1.** A notice from a resource: a message kind with a ref, no author,
      and routing by attention. (W)
- [ ] **2.** Restart semantics of a notice: a durable start, and no hidden
      timeout. Needs 1. (W)
- [ ] **3.** A timer in the host that expires an `awaiting` exchange and
      wakes a seat on a clock. Needs 2. (W)
- [ ] **4.** Scheduler ingress: a host call that delivers a notice on a
      schedule the application owns. Needs 3. (W)

**Evidence:** a scripted test and a chaos case for each step; the Cloudflare
adapter runs a timer through its alarm.

### Phase 2. Delegation by reference (P1)

**Goal:** one room hands work to another and gets one answer back.

- [ ] **1.** The working-room ref and the delegating message. Needs phase 1
      step 1. (D)
- [ ] **2.** The `awaiting` outcome for the origin exchange, and the return
      message with a ref. Needs 1. (D)
- [ ] **3.** A read of the status of the delegated work through the
      exchange the ref opened. Needs 2. (D)
- [ ] **4.** Retire PR #151 with a note that names the new route. (D)

**Evidence:** the workbench delegates one question to a second room; a
restart in the middle keeps the work.

### Phase 3. Release and hygiene (P1)

**Goal:** the next release repeats without the owner's machine.

- [ ] **1.** The dev build stamp follows the next release: derive the base
      from the tag or the plan. (R)
- [ ] **2.** An npmjs release that a trusted CI workflow runs with
      provenance. The 0.1.0 release ran on the owner's machine. Needs 1. (R)
- [ ] **3.** A generated API reference per entry with a CI staleness check.
      P2. (R)
- [ ] **4.** The bounded projection with a checkpoint entry, behind the
      format rule of the compatibility note. Needs phase 1. (S)

**Evidence:** a release from CI installs without a token; the reference
builds in CI; a resume from a checkpoint equals a full replay on every
golden journal.

## The items

Each item states the problem, the solution, and the impact.

### W. Wake sources

**W1. A notice from a resource.** A room wakes only when a person speaks.
Add a message kind with a ref, no author, and routing by attention, so an
agent wakes when a brief changes or a run completes. It needs a durable
start and restart semantics, and it must not arrive through a hidden
timeout.

**W2. Timers and scheduler ingress.** The room stays available between
interactions, and nothing wakes it on a clock. A host timer expires an
`awaiting` exchange and wakes a seat. The host owns the clock, and the
journal records the start.

### D. Delegation

**D1. Delegation by reference.** PR #151 stored tasks in the journal and
kept a scan of every task on each reconcile pass. Use references and the
`awaiting` outcome instead: the delegating message carries a ref to
`ambion://room/<working>/message/<from>`, and the working room closes with
one message that carries a ref back. Status is a read of the exchange that
the referenced message opened.

### S. Scale

**S1. A bounded projection.** The incremental fold keeps full replay as
the reference. A checkpoint entry lets a resume skip settled history. It is
a format change, so it needs a new golden journal and the review that the
compatibility note names.

### R. Release and hygiene

**R1. A repeatable release.** The 0.1.0 release ran from one machine with a
passkey and a token. A trusted workflow with `id-token: write` publishes
with provenance and needs no token on a laptop.

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
