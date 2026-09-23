# Backlog: after 0.2.0

Everything that is not in [next.md](next.md). The first section is the
scope for 0.3.0, and the second is the scope for 0.4.0. Every other item
names the condition that brings it into a release. Nothing here blocks the 0.2.0 tag.

## 0.3.0: jobs and guards

**0.3.0 lets an exchange carry work that outlasts an activation.** An agent
writes a program to the workspace, a sandbox runs it, and the exchange
waits for it through a guard ([docs/job.md](../docs/job.md)). A pipeline
of dependent jobs runs inside the same exchange. After the 0.2.0 tag, this
section moves into [next.md](next.md) with phases, steps, and evidence.

| Theme    | Acceptance                                                                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G Guards | An exchange waits for outside work through a guard that an agent adds. A model-free check activation evaluates it. Every guard ends: it passes, a `cancel` removes it, or it ends as unmet at its deadline, its attention cap, or with no seat to check it. A restart loses no guard.                |
| J Jobs   | An agent submits a program by its workspace path. A `jobs` workspace backend runs it once in a Deno sandbox that reads only its snapshot. The program reaches the world only through bindings. A pipeline sequences dependent jobs with `after`, and an open pipeline wakes the agent between steps. |

**Five format changes.** Each change lands with a golden journal of the
new shape, and the changelog names each one. Together they raise the
room's journal format to 2.

| Change                                           | Item | Kind                       |
| ------------------------------------------------ | ---- | -------------------------- |
| The `guard` entry: added, checked, moved, ended  | G2   | A new entry kind           |
| The `check` activation source and its id grammar | G2   | A new activation source    |
| The `verdict` message for an `act` verdict       | G2   | A new message union member |
| The `unmet` exchange outcome                     | G3   | A new outcome union member |
| The `cancel` entry becomes `abort`               | G2   | A renamed entry kind       |

**The order is the guard contract, the check activation, the close, then
the placements.** The job backend starts beside the guards. It needs the
checkable tool and the handle registry of G2. The workbench sweep needs
both themes.

**Decisions taken for 0.3.0.**

- **A job lives inside the exchange that submits it.** One owner, one
  summary, and one span hold the whole task. Work that returns to a quiet
  room waits for the 0.4.0 notice.
- **The kernel adds no scheduler.** A guard's next check joins the alarm
  that the reconcile pass computes. The host owns the clock.
- **Jobs are a workspace backend kind.** The key is `jobs`, beside `bash`
  and `sql`. The kernel knows guards, checkable tools, and handles, and no
  jobs.
- **The first sandbox is a Deno process on the host that runs the room and
  the workspace.** Each job runs once. A restart ends every job that ran as
  `lost`.
- **One `cancel` tool for every handle.** A tool bundle registers the
  handle kinds that it issues. The journal's `cancel` entry becomes
  `abort`, so the word has one meaning.
- **A guard outlives its seat.** The pass writes the new checker to the
  record, and an `act` verdict then wakes seats by attention.
- **A later message makes every `pass` stale.**

**G1. The guard contract.** [docs/job.md](../docs/job.md) §10 states each
point of the two reviews: the check id and grant, the check executor, the
verdict message, due checks, the ends, freshness, the nudge, and handles.
A third review confirms them before any code. `guard` becomes a room term,
so its other uses in `formal.md`, `trust.md`, `codex.md`, `toolchain.md`,
and the README change words. **Evidence:** the review finds no blocking
issue.

**G2. The guard entry and the check activation.** The room writes the
four `guard` entries and the `verdict` message. The new message kind
reaches `validate.ts`, `routing.ts`, `render.ts`, `room/projection.ts`,
and the workspace mirror. `AmbionTool` gains `check`, and `ToolBundle`
gains `handles`. `refs.ts` accepts guard, job, and pipeline handles. The
`cancel` entry becomes `abort`. **Evidence:** a golden journal of format 2;
`pnpm rule:check` on the rules file; a scripted test of each entry.

**G3. The close admission and the guard's end.** `exchangeLive` counts a
pending guard, and `admitsClose` needs a fresh `pass` from every guard.
The pass computes due checks, writes `guard moved`, and writes
`guard ended` at the deadline, at the cap, and with no checker. The
exchange view lists each guard with its last verdict. **Evidence:** a chaos
case for each end; a kill between a verdict and the close keeps the guard;
a restart arms the next check again.

