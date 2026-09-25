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
is new. Ambion is reactive: a seat acts when a person speaks, when a seat
addresses it, or when a say that it scheduled comes due.

**0.3.0 lets the work of a seat outlive its activation.** A seat's shell
work runs as a background process between its activations. The agent
waits for the result that its answer needs inside the activation, and
nothing wakes a seat when a process ends. A host that wants a wake posts a
message.

**0.3.0 lets an agent come back to its work later.** An agent says to
itself with `after`, and the room delivers the say back to it when it is
due. The delivery opens an exchange for the person who owned the exchange
of the say. An agent checks a long process this way, and the room needs no
event source. The notice and delegation between rooms wait in the
[backlog](backlog.md#wake-sources-and-delegation).

**0.3.0 also gives each deployment shape one package.** The local shape
is one node that runs the host and every agent:
`@ambionframework/just-bash`, with the git backend of 0.2.0 in its `./git`
entry. The lab shape is a host on one machine and a workstation on
another: `@ambionframework/workstation`, with a git backend that keeps the
repositories in one account on the server. Each agent reaches them with
`git` over SSH.

## The scope

**Four themes, each with the acceptance it must meet on the tagged
commit.** The phases below deliver them; the items explain them.

| Theme                    | Acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G Git on the workstation | `openWorkspace` refuses a git backend whose transport the bash backend does not carry, and the error names the git backend's transport and server and the bash backend's transports. `workstationGitBackend` passes `gitConformance` on OpenSSH in the `workstation` CI job. No agent pushes outside its namespace, and no agent key works off the server or after `keyTtl`. Landed in #312, #314, #316, and #317.                                  |
| B Background processes   | `bash` starts a process that outlives its activation. `ps`, `status`, `wait`, and `cancel` reach it, the host sees the processes of this run, the files of the bash backend hold the table, and each activation starts with a reminder of its seat's processes. Landed in #307. An agent waits for its result inside the activation, a result gives the new output, and `wait` takes several handles (B2).                                          |
| E Evals                  | The assistant's live suite runs on `@ambionframework/simulator`, with three cases over several exchanges and five cases of the assistant's purpose. It must pass on two model families at `medium` thinking, each graded by the other. [Simulator](../docs/simulator.md) holds the design.                                                                                                                                                          |
| S A scheduled say        | An agent says to itself with `after`, and the room refuses every other use of `after` and every other say to oneself. The room writes a `returned` entry when the say is due, and the entry wakes the seat. The returned entry opens an exchange for the owner of the exchange of the say when no exchange is open. A kill between the say and the returned entry keeps one delivery, and the Cloudflare room object delivers it through its alarm. |

**One journal format change.** A said entry takes `after`, and the
`returned` message kind is new (S1). The notice kind and the `awaiting` outcome that
names a room stay in the backlog with W1 and D1.

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

- **The notice and delegation (W1, D1).** The notice from a resource and
  delegation by reference stay in the
  [backlog](backlog.md#wake-sources-and-delegation). A process follows the
  pull model of Codex's unified exec, and a host that wants a wake posts a
  message.
- **A scheduled say that waits on a process.** A returned say wakes the seat
  on the clock alone. A guard that holds a say while its process runs is
  an optimization, and it waits in the
  [backlog](backlog.md#wake-sources-and-delegation).
- **The checkpoint entry.** The resume measurement of S1 decides it.
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
- **A scheduled say goes to its author alone.** `to` names the author if
  and only if `after` is set. The room stamps everything else: the author,
  the returned entry, and the owner of the exchange that it opens.
  No seat speaks under the name of a person, and no seat schedules work
  for another seat.
- **A returned entry is an ordinary message when it lands.** It opens an
  exchange when none is open. When an exchange is open, it joins it and
  steers work, and the owner of that exchange stays the owner.
- **The journal records the schedule, and the host arms the clock.** The
  fold holds the pending says, and the room's alarm takes the earliest due
  time beside the lease expiries and the retry times. A restart reads the
  pending says from the journal.
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

**Four phases remain, and the git and simulator phases hold no open
step.** Background processes (B1 and B2) needed no phase. The release needs
the git, simulator, and scheduled say phases. A step names the steps it
needs; a step with no "Needs" line starts now. **P1** carries the release
story.

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
      (E1) Landed in #327.
- [x] **5.** The assistant held to its purpose: passive at `broadcast`,
      membership and summaries, an answer when a participant addresses it. Five
      purpose cases, a thinking level for Pi seats, and the suite passes on
      `anthropic/claude-sonnet-5` and `openai/gpt-5.6-luna` at `medium`,
      each graded by the other. Needs 4. P1. (E1) Landed in #331.

**The results of step 5.** Each cell counts the passing cases, with one
sample for each case. Each model is graded by the other family.

| Guidance                                          | Sonnet 5, `medium` | Luna 5.6, `medium` |
| ------------------------------------------------- | ------------------ | ------------------ |
| Before the change, 18 cases                       | 13                 | 12                 |
| Membership first                                  | 16                 | 16                 |
| Each reaction at `broadcast` named                | 17                 | 18                 |
| A constraint stays until withdrawn                | 17                 | 18                 |
| The rule for each specialist, and its questions   | 17                 | 17                 |
| A specialist that addresses the assistant, 19     | 19                 | 18                 |
| No redirect of a specialist that cannot do work   | 17 (a)             | 18 (a)             |
| The specialists read only the words of the person | 19                 | 19                 |

(a) Two scripted specialists read the words of the assistant. The last row
fixes the scripts, and it runs the same guidance.

**Evidence:** each step states its cases in
[Simulator](../docs/simulator.md#the-order-of-work). The last step keeps
every claim of the assistant's live suite, and one live run of the file
prints the cost of each case.

### Phase 3. A scheduled say (P1)

**Goal:** an agent checks a long process later, and no event source and no
host code wake it.

- [ ] **1.** The kernel: `after` on `say` and on a said entry, the
      `returned` kind, the rule that opens an exchange, the commit path,
      the fold, and the write in the reconcile. P1. (S1)
- [ ] **2.** The read surface: the render of a scheduled say and a
      returned entry, the pending says in a read, and the workbench.
      Needs 1. P1. (S2)
- [ ] **3.** The guidance and the docs. Needs 2. P1. (S3)

**Evidence:** the tests and the golden journal that S1 names hold on
`main`, and the docs that call timers future work state what shipped.

### Phase 4. Release (P1)

**Goal:** the tag names a commit that a live run tested.

- [ ] **1.** The changelog entry for 0.3.0 names each export that
      changed. Needs phases 1, 2, and 3. P1. (R0)
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

### S. A scheduled say

**S1. The room delivers a say back to its author.** A room wakes a seat
only when a person speaks or a seat addresses it. An agent that starts a
build of three hours can wait 570 seconds inside one activation, and then
it must end. Nothing brings it back unless a person speaks or a host posts
a message. The backlog's timer (W2) needed a notice kind and a host call
first.

- **A say to oneself with `after` schedules the say.** The room refuses a
  say to oneself today (`addressRefusal` in `room/transition.ts`), so the
  pair has no earlier meaning. `say` takes `after` in seconds from the
  `at` that the room stamps, so a replay computes the same due time on any
  clock.
- **The room decides who may schedule.** The commit path takes a
  response activation while an exchange is open. A summarize activation
  and an activation outside every exchange get a refusal.
  `limits.schedule` bounds `after` and the pending says of one seat. A
  retry of the same key with another `after` is a conflict.
- **The said entry is an ordinary message.** It lands in the range of the
  exchange that its activation serves. The room stamps the owner of that
  exchange on it, so the fold and the projection read the owner from one
  field. Routing skips its author, so it wakes nobody.
- **The `returned` entry records the moment.** The reconcile writes
  `returned { to, message, owner, text, refs }` when the say is due. The
  room writes it, so it has no `from`. It copies the text and the refs of
  the say, so a record window, a summary, and a steer carry them. It
  stores `owner`, so `opensExchange` in `room/rules.verified.ts` stays a
  check of one entry. The entry wakes the seat that `to` names and steers
  no other seat. The name `due` already means an activation that the room
  owes.
- **A returned entry opens an exchange like a question.** `opensExchange`
  and its proofs accept it, and the projection, `room.exchange`, and the
  routing read it. The reconcile writes it after a close of the same pass,
  so it lands after the close. A harness session never crosses an
  exchange, so the returned activation starts a fresh session. The
  process reminder carries the state of the work.
- **A pending say is not live work.** The origin exchange closes while the
  say waits. An unseating of the author drops its says, and a cancel drops
  the says before it. A recomposition that leaves the author out writes no
  unseating, so its says wait until the seat is on the roster again.
- **A say returns after every ending of its pass.** A pass that ends a
  lease writes no returned entry, so the entry lands after the close, and
  the record is the same whether the host crashed.
- **The reconcile decides each write again.** The write decides inside the
  journal queue, and it writes nothing when the fold holds the entry
  already. The fence refuses a second run. `nextAlarm` takes the earliest
  due time, and the Cloudflare room object's alarm follows it with no new
  code.

**Evidence:** scripted tests of each refusal and of each path through the
reconcile on an injected clock; a golden journal of a say, the close of
its exchange, the returned entry, and the exchange that it opens; a crash
and a stop between the say and the returned entry, on memory and on
SQLite, that find one returned entry after the resume; the Cloudflare room
object returns a say in workerd;
the rules pass `pnpm check:lemmascript`.

**S2. The agent and the person see the schedule.** The say result names
the due time. The render shows a scheduled say with its due time, and a
returned entry with its text and refs, the due time, and the time it
landed. A read lists the pending says, and the workbench shows each one
until it returns. **Evidence:** the render tests, the prompt snapshot, the
executor conformance on Pi, Claude, and Codex, and a read test of the
pending says.

**S3. The guidance and the docs state the scheduled say.** The process
guidance tells an agent to say to itself with `after` to check a long
process later. [Exchange](../docs/exchange.md) states that a returned
entry opens an exchange, and [Trust](../docs/trust.md),
[Processes](../docs/processes.md), [Presence](../docs/presence.md),
[Durability](../docs/durability.md), the README, and the changelog state
what shipped. **Evidence:** the doc tests pass, and no page calls a timer
future work.

### R. Release

**R0. The release.** The owner tags the commit and runs
`scripts/release.mjs`, as [Toolchain](../docs/toolchain.md#9-release-and-publishing)
describes. The changelog entry states the end state once, and the live
run on the tagged commit is the evidence.
