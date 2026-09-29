# Next: the scope for 0.4.0

> **No compatibility promise before 1.0.0.** 0.3.0 shipped on 2026-09-25
> from commit 2eb30a3, with eleven packages on npmjs. Until 1.0.0, any
> release may change any export, entry point, journal body, stored format,
> or package API.
>
> - **A change carries no compatibility path.** Add no re-export, no
>   deprecated alias, no reader for an older format, no upgrade step, and
>   no compatibility test.
> - **The changelog names each change** to an export, a journal body, or a
>   stored format.
> - **The guards pin the current surface.** The export snapshot
>   (`test/package.test.ts`), the golden journals (`test/golden.test.ts`),
>   and body validation (`test/journal-validation.test.ts`) catch a change
>   that nobody intended. A deliberate change updates them in the same
>   commit.

This file holds the open work for 0.4.0 and the decisions that shape it.
What landed leaves this file, and the [changelog](../CHANGELOG.md) records
it. [backlog.md](backlog.md) holds everything after 0.4.0, in the order of
its priority.

## Status

**0.4.0 is ready to release.** Every item of the plan merged by
2026-09-29, from #347 to #372. The [changelog](../CHANGELOG.md#040-2026-09-29)
holds the entry: each export and each journal body that changed, and each
concept that had two paths and has one.

## Positioning

**Ambion is a collaboration kernel for agents and humans.** The
[README](../README.md) holds the statement, and
[Technical facts](../docs/technical-facts.md) holds the key facts and what
is new.

**0.4.0 is a release of simplification.** It adds four capabilities. They
are the `import` of the `sql` tool, the fixed skills of each agent, the
refs to workspace files and commits, and the post of the host. It removes
each second path to a fact of the room.

## The scope

**The journal holds five facts, and one projection reads them.** The facts
are messages, lease changes, closes, cancellations, and compositions. A
`run` entry fences each run. One pure `decide` admits one entry for each
command inside the journal queue, and the reconcile runs `decide` until
nothing changes.

**Acceptance.** Each fact of the room has one derivation, each rule one
home, and each seat one boundary. `pnpm check` passes, the coverage of
each changed package holds, and the changelog names each second path that
the release removes.

**Journal bodies.** A cancel entry carries no close, and the room derives
a cancelled close from it. A composition carries no `version`. A body
schema refuses each field that an earlier release wrote and that this
runtime would misread. The journal carries no format number. Ambion
supports no downgrade.

**Deployment models.** The same rules serve four placements.

| Model                         | Placement                         | Persistence               | Support                                                            |
| ----------------------------- | --------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| Embedded Node application     | Room and executors in one process | In-memory journals        | Supported for development, tests, and ephemeral lifetimes          |
| Persistent Node service       | An application-managed service    | SQLite journals           | Supported; the workbench example is the reference host             |
| Separate room and agent hosts | Calls cross the JSON protocol     | Each host chooses storage | Extension contract with a published conformance suite              |
| Cloudflare Durable Objects    | One object per room, one per seat | Each object's SQLite      | Publishable adapter tested in workerd; deployment commands pending |

## The open step

- [ ] **The owner releases 0.4.0 to npmjs.** The release commit sets each
      package to 0.4.0 and moves the dev base to 0.5.0. The owner then runs
      the sequence in
      [Release and publishing](../docs/toolchain.md#9-release-and-publishing).

## Decisions taken

- **A process wakes no seat.** The agent waits for its result inside the
  activation, and a wait stops before the room ends the activation. A host
  that wants a wake calls `room.post`
  ([Processes](../docs/processes.md#the-end-of-a-process)).
- **A scheduled say goes to its author alone.** The `schedule` tool sets
  `to` to the author and `after` to its argument. On the record, `to` names
  the author if and only if `after` is set. The room stamps the author and
  the returned say. No seat speaks under the name of a person, and no seat
  schedules work for another seat.
- **The system speaks, and an exchange has no owner.** The host and the
  room's clock write a `posted` entry with no author, and a returned say is
  a post with `returns`. A post opens an exchange when none is open.
  Otherwise it joins the open exchange and steers its target, or each seat
  at work when it has no target. An exchange has an opening message and a
  `person`, the first person who spoke in its range.
  [Exchange](../docs/exchange.md#4-who-directs-one-and-who-receives-its-result)
  holds the rules.
- **The journal records the schedule, and the host arms the clock.** The
  fold holds the pending says, and the room's alarm takes the earliest due
  time beside the lease expiries and the retry times. A restart reads the
  pending says from the journal.
- **The `assistant` room option stays.** It is shorthand for `agents`,
  `summary`, and `broadcast` attention.
- **These pairs stay.**
  - **`pi()` and `piExecution()`.** The first is definition data that
    crosses the wire. The second holds host functions and paths.
  - **The two stop mechanisms of a process.** A process of this run stops
    by an abort, since just-bash has no pid. An adopted process stops by
    its pid.
  - **The step mapping of each harness.** Each harness has its own wire
    format.
  - **The view interfaces of the room host.** `RoomBase`, `ControlHost`,
    `DispatchHost`, `PeopleHost`, and `WaitsHost` keep `control.ts`,
    `dispatch.ts`, `people.ts`, and `waits.ts` below `room-host/room.ts`
    in the layers that Biome holds.
- **One example.** The agentic lab workspace in
  [docs/example.md](../docs/example.md) stays the one example.
- **Two entries.** `@ambionframework/ambion` for applications and
  `@ambionframework/ambion/hosting` for hosts and adapters.
- **The kernel imports no model library.** The Pi, Claude, and Codex
  executors are packages, and each one adapts a harness.
- **Speech enters the record through `say` only**, on every executor.
- **Two release channels.** CI publishes a dev build of `main` to GitHub
  Packages under `dev`. An official release goes to npmjs from the owner's
  machine.
- **One package for each deployment shape.** `@ambionframework/just-bash`
  holds the local pair, and `@ambionframework/workstation` holds the lab
  pair. The core names a git transport and holds the refusal. Each access
  type lives with its pair.
- **The git backend on the workstation takes the defaults of its
  design.** [Workstation git](../docs/workstation-git.md#decisions-taken)
  lists them.

## The model to preserve

| Concern                                                       | Owner                 | Rule                                                                                                  |
| ------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| Definitions, executors, tools                                 | Application code      | Fixed per room run; no executable code in the journal                                                 |
| Membership, presence, messages, exchanges, claims, references | Room journal          | Pure interpretation of confirmed entries                                                              |
| Model loops, harness sessions, activation steps               | Executor              | One harness session for each seat in each exchange, a cache; steps to the trace; speech through `say` |
| Files, tables, instruments, and their change logs             | Application resources | Independent of journal transactions; stamped with provenance                                          |
| Timers, runners, subscriptions, live handles, trace logs      | Host                  | Armed again from the journal after restart; the trace logger changes no outcome                       |
| Identity selection, discovery, hosting state, delivery outbox | Application           | Explicit entry and stable retry keys                                                                  |

**Judge a change by the obligation it removes.** Fewer exports are useful
when callers need fewer rules. A rename earns its place only when one name
means two things or two names mean one.