**G4. Guards on every placement.** Pi, Claude, and Codex bind `defer` and
`cancel`, and the Cloudflare seat object runs the check executor.
**Evidence:** a scripted guard on each executor family and in workerd; a
measurement of the resume cost of a room with many checks.

**J1. The job backend kind.** `backend.jobs` takes a `JobBackend`. The job
store is a journal with the entries `submitted`, `started`, `called`,
`ended`, and `sealed`. `WorkspaceFiles` gains a read and an append. The
tools are `job_submit`, `job_status`, `job_seal`, and the checkable
`job_done`, and the backend registers the `job` and `pipeline` handle
kinds. Needs G2. **Evidence:** `jobConformance` on the lifecycle, the
limits, and the fence: a host that lost the fence runs no binding.

**J2. A process sandbox.** `processJobs` starts `deno run` with
`--allow-read` on the snapshot directory, `--import-map`, `--no-remote`,
`--no-npm`, `--no-config`, and a memory flag, and with no other
permission. **Evidence:** `jobConformance` refuses the network, a file
outside the snapshot, the environment, a write, a child process, a URL
import, and a package import.

**J3. Pipelines.** `after` holds a job until its predecessors complete and
skips it when one does not. An open pipeline answers `act` when its last
step is done and nothing waits. **Evidence:** a scripted chain of three
jobs with one guard; a failure in the second step skips the third; an open
pipeline wakes the agent once for each step.

**J4. The sweep in the workbench.** A `characterize` room runs the sweep
of [docs/job.md](../docs/job.md) §11 with a simulated bench, as a pipeline
of one job for each scenario. [docs/trust.md](../docs/trust.md) gets a
row for the program, the bindings, and the job store. Needs G4 and J3.
**Evidence:** the sweep runs end to end on the scripted tier, and a probe
drift wakes the agent.

## 0.4.0: the room works between questions

**0.4.0 makes a room useful between questions.** An event or a clock wakes
it, and it hands work to another room. It starts on the kernel that 0.3.0
tags, because the guards of 0.3.0 change the same room files and the same
rules file.

| Theme                     | Acceptance                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W Wake sources            | A room wakes a seat on a notice from a resource and on a timer that the journal records. A restart re-arms every timer. An `awaiting` exchange expires on a stated bound.                      |
| D Delegation by reference | A working room is a room. A message that carries a ref to it delegates the work. The origin exchange awaits the working room, and one message with a ref returns the result. No task database. |

**Three format changes.** Each change lands with a golden journal of the
new shape, and the changelog names each one.

| Change                                  | Item | Kind                       |
| --------------------------------------- | ---- | -------------------------- |
| The notice message kind                 | W1   | A new message union member |
| The timer entry                         | W2   | A new entry kind           |
| An `awaiting` outcome that names a room | D1   | A new outcome union member |

**The order is the notice, the timer, then the delegation.** The notice
host call needs the notice kind, the timer needs the host call, and the
delegating message needs the notice. The Cloudflare adapter runs a timer
through its alarm after the timer lands.

**Decisions taken for 0.4.0.**

- **A notice opens an exchange for its owner.** The owner is the person
  who answers for the work that sent it. The notice waits for a quiet room,
  so an exchange stays one contiguous range.
- **A notice is the scheduler ingress.** The application owns its
  schedule and delivers a notice through one host call. The kernel adds no
  scheduler.
- **The journal records a timer, and the host runs it.** The host owns the
  clock. A restart reads the timer entries and arms them again.
- **Delegation has no task database.** A working room is a room, and a ref
  connects the two.
- **W2 decides `exchangeOutcome`.** If the `awaiting` expiry writes on the
  `awaiting` outcome, the rule gates a write and stays verified. Otherwise
  it leaves the rules file, as the 0.2.0 M2 sweep states for read views.

**W1. A notice from a resource.** A room wakes only when a person speaks,
so an agent cannot react when a brief changes or a run completes. Add a
message kind with a ref and no author, routed by attention. One host call
delivers it with a stable key, so a retried delivery lands once. An
application scheduler calls the same host call, so the kernel needs no
scheduler of its own. A notice opens an exchange for its owner when no
exchange is open, and it waits for a quiet room. It arrives through no
hidden timeout. **Evidence:** a scripted test and a chaos case
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

**D1. Delegation by reference.** PR #151 stored tasks in the journal and
scanned every task on each reconcile pass. Use a ref and the `awaiting`
outcome. The delegating message carries a ref to
`ambion://room/<working>/message/<from>`. The origin exchange closes as
`awaiting` that room. The working room closes with one message that
carries a ref back. Status is a read of the exchange that the referenced
message opened. **Evidence:** the workbench delegates one question to a
second room; a restart in the middle keeps the work. Then close PR #151
with a comment that names the new route.

