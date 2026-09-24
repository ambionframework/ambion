# Changelog

## Unreleased

**A shell command runs in the background.** `bash` starts every command as
a background process and returns a handle. A process outlives the call and
the activation that started it. The files of the bash backend hold the
process table, so a new run of the host reads the same table. Each
activation starts with a reminder of the seat's processes. See
[Processes](docs/processes.md).

### New

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

### Breaking changes

- **`bash` returns a handle, and waits up to `wait` seconds, 10 by
  default.** A command that runs longer keeps running, and the result
  says so. A process can run for `timeout` seconds, 600 by default. Before,
  a command held the bash owner and stopped after 30 seconds by default.
- **Every workspace has eight tools before the tools of its other
  backends.** The tool line of the guidance counts them.
- **`dispose()` stops every running process of this run** before the bash
  backend releases its handles.

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
