# Next: the scope for 0.3.0

> **No compatibility promise before 1.0.0.** 0.2.0 shipped on 2026-09-24
> from commit 10a4f44, with eleven packages on npmjs. Until 1.0.0, any
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

This file holds the open work for 0.3.0: the scope, the order of the work,
the evidence each step needs, and the reason for each item. What landed
leaves the phases, and the [changelog](../CHANGELOG.md) records it.
[backlog.md](backlog.md) holds everything after 0.3.0.

**An item lands with its evidence or stays open.** Every checkbox names an
item in [the items](#the-items). A phase closes when its evidence line
holds on main.

## Positioning

**Ambion is a collaboration kernel for agents and humans.** The
[README](../README.md) holds the statement, and
[Technical facts](../docs/technical-facts.md) holds the key facts and what
is new. Through 0.2.0, Ambion is reactive: a seat acts when a person
speaks, or when a seat addresses it.

**0.3.0 makes Ambion responsive to environment events.** An environment
event is a change outside the room, such as a push to a repository, a job
that ends, or a timer that comes due. In 0.3.0, an environment event
reaches the room as a notice, and the room wakes the seats that attend to
it. A room also hands work to another room and waits for the result. A
seat's shell work runs as a background process between its activations.

**0.3.0 also gives each deployment shape one package.** The local shape
is one node that runs the host and every agent:
`@ambionframework/just-bash`, with the git backend of 0.2.0 in its `./git`
entry. The lab shape is a host on one machine and a workstation on
another: `@ambionframework/workstation`, with a git backend that keeps the
repositories in one account on the server. Each agent reaches them with
`git` over SSH.

## The scope

**Five themes, each with the acceptance it must meet on the tagged
commit.** The phases below deliver them; the items explain them.

| Theme                     | Acceptance                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W Wake sources            | A room wakes a seat on a notice from a resource and on a timer that the journal records. A restart re-arms every timer. An `awaiting` exchange expires on a stated bound.                                                                                                                                                                                                                                          |
| D Delegation by reference | A working room is a room. A message that carries a ref to it delegates the work. The origin exchange awaits the working room, and one message with a ref returns the result. No task database.                                                                                                                                                                                                                     |
| G Git on the workstation  | `openWorkspace` refuses a git backend whose transport the bash backend does not carry, and the error names the git backend's transport and server and the bash backend's transports. `workstationGitBackend` passes `gitConformance` on OpenSSH in the `workstation` CI job. No agent pushes outside its namespace, and no agent key works off the server or after `keyTtl`. Landed in #312, #314, #316, and #317. |
| B Background processes    | `bash` starts a process that outlives its activation. `ps`, `status`, `wait`, and `cancel` reach it, the host sees the processes of this run, the files of the bash backend hold the table, and each activation starts with a reminder of its seat's processes. Landed in #307.                                                                                                                                    |
| E Evals                   | The assistant's live suite runs on `@ambionframework/simulator`. Every claim of its eleven tests holds as a check or a criterion, and three new cases run over several exchanges. [Simulator](../docs/simulator.md) holds the design.                                                                                                                                                                              |

**Three format changes.** Each change lands with a golden journal of the
new shape, and the changelog names each one.

| Change                                  | Item | Kind                       |
| --------------------------------------- | ---- | -------------------------- |
| The notice message kind                 | W1   | A new message union member |
| The timer entry                         | W2   | A new entry kind           |
| An `awaiting` outcome that names a room | D1   | A new outcome union member |

**Deployment models.** The same rules serve four placements.

| Model                         | Placement                         | Persistence               | Support                                                            |
| ----------------------------- | --------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| Embedded Node application     | Room and executors in one process | In-memory journals        | Supported for development, tests, and ephemeral lifetimes          |
| Persistent Node service       | An application-managed service    | SQLite journals           | Supported; the workbench example is the reference host             |
| Separate room and agent hosts | Calls cross the JSON protocol     | Each host chooses storage | Extension contract with a published conformance suite              |
| Cloudflare Durable Objects    | One object per room, one per seat | Each object's SQLite      | Publishable adapter tested in workerd; deployment commands pending |

## Out of scope

**These wait in the [backlog](backlog.md).** The backlog states the
condition that brings each one back.

- **The checkpoint entry.** The W2 resume measurement decides it.
- **The conformance fixtures (M5) and the billing annotation (L3).** Both
  carry over from 0.2.0 with a condition each.
- **A repeatable release from CI (R1).** The owner runs the release.
- **A generated API reference.** It adds a build step and a CI check, and
  the typed README examples already hold the surface.
- **The open proofs.** The stop-loop and pass measures, unique roster
  names, `seatLive`, and `storedIdAccepted` remove no defect today.
- **A backend profile and concurrent operations.** A profile that lets the
  workspace owner run two agents at once changes the owner, so it waits
  for a measured need.
- **A SQL backend over a database server.** The workstation uses
  `sqliteBackend` on the Ambion host.
- **An `apply_patch` tool for Codex seats.** A live comparison with the
  `edit` tool decides it.

## Decisions taken

- **A notice is the scheduler ingress.** The application owns its
  schedule and delivers a notice through one host call. The kernel adds no
  scheduler.
- **The journal records a timer, and the host runs it.** The host owns the
  clock. A restart reads the timer entries and arms them again.
- **Delegation has no task database.** A working room is a room, and a ref
  connects the two.
- **W2 decides `exchangeOutcome`.** If the `awaiting` expiry writes on the
  `awaiting` outcome, the rule gates a write and stays verified. Otherwise
  it leaves the rules file, as the 0.2.0 sweep states for read views.
- **One example.** The agentic lab workspace in
  [docs/example.md](../docs/example.md) stays the one example.
- **Two entries.** `@ambionframework/ambion` for applications and
  `@ambionframework/ambion/hosting` for hosts and adapters.
- **The kernel imports no model library.** The Pi, Claude, and Codex
  executors are packages, and each one adapts a harness.
- **Speech enters the record through `say` only**, on every executor.
- **Two release channels.** CI publishes a dev build of `main` to GitHub
  Packages under `dev`. An official release goes to npmjs from the
  owner's machine.
- **One package for each deployment shape.** `@ambionframework/just-bash`
  holds the local pair, and `@ambionframework/workstation` holds the lab
  pair. The core names a git transport and holds the refusal. Each access
  type lives with its pair.
- **The git backend on the workstation takes the defaults of its
  design.** [Workstation git](../docs/workstation-git.md#decisions-taken)
  lists them: a key file in the agent's home, a second authorized-keys
  file, the template helpers in `@ambionframework/workspace/git`, the git
  account on the loopback address, and the transport names `in-process`
  and `ssh`.
- **The live tier stays off pull requests.** A step that changes a
  harness path proves it with one live file on that harness before it
  merges. The CI run on `main` confirms it.

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

## The order of work

**The order is the notice, the timer, then the delegation.** The notice
host call needs the notice kind, the timer needs the host call, and the
delegating message needs the notice. The git backend on the workstation
needed none of them, and phase 4 landed it beside phases 1 to 3.
Background processes (B1) needed no phase, and landed first. The
simulator (phase 5) needs no other phase. A step names the
steps it needs; a step with no "Needs" line starts now. **P0** blocks the tag. **P1**
carries the release story. **P2** moves to the backlog when it is late.

### Phase 1. The notice (P1)

**Goal:** an event outside the room wakes the seats that attend to it.

- [ ] **1.** The notice message kind, its routing by attention, and the
      host call that delivers it with a stable key. P1. (W1)

**Evidence:** a scripted test and a chaos case for the kind and for the
host call, with its durable start and its restart semantics.

### Phase 2. The timer (P1)

**Goal:** a clock wakes a room, and a restart loses no timer.

- [ ] **1.** The timer entry, armed by the host and armed again after a
      restart. Needs phase 1 step 1. P1. (W2)
- [ ] **2.** The `awaiting` expiry as a timer that the close schedules,
      and the decision on `exchangeOutcome`. Needs 1. P1. (W2)
- [ ] **3.** The Cloudflare adapter runs a timer through its alarm, and a
      measurement records the resume cost of a room with many timer
      wakes. Needs 1. P1. (W2)

**Evidence:** a kill between the timer entry and the wake keeps the wake;
the docs that call timers future work say what shipped.

### Phase 3. Delegation (P1)

**Goal:** a room hands work to another room and waits for the result.

- [ ] **1.** A delegating message with a ref to a working room, the
      `awaiting` outcome that names the room, and the message that returns
      the result. Needs phase 1 step 1. P1. (D1)

**Evidence:** the workbench delegates one question to a second room; a
restart in the middle keeps the work. PR #151 closes with a comment that
names the new route.

### Phase 4. Git on the workstation (P1)

**Goal:** an agent on a workstation clones and pushes over SSH to one
account on its own server, and the host opens no port.

**Phase 4 holds no open step.** G1 landed in #312 and #314. G2 landed in
#316 and #317, and its docs landed after them.

**Evidence:** the `workstation` CI job runs `gitConformance` on OpenSSH
with the SSH harness, and the tier proves the checks that
[Workstation git](../docs/workstation-git.md#tests) lists. The workbench
runs on `justGitBackend`. The evidence holds on `main`.

### Phase 5. The simulator (P1)

**Goal:** an eval drives a room as a person, checks the run in code, and
asks a judge for the rest.

- [x] **1.** `runAgent` in `@ambionframework/pi`: one agent run outside a
      room, until the agent calls a tool that ends it. P1. (E1) Landed in
      #319.
- [x] **2.** `@ambionframework/simulator` with `simulate` and
      `scriptedActor`, proven on the scripted tier. P1. (E1) Landed in
      #324.
- [x] **3.** `agentActor`, `agentJudge`, and their tools `send`, `stop`,
      and `grade`, with one live case. Needs 1 and 2. P1. (E1) Landed in
      #326.
- [ ] **4.** The assistant's live suite on the simulator. Needs 3. P1.
      (E1)

**Evidence:** each step states its cases in
[Simulator](../docs/simulator.md#the-order-of-work). The last step keeps
every claim of the assistant's live suite, and one live run of the file
prints the cost of each case.

### Phase 6. Release (P1)

**Goal:** the tag names a commit that a live run tested.

- [ ] **1.** The changelog entry for 0.3.0 names each format change and
      each export that changed. Needs phases 1 to 5. P1. (R0)
- [ ] **2.** The live run on `main` after the last merge passes for Pi,
      Claude, and Codex. Needs 1. P1. (R0)

**Evidence:** the notes of the GitHub release link the live run on the
tagged commit and name any case that failed.

## The items

Each item states the problem, the solution, and the impact.

### W. Wake sources

**W1. A notice from a resource.** A room wakes only when a person speaks,
so an agent cannot react when a brief changes or a run completes. Add a
message kind with a ref and no author, routed by attention. One host call
delivers it with a stable key, so a retried delivery lands once. An
application scheduler calls the same host call, so the kernel needs no
scheduler of its own. A notice opens no exchange by itself and arrives
through no hidden timeout. **Evidence:** a scripted test and a chaos case
for the kind and for the host call, with its durable start and its restart
semantics.

**W2. A timer that the journal records.** Nothing wakes a room on a clock,
and an `awaiting` exchange waits for ever. A timer entry records the due
time and the wake it owes. The host arms it and writes the wake when it is
due. A restart reads the open timer entries and arms them again, so a
crash loses no timer. The `awaiting` expiry is a timer that the close
schedules. The Cloudflare adapter runs a timer through its alarm, and a
measurement records the resume cost of a room with many timer wakes.
**Evidence:** a kill between the timer entry and the wake keeps the wake;
the docs that call timers future work say what shipped.

### D. Delegation by reference

**D1. Delegation by reference.** PR #151 stored tasks in the journal and
scanned every task on each reconcile pass. Use a ref and the `awaiting`
outcome. The delegating message carries a ref to
`ambion://room/<working>/message/<from>`. The origin exchange closes as
`awaiting` that room. The working room closes with one message that
carries a ref back. Status is a read of the exchange that the referenced
message opened. **Evidence:** the workbench delegates one question to a
second room; a restart in the middle keeps the work. Then close PR #151
with a comment that names the new route.

### G. Git on the workstation

**G1. The git backend in the host's process joins just-bash, and it pairs
with just-bash alone.** `gitBackend` defaults to
`http://git.ambion.invalid`, which never resolves. Beside a workstation,
`connect` succeeds, and the first `git clone` of an agent fails on DNS in
the middle of an activation. A host that serves `handler` to fix it opens
an inbound port and sends each token over HTTP.

- **One package holds the local shape.** `@ambionframework/just-bash/git`
  exports `justGitBackend` and `sqliteGitStorage`. The package already
  depends on the `just-git` library. `@ambionframework/git` goes.
- **The root entry of just-bash loads no `node:sqlite`.** A Biome
  override lets `packages/just-bash/src/git/` alone import `node:sqlite`
  and `@ambionframework/workspace/git`. The root entry reads the git
  access through an `import type` alone, and a test of the built chunks
  holds the rule.
- **The backend serves the process it runs in.** `handler` and the `url`
  option go. The clone URLs keep the base `http://git.ambion.invalid`.
- **The template helpers and the name rules move to
  `@ambionframework/workspace/git`.** The workstation needs them and must
  not install `just-git`. `tipHashes` reads `just-git/repo`, so it stays
  in just-bash.
- **The core knows a transport by its name.** `GitAccess` in
  `@ambionframework/workspace` holds `transport` alone. `JustGitAccess` in
  `@ambionframework/just-bash/git` adds `prefix`, `fetch`, and
  `credentialFor` for `in-process`. `credentialsFor` goes, since no
  client reads a credential file.
- **`gitConformance` stays blind to transports.** The four cases that
  touch a credential call hooks of the harness, and the package of each
  pair implements them. The suite names the life of a credential in
  credential terms: `credentialTtl` and `shortestCredentialTtl`.
- **A bash backend declares its transports, and `openWorkspace` checks
  them.** `BashBackend.gitTransports` lists them. The just-bash backends
  and the test helper of the workspace carry `in-process`. The
  workstation carries none until G2. A pair that does not match throws
  when the workspace opens. Neither backend has a name, so the error
  names the `transport` and the `server` of the git backend, and the
  transports that the bash backend carries.
- **The workstation's HTTP path goes.** `git-credentials.ts`, its tests,
  and the git case of the OpenSSH tier go with it.

G1 landed in two steps. G1a (#312) moved the code and kept the shape of
`GitAccess`. G1b (#314) changed the contract. The owner deprecates
`@ambionframework/git` on npmjs with a message that names
`@ambionframework/just-bash/git`. **Evidence:** a scripted case that
pairs `justGitBackend` with a bash backend that carries `ssh` or no
transport and gets the error, `gitConformance` on the just-bash backends
under the new names, and a root chunk of just-bash without `node:sqlite`.

**G2. A git backend on the workstation.** After G1, a workstation has no
git backend. [Workstation git](../docs/workstation-git.md) designs one in
`@ambionframework/workstation`. One account on the server owns every
repository, and each agent reaches it with `git` over SSH on the loopback
address. A forced command decides each request by the namespace rule. The
backend issues one Ed25519 key for each agent, limited by `from` and
`expiry-time`. The key generator retries a pair that `ssh2` cannot read.
A fork or a template lands with one rename, so the backend keeps no
registry table.

G2 landed in two steps. G2a (#316) built the server side, and its tests drive
the git backend alone. G2b (#317) made the bash backend write the key files,
and it added the OpenSSH tier. Only the `workstation` CI job runs that
tier, so a step of G2 merged only with that job green. The OpenSSH
harness removes the repositories and the agent keys of the git account
between cases. **Evidence:** `gitConformance` and the checks of the
design pass in the OpenSSH tier. The backend renders `expiry-time` in the
server's time zone, from the server's clock, since the `Z` suffix for UTC
needs OpenSSH 9.1.

### B. Background processes

**B1. A shell command in the background.** Pi's `bash` tool held the bash
owner until the command ended, and stopped it after 30 seconds, so a
build or a test run held every other tool call of the workspace. `bash`
now starts a process that runs off the owner, with its output in a file,
and gives a handle. `ps`, `status`, `wait`, and `cancel` reach it, the
host sees the processes of this run through `workspace.processes`, and
each activation starts with a reminder of the seat's processes
([Processes](../docs/processes.md)). The files of the bash backend hold
the table, so a new run of the host adopts the live processes of an
earlier run. A process has no link to an exchange yet; the backlog holds
that design. **Evidence:** `packages/workspace/test/processes.test.ts`,
the Pi continuity test of the reminder, and the timeout, cancel, and
adoption on OpenSSH. Landed in #307.

### E. Evals

**E1. A simulator for evals.** A live test sends one fixed question and
matches the answer with a regex. It cannot follow up on an answer, and
a regex cannot grade a meaning. PR #153 tried a larger package and stays
a draft. `@ambionframework/simulator` runs a loop of one exchange at a
time. An actor plays a person, checks in code read the run, and a judge
grades the criteria that code cannot decide. The actor and the judge are
agents on Pi's `AgentHarness`, configured with tools and bundles like any
agent. **Evidence:** the assistant's live suite runs on the simulator.
Then close PR #153 with a comment that names the new package.

### R. Release

**R0. The release.** The owner tags the commit and runs
`scripts/release.mjs`, as [Toolchain](../docs/toolchain.md#9-release-and-publishing)
describes. The changelog entry states the end state once, and the live
run on the tagged commit is the evidence.