## Designs with a shape

**The checkpoint entry.** A checkpoint entry lets a resume skip settled
history, and full replay stays the reference. It is a format change, so it
lands with a golden journal of the new format. **Condition:** the resume
measurement of 0.3.0 item G4 comes near the default
`limits.lease.ttl` of 60 seconds ([envelope.md](../docs/envelope.md)). Past
that point, replay sets the recovery time.

**Tool execution provenance beyond the activation.** `ToolContext` carries
the activation, the exchange, and the room. A purpose field, a retry-safe
operation key that the kernel derives, and a domain operation reused across
rooms wait. **Condition:** an application that needs one of the three.

**The evals package.** PR #153 adds room simulations with human actors,
judges, and offline regrading: 8,455 lines at alpha maturity by its own
list of open work. That list holds the failure matrix, live acceptance,
judge calibration, and twelve legacy variants. Its harness re-implements
the scripted stream and polls for a quiet room, and the 0.1.0 testing entry
removes both. **Condition:** a live-eval budget and an owner for the
calibration. The package then starts again from main on the testing entry.

**A durable subscription service across processes.** Subscriptions belong
to one running host. A client that reconnects reads and reacquires its
handles. **Condition:** a placement that serves one room from more than one
process.

**A generated API reference.** One reference per entry, with a CI check
that fails when it is stale. **Condition:** an adapter or host author who
cannot work from the typed README examples and the export snapshot.

**A SQL backend over a database server.** `backend.sql` takes any
`SqlBackend` ([Workspace](../docs/workspace.md#query-the-shared-database)),
and the package ships `sqliteBackend`. A backend over a database server
connects as each agent with its own credential, so the server enforces the
grants. It passes `sqlConformance`. **Condition:** the lab setup, one workstation and
one database server, is scheduled.

**A backend profile and concurrent operations.** A backend declares its
isolation, its network, and whether the owner may run operations from two
agents at once. The owner then keeps one queue for each agent. The same
design decides which identity writes the audit log. It builds on
the workspace interface of 0.2.0 item M7. **Condition:** a workstation
run where one agent's command delays another agent's file tool.

## Proofs to write

[docs/formal.md](../docs/formal.md) states the mechanism and the line a
proof must pay for. These proofs are open, and none removes a known defect.

| Proof                 | What it states                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| The stop-loop measure | A measure that the stop loop decreases                                                          |
| The pass measure      | A measure that each reconciliation pass decreases, so the `PASSES` bound is a proof             |
| Unique roster names   | `reseated` and `foldRoster` keep one seat per name                                              |
| `seatLive`            | The seats that are live now, as a rule beside `exchangeLive`                                    |
| `storedIdAccepted`    | The kinds on which `validate.ts` reads an activation id; a refusal on others is a schema change |

The chaos drain and the walk's `drained` check witness the two measures
today. **Condition:** a fault that one of them would have caught.

## Deferred by decision

- Hot-loaded definitions; the definition set is fixed per run.
- Multiple simultaneous discussions within one room; separate rooms.
- Per-tab presence tokens and automatic departures; hosts reconcile.
- Distributed workspace ownership; one owner per resource.
- Automatic summary skipping by message count; manual summary retry.
- Exchange budgets; deadlines and caps bound activations only.
- Agent source retrieval and pagination under the shared summary policy.
- Browser-only execution, a managed service, arbitrary edge platforms,
  turnkey deployment commands, multiple terminal clients.
- A `SeatObject` class rename in the Cloudflare adapter; it needs
  Durable Object migration evidence.
- The lease `since` in `room/rules.verified.ts` keeps its name until a
  proof edit renames it.
- A provider-neutral plugin ecosystem beyond the executor contract.
- A second live-tier provider job. Add one only if a provider-specific
  defect turns up.

## Open pull requests

| PR   | Title                                           | Decision                                                    |
| ---- | ----------------------------------------------- | ----------------------------------------------------------- |
| #151 | Exchange-scoped tasks and Relay background work | Close in 0.3.0 item D1; delegation by reference replaces it |
| #153 | Room simulation evals (draft)                   | Hold; see the evals package above                           |
| #171 | Workspace log regression and path checks        | Carry onto main, then land in 0.2.0 item M4 first           |
