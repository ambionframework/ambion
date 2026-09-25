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
is new. Ambion is reactive: a seat acts when a person speaks, or when a
seat addresses it.

**0.3.0 lets the work of a seat outlive its activation.** A seat's shell
work runs as a background process between its activations. The agent
waits for the result that its answer needs inside the activation, and
nothing wakes a seat when a process ends. A host that wants a wake posts a
message. Wake sources and delegation between rooms wait in the
[backlog](backlog.md#wake-sources-and-delegation).

**0.3.0 also gives each deployment shape one package.** The local shape
is one node that runs the host and every agent:
`@ambionframework/just-bash`, with the git backend of 0.2.0 in its `./git`
entry. The lab shape is a host on one machine and a workstation on
another: `@ambionframework/workstation`, with a git backend that keeps the
repositories in one account on the server. Each agent reaches them with
`git` over SSH.

## The scope

**Three themes, each with the acceptance it must meet on the tagged
commit.** The phases below deliver them; the items explain them.

| Theme                    | Acceptance                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G Git on the workstation | `openWorkspace` refuses a git backend whose transport the bash backend does not carry, and the error names the git backend's transport and server and the bash backend's transports. `workstationGitBackend` passes `gitConformance` on OpenSSH in the `workstation` CI job. No agent pushes outside its namespace, and no agent key works off the server or after `keyTtl`. Landed in #312, #314, #316, and #317. |
| B Background processes   | `bash` starts a process that outlives its activation. `ps`, `status`, `wait`, and `cancel` reach it, the host sees the processes of this run, the files of the bash backend hold the table, and each activation starts with a reminder of its seat's processes. Landed in #307. An agent waits for its result inside the activation, a result gives the new output, and `wait` takes several handles (B2).         |
| E Evals                  | The assistant's live suite runs on `@ambionframework/simulator`. Every claim of its eleven tests holds as a check or a criterion, and three new cases run over several exchanges. [Simulator](../docs/simulator.md) holds the design.                                                                                                                                                                              |

**No journal format change.** The notice kind, the timer entry, and the `awaiting`
outcome that names a room moved to the backlog with W1, W2, and D1.

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

- **Wake sources and delegation (W1, W2, D1).** The notice from a
  resource, the timer that the journal records, and delegation by
  reference moved to the [backlog](backlog.md#wake-sources-and-delegation).
  A process follows the pull model of Codex's unified exec, and a host
  that wants a wake posts a message.
- **The checkpoint entry.** The resume measurement of the backlog's timer
  item decides it.
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

- **A process wakes no seat.** The agent waits for its result inside the
  activation, and a wait stops before the room ends the activation. A host
  that wants a wake posts a message
  ([Processes](../docs/processes.md#the-end-of-a-process)).
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

**Three phases remain, and the git phase holds no open step.** Background
processes (B1 and B2) needed no phase, and the simulator (phase 2) needs
none. The release needs the git and simulator phases. A step names the
steps it needs; a step with no "Needs" line starts now.
**P1** carries the release story.

### Phase 1. Git on the workstation (P1)

**Goal:** an agent on a workstation clones and pushes over SSH to one
account on its own server, and the host opens no port.

**Phase 1 holds no open step.** G1 landed in #312 and #314. G2 landed in
#316 and #317, and its docs landed after them.

**Evidence:** the `workstation` CI job runs `gitConformance` on OpenSSH
with the SSH harness, and the tier proves the checks that
[Workstation git](../docs/workstation-git.md#tests) lists. The workbench
runs on `justGitBackend`. The evidence holds on `main`.

### Phase 2. The simulator (P1)

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
- [x] **4.** The assistant's live suite on the simulator. Needs 3. P1.
      (E1) Landed in #327. The first live run of the file is still open.

**Evidence:** each step states its cases in
[Simulator](../docs/simulator.md#the-order-of-work). The last step keeps
every claim of the assistant's live suite, and one live run of the file
prints the cost of each case.

### Phase 3. Release (P1)

**Goal:** the tag names a commit that a live run tested.

- [ ] **1.** The changelog entry for 0.3.0 names each export that
      changed. Needs phases 1 and 2. P1. (R0)
- [ ] **2.** The live run on `main` after the last merge passes for Pi,
      Claude, and Codex. Needs 1. P1. (R0)

**Evidence:** the notes of the GitHub release link the live run on the
tagged commit and name any case that failed.

## The items

Each item states the problem, the solution, and the impact.

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

**B2. An agent waits for its result inside the activation.** No message
wakes a seat when a process ends, as in Codex's unified exec. A wait
could run past the room's deadline for the activation, each poll resent
the same 50 KB tail, and an agent polled a sweep one process at a time.
`bash` and `wait` now stop 30 seconds before the deadline that
`ToolContext.deadline` carries. Each result gives the new output after a
cursor that the files keep. `wait` takes `handles` and returns at the
first end. The guidance states that nothing pushes, and
[Processes](../docs/processes.md#the-end-of-a-process) shows how a host
posts a message to wake the owner seat. **Evidence:** the deadline tests
in the core and the workspace, the cursor tests on just-bash and on the
workstation, and the test of a wait on several handles. #320, #321, and
#322 carry the code.

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
