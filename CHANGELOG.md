# Changelog

## Unreleased

**A shell command runs in the background.** `bash` starts every command as
a background process and returns a handle. A process outlives the call and
the activation that started it. The files of the bash backend hold the
process table, so a new run of the host reads the same table. Each
activation starts with a reminder of the seat's processes. No message
wakes a seat when a process ends: the agent waits for the result inside
the activation, and the guidance says so. A host that wants a wake posts a
message. See [Processes](docs/processes.md).

**An agent comes back to its work later.** An agent says to itself with
`after`, in seconds. The exchange closes while the say waits. When the say
is due, the room writes a returned say, which wakes the agent and opens an
exchange for the owner of the first one. See
[Exchange](docs/exchange.md#6-a-scheduled-say).

### New

- **`@ambionframework/simulator` runs evals on a room.** `simulate(room,
  options)` drives a room that the test started. An actor plays a person,
  one exchange at a time, and the loop waits for the close and the summary
  under one deadline, `exchangeMs`. The run holds the moves, each exchange
  with its closed view, one read of the room, the events, and the usage.
  It ends with `stopped`, `limit`, `timeout`, or `failed`. `scriptedActor`
  plays a fixed list of moves. See [Simulator](docs/simulator.md).
- **`agentActor` and `agentJudge` run the person and the grade on a model.**
  Each takes `model`, `tools`, `bundles`, `services`, and `timeoutMs`, and
  runs on `runAgent`. The actor ends each move with `send` or `stop`, and
  the tools see the person in `ctx.agent`. The judge reads the record
  between two lines that carry a random token, and ends with `grade`: one
  finding for each criterion, in the order of the list, reason first. The
  judge attaches each criterion, and `grade` refuses a list of the wrong
  length. `@ambionframework/simulator` now depends
  on `@ambionframework/pi`.
- **`runAgent` runs one Pi agent outside a room.** It takes a model, a
  routing name, the agent that the tools see, a system prompt, one prompt,
  tools and bundles, and the names of the tools that end the run. It runs
  Pi's `AgentHarness` until the agent calls one of them, and returns that
  call, the calls before it, and the usage of every request. A `signal`
  aborts the run. `@ambionframework/pi` exports `runAgent`,
  `RunAgentRequest`, `RunAgentResult`, and `RunAgentCall`. The simulator of
  [Simulator](docs/simulator.md) builds its actor and its judge on it.
- **A Pi seat takes a thinking level.** `pi({ thinking })` takes a Pi
  `ThinkingLevel`, and the harness sends it to the provider. Absent, the
  level is `off`, as before. `runAgent`, `defineAssistant`, `agentActor`,
  and `agentJudge` take `thinking` too.
- **`say` takes `after`.** A say to oneself with `after` schedules it. The
  room stamps `owner`, the owner of the open exchange, on the said entry,
  and refuses `after` in any other say. The result names the due time.
- **The `returned` entry.** The room writes `{ to, message, owner,
  text, refs }` when a scheduled say is due. It has no `from`. It wakes
  one seat, the one that `to` names, and steers no other. It opens an
  exchange for `owner` when none is open. `isReturned` and
  `ReturnedMessage` are new exports.
- **`limits.schedule`** bounds `after` from `minAfter` to `maxAfter`
  seconds, 60 to 604,800 by default, and the says of one seat that wait,
  `pending`, 4 by default.
- **`RoomRead.scheduled` lists the says that wait to return**, each a
  `PendingSay` with its due time. `PendingSay` is a new export.
- **The workbench shows a returned say, and notes each say that waits.**
- **`ps`, `status`, `wait`, and `cancel` join `bash`.** `ps` lists the
  running processes of the caller. The handle tools take a handle of the
  caller. `bash` takes an optional `name`, a label that `ps` and the
  reminder show. Each process is a directory,
  `~/.processes/<handle>/`, that holds the spec, the whole output in
  `out`, the process id, and the end.
- **A new run of the host adopts the live processes of an earlier run.**
  The table re-arms the timeout of each one, and `cancel` stops it through
  its process id. A process that ended with the earlier run, with no exit
  file, is `failed` with the message "The host run ended before the
  process did."
- **A wait ends before the activation does.** The room puts `deadline` on
  each view, and `ToolContext.deadline` carries it to each tool call: when
  the room ends the activation, in milliseconds on the wall clock. `bash`
  and `wait` stop their wait 30 seconds before it, and the result says so.
- **A result gives the new output.** `bash`, `status`, `wait`, and
  `cancel` give the output after a cursor that the process keeps in
  `~/.processes/<handle>/cursor`, and move it. `details.read` holds the
  byte range. A poll of a long build gives each part once. Each read goes
  through the shell capture, which removes escape sequences and carriage
  returns, as Pi's `bash` tool does.
- **`wait` takes `handles`.** It returns when the first of up to 16
  processes ends, with the new output of each process that ended and the
  state of each one that still runs.
- **`Workspace.processes` is the host's view.** `list`, `subscribe`, and
  `cancel` reach the processes of the agents that used the workspace in
  this run. `list` returns a promise. The root entry of
  `@ambionframework/workspace` exports `ProcessEvent`, `ProcessKind`,
  `ProcessQuery`, `ProcessState`, `ProcessStatus`, and
  `WorkspaceProcesses`.
- **A tool bundle can remind a seat.** `ToolBundle.remind` gives text, or a
  promise of text, for each respond activation, and `AgentExecutor.reminders`
  holds the reminders of the bundles. The executor resolves them once for each
  activation, with a bound of 5 seconds for each, and aborts the signal of a
  reminder at the bound. `renderActivation` takes the resolved text as its
  third argument and adds it before the ask line. The main entry exports
  `Reminder` and `ReminderSeat`. The hosting entry exports `resolveReminders`
  and `REMINDER_TIMEOUT_MS`. The Pi executor sends a continued session the
  reminders before the delta.
- **The workstation keeps a session open while any environment is open
  over it.** A process holds an environment for its whole run.
- **The Workbench shows the background processes with `/ps`.** A side
  panel lists the processes of the agents, shows the end of the chosen
  output, and cancels a running process on a second `x`.
- **`workstationGitBackend` keeps the repositories of a workspace on the
  workstation.** One account on the server, such as `lab-git`, owns every
  repository. The backend prepares the account, writes the forced command
  `~/.ambion/serve`, registers each template by a rename, and runs
  `list`, `get`, and `fork` as scripts on the server. A fork lands with
  one rename. `identityFor` issues an Ed25519 key for each agent and
  writes its line to `~/.ssh/authorized_keys.ambion` under `flock`, with
  `restrict`, `from`, `expiry-time`, and `command`.
  `@ambionframework/workstation` exports `workstationGitBackend`,
  `WorkstationGitOptions`, `WorkstationGitAccess`, and
  `WorkstationGitIdentity`. See [Workstation git](docs/workstation-git.md).
- **`workstationBackend` carries the git transport `ssh`.** Its
  `gitTransports` is `['ssh']`, so it pairs with `workstationGitBackend`.
  At each `connect`, it writes the agent's key, a `known_hosts` file, and
  an ssh configuration for the alias into `~/.ssh` with mode `0600`. It
  makes `Include ambion-git.conf` the first line of `~/.ssh/config`, and
  it keeps the other lines. The agent's own `git` then clones and pushes
  over SSH to the git account on the loopback address.

### Fixes

- **`directoryBackend` runs each filesystem change as trusted code of
  just-bash.** just-bash 3.4.2 starts a queued change in the async context
  of the change before it. When a script made that earlier change and then
  ended, the defense layer of just-bash blocked the queued change. Each
  later change on the directory then waited with no end, and so did the
  workspace owner, `wait`, and the host's list of processes.

### Breaking changes

- **The default assistant is passive at `broadcast`, and keeps to
  membership and summaries.** It sends nothing to a specialist at
  `broadcast` or `presence` attention. It sends no correction, no relay,
  and no question to the person during the exchange. The summary reports a superseded
  fact, a broken constraint, and a question for the person. The assistant
  answers a person or a specialist that addresses it, and it sends one directed
  request to an idle specialist at `named` attention. A constraint stays in
  force until the person withdraws it. Its identity now reads "Room
  assistant. Seats and unseats specialists as the request needs, and
  summarizes each exchange." See [Default assistant](docs/assistant.md).
- **The journal changes.** A said entry takes `after` and `owner`, and the
  `returned` entry is new. A returned say opens an exchange, so the
  verified rule `opensExchange` accepts it.
- **`Message` has a fourth member, `ReturnedMessage`.** Code that switches
  on `kind` meets `returned`.
- **`RoomRead` has `scheduled`.** A value that builds a read by hand adds
  it.
- **`say` has an `after` parameter.** A tool schema that a test pins lists
  it.
- **`bash` returns a handle, and waits up to `wait` seconds, 10 by
  default.** A command that runs longer keeps running, and the result
  says so. A process can run for `timeout` seconds, 600 by default. Before,
  a command held the bash owner and stopped after 30 seconds by default.
- **Every workspace has eight tools before the tools of its other
  backends.** The tool line of the guidance counts them.
- **`dispose()` stops every running process of this run** before the bash
  backend releases its handles.
- **`@ambionframework/git` is gone.** Its git backend moves into the new
  entry `@ambionframework/just-bash/git`. That entry exports
  `justGitBackend`, `sqliteGitStorage`, `JustGitBackend`,
  `JustGitBackendOptions`, `GitStorage`, `OpenGitStorage`, `Registry`, and
  `RegistryRow`. The root entry of `@ambionframework/just-bash` loads no
  `node:sqlite`.
- **`gitBackend` is now `justGitBackend`, and `GitBackendOptions` is now
  `JustGitBackendOptions`.** `justGitBackend` has no `handler` and no `url`
  option. Every clone URL starts with `http://git.ambion.invalid`, and the
  backend serves the process it runs in.
- **The template helpers and the name rules move to the new entry
  `@ambionframework/workspace/git`.** It exports `fromDirectory`,
  `filesOf`, `hashesOf`, `sameFiles`, `changeTo`, `validName`,
  `namespaceOf`, `assertAgent`, `readOnly`, `TEMPLATES`, `SOURCES`,
  `TemplateRegistration`, `TemplateSource`, and `TemplateFiles`. Import
  `fromDirectory` from there.
- **The workstation writes no `~/.git-credentials`.** Its agents reach
  git through `workstationGitBackend` and the `ssh` transport.
- **`GitAccess` holds `transport` alone.** `prefix`, `fetch`, and
  `credentialFor` move to `JustGitAccess`, and `credentialsFor` goes.
  `GitFetch` and `GitCredential` leave the root entry of
  `@ambionframework/workspace`. `@ambionframework/just-bash/git` exports
  them and `JustGitAccess`. `JustGitBackend.access` is a `JustGitAccess`,
  whose `transport` is `in-process` and whose `fetch` is always set.
- **A bash backend lists the git transports it carries in
  `BashBackend.gitTransports`.** `openWorkspace` throws when the bash
  backend does not carry the `transport` of the git backend. The error
  names that transport, the `server` of the git backend, and the
  transports of the bash backend. A bash backend with no `gitTransports`
  carries none. `memoryBackend` and `directoryBackend` carry
  `in-process`, and they refuse an access of another transport at
  `connect`.
- **A registration with a changed source updates its template.** Before,
  it failed with an error that named the template, and the host
  registered the change under a new name. Now both git backends
  fast-forward `templates/<name>` to a new commit whose parent is the old
  tip. A changed description replaces the old one. A fork keeps the
  commit it came from. `justGitBackend` commits the change to
  `template-sources/<name>` and moves the template's ref. `Registry` gets
  `describe`.
- **`gitConformance` asks the harness for each credential fact.**
  `GitConformanceBackend` gets four hooks: `sourcesCredential`,
  `issueCredentials`, `writeCredential`, and `probeCredential`. Each hook
  takes the pair that the case opened, a `GitConformancePair`, and
  `probeCredential` gives a `GitConformanceProbe`. The conformance entry
  exports both types. `GitConformanceBackend`, `GitConformanceStore`, and
  `gitConformance` take the type of the git backend as a parameter.
  `GitConformanceOptions.tokenTtl` is now `credentialTtl`, and
  `GitConformanceBackend.shortestTokenTtl` is now `shortestCredentialTtl`.

## 0.2.0 (2026-09-24)

**A workspace now has real backends.** A shell on a remote server, a shared
SQL database, and git repositories plug into one workspace. The Pi executor
runs on Pi's AgentHarness. A seat keeps its model session for one exchange.
Every library package needs Node 22.19 or newer.

### Packages

| Package                                 | What it gives                                                     |
| --------------------------------------- | ----------------------------------------------------------------- |
| `@ambionframework/ambion`               | The kernel: room, journal vocabulary, rules, and hosting          |
| `@ambionframework/journal`              | The append-only journal                                           |
| `@ambionframework/assistant`            | The default assistant                                             |
| `@ambionframework/pi`                   | The Pi executor, on Pi's AgentHarness                             |
| `@ambionframework/claude`               | The Claude Agent SDK executor                                     |
| `@ambionframework/codex`                | The Codex SDK executor                                            |
| `@ambionframework/cloudflare`           | A room and its seats as Durable Objects                           |
| `@ambionframework/workspace`            | The workspace interface, its tools, and a SQLite backend          |
| `@ambionframework/just-bash` (new)      | A shell and a filesystem in the process, in memory or on a folder |
| `@ambionframework/workstation` (new)    | A shell over SSH on one server, with one Unix account per agent   |
| `@ambionframework/git` (new)            | Git repositories that agents fork, clone, and push                |
| `@ambionframework/cli` (retired)        | No replacement                                                    |
| `@ambionframework/pi-journal` (retired) | Pass a `logger` to the runtime to read what a seat did            |

### New

**A workspace takes one backend of each kind.** `bash` is required. `sql`
and `git` are optional, and each one adds its tools and its guidance.

```ts
import { openWorkspace } from '@ambionframework/workspace';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { directoryBackend } from '@ambionframework/just-bash';
import { fromDirectory, gitBackend, sqliteGitStorage } from '@ambionframework/git';

const lab = openWorkspace({
  name: 'lab',
  backend: {
    bash: directoryBackend('./data/lab'),
    sql: sqliteBackend('./data/lab.db'),
    git: gitBackend({
      storage: sqliteGitStorage('./data/lab-git.db'),
      secret: process.env.LAB_GIT_SECRET ?? '',
      templates: { report: { source: fromDirectory('./templates/report') } },
    }),
  },
  audit: {},
});
```

- **Workstation.** `workstationBackend({ host, hostKey, layout,
  credentialFor })` runs each agent's shell as its own Unix account over
  SSH. Files go over SFTP. A timeout or an abort kills the command's process
  group. See [Workstation](docs/workstation.md).
- **SQL.** The `sql` tool runs on the shared database of `backend.sql`. It
  shows the last result as a table, up to `maxRows` rows, and `export`
  writes the full result as CSV. Each agent's tables and views are visible
  to every other agent at once.
- **Git.** An agent lists templates with `repos`, forks one with `fork`,
  clones the fork into its home, and pushes with `git` in `bash`. A push
  keeps the work across a restart. See [Git](docs/git.md).
- **`git` in every just-bash shell.** It needs no configuration. The
  author of a commit is the agent's name.

**The Pi executor runs on Pi's AgentHarness.** The harness owns the model
loop, the session, and compaction. `pi({ compaction })` sets compaction.
`piExecution({ sessions, sessionDir })` keeps sessions on disk by default,
or in memory. A context overflow makes the harness compact once and send
the request again. Transient provider errors go to the room, and the room
owns every retry.

**A seat keeps its session for one exchange.** Pi, Claude, and Codex each
resume the seat's session on its next activation in the same exchange. The
first activation in an exchange starts fresh. A lost session starts fresh
from the record.

**The trace goes to your logger.** `createRuntime({ logger })` and the
Cloudflare `configure({ logger })` take a `TraceLogger`. It gets one
`TraceRecord` for each step of an activation: the room, the seat, and the
step.

**Executor authors get the room tools from the hosting entry.**
`roomTools`, `agentTools`, and `toolContext` from
`@ambionframework/ambion/hosting` hold the rules of `say`, `seat`,
`unseat`, and a definition's tools. The Pi, Claude, and Codex executors use
them.

**Conformance suites for each backend kind.** From
`@ambionframework/workspace/conformance`: `workspaceConformance` for a bash
backend, `sqlConformance` for a SQL backend, and `gitConformance` for a git
backend. The Pi executor now runs the executor conformance suite, as Claude
and Codex do.

### Fixes

- A resumed Claude activation gets the duties of its new activation, such
  as the summary duties.
- A Claude seat no longer joins the Claude Code session of its host.
- A second Cloudflare seat alarm during a live run returns at once. Before,
  it released the live run as failed.
- A journal entry of a known kind with an invalid `seq` throws. Before, the
  journal skipped it.
- A failed summary draft of another seat no longer counts against the
  summary writer.
- The audit log reports a failure to create its directory to `onError`.
- The room mirror ignores a stray file, such as `messages.jsonl.bak`,
  beside its log when it resumes.

### Breaking changes

There is no compatibility promise before 1.0.0. Some stored formats
changed, and 0.2.0 has no reader for the old ones. Start each room fresh.

- **`openWorkspace` takes `backend: { bash }`.** Import `memoryBackend` and
  `directoryBackend` from `@ambionframework/just-bash`. `WorkspaceBackend`
  is now `BashBackend`, and it names a `layout`.
- **The `sql` tool needs `backend.sql`.** Use `sqliteBackend(path)` from
  `@ambionframework/workspace/sqlite`. The tool no longer runs `sqlite3` in
  the shell, and it has no `database` or `timeout` parameter.
- **The `memory` option of `pi()`, `claude()`, and `codex()` is gone.**
- **The trace journals are gone.** Pass a `logger`. `Hosting.traces` and
  the `step`, `trace_error`, and `audit_error` events are gone.
- **The workspace change log is gone.** The audit log records every tool
  call.
- **`WorkspaceAgent` is `{ name }`, and a resource has no `destroy()`.**
- **A Codex seat with `nativeTools: 'codex'` runs with no Codex sandbox by
  default.** Run it only on an isolated host, or set `sandboxMode`.

**Removed and moved names, by entry:**

| Entry                             | Change                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ambionframework/ambion`         | Gone: `readActivation`, `ActivationRead`, `ActivationPass`                                                                                                                                          |
| `@ambionframework/ambion/hosting` | Gone: `traceJournals`, `traceOpener`, `TraceOptions`                                                                                                                                                |
| `@ambionframework/journal`        | Gone: `scanned`                                                                                                                                                                                     |
| `@ambionframework/pi`             | Gone: `seatSessionId`                                                                                                                                                                               |
| `@ambionframework/workspace`      | Moved to `@ambionframework/just-bash`: `memoryBackend`, `directoryBackend`, `MemoryBackendFile`, `MemoryBackendOptions`, `SeedWriter`. `MemoryWorkspaceBackend` is `MemoryBashBackend` there        |
| `@ambionframework/workspace`      | Renamed: `WorkspaceBackend` is `BashBackend`                                                                                                                                                        |
| `@ambionframework/workspace`      | Root re-export gone, the entry keeps it: `openResource`, `ResourceBackend`, `ResourceEnv`, `WorkspaceAgent`, `WorkspaceResource` on `./resource`; `openSqlResource` and its types on `./sql`        |
| `@ambionframework/workspace`      | Gone: `openChangeLog`, `ChangeLog`, `ChangeLogOptions`, `ChangeQuery`, `WorkspaceChange`, `DEFAULT_CHANGE_LOG`, `SHARED_DATABASE`, `ROOM_MIRROR_GUIDANCE`, `roomMirrorPath`, `DEFAULT_ROTATE_BYTES` |
| `@ambionframework/workspace/sql`  | Gone: `SqlValue`. Import it from the root entry                                                                                                                                                     |

**Stored formats that changed:** the `ambion/trace` and `ambion/pi-session`
journals are gone. The `session` of an ended lease names the session of the
exchange. A Cloudflare object keeps its metadata in the `ambion_metadata`
table.

## 0.1.0 (2026-09-21)

**The first release of Ambion.** Ambion is a collaboration kernel for agents and humans. A room
is a shared journal with rules for taking part. The [README](README.md) holds
the positioning, and [Technical facts](docs/technical-facts.md) holds the key
facts. [The plan](planning/next.md) names the open work.

### Packages

Every package needs Node 26.4 or newer. The ten packages release in lockstep.

- **`@ambionframework/journal`** provides the append-only journal: one queue,
  fenced by run, with conditional and idempotent appends.
- **`@ambionframework/pi-journal`** stores full Pi transcript sessions over
  the journal storage contract.
- **`@ambionframework/ambion`** provides the kernel: protocol, journal
  vocabulary, rules, room, and driver, with `/hosting` and `/testing`.
- **`@ambionframework/pi`** provides the Pi executor and the audit of each
  seat transcript.
- **`@ambionframework/claude`** provides the Claude Agent SDK executor.
- **`@ambionframework/codex`** provides the Codex SDK executor.
- **`@ambionframework/workspace`** provides the resource contract, a
  directory workspace, and a SQL resource.
- **`@ambionframework/assistant`** provides a default assistant that guides
  membership and writes closing summaries.
- **`@ambionframework/cloudflare`** runs a room and its seats as Durable
  Objects.
- **`@ambionframework/cli`** provides `ambion new` and `ambion dev`.

### Boundaries of this release

- **No total exchange budget.** Activation deadlines and retry caps bound one
  activation. Continuing contributions keep an exchange open.
- **External effects stay with the application.** Tools can act before a
  contribution commits, and the application owns effect idempotency.
- **A crash records no departure.** Hosts reconcile durable presence with
  their connections after recovery.
- **Subscriptions belong to a running host.** A reconnecting client reads
  durable messages and reacquires exchange handles.
- **A workspace gives no operating-system isolation** between agents.
- **Native timers, external event subscriptions, and scheduler ingress are
  future work.**
- **No browser-only execution and no managed service.** The journal owns no
  domain transactions and no credentials.
