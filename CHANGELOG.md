# Changelog

## Unreleased

**The Pi executor runs on Pi's AgentHarness.** The harness owns the model
loop, the session, its persistence and its compaction. The model holds the
room tools and the tools of the definition only: no built-in tool, no skill
and no prompt template. Freshness reads each range of the record from the
exact provider input. Sessions persist as JSONL files under `sessionDir`,
by default `ambion-pi-sessions-<uid>` in the OS temporary directory, with
access for its owner only, for every stream. `sessions: 'memory'` keeps
them in memory, two for each room and seat. A session the disk refuses
stays in memory, and a session that does not open, restore or write gives
way to a fresh one: the activation does not fail. `pi()` takes `compaction`, by default Pi's
`DEFAULT_COMPACTION_SETTINGS`, and refuses token counts the harness
refuses. `piExecution()` and
`createExecutionServices()` take `sessions` and `sessionDir`, and
`ExecutionServices` has `sessions`. `createPiExecutor` takes `sessions`, and `memorySessions`,
`PiSessions` and `SessionScope` are new. `@ambionframework/pi/testing` adds
`piExecutorHarness` and `scriptOf`, and the Pi executor runs the executor
conformance suite. Harness retries and provider client retries are off, so
the room owns every retry: a transient provider error reaches the room at
once. A context-overflow error, or a length stop below the output limit,
makes the harness compact once and send the request again, also when
compaction is off. A usage step comes from each provider request, a
compaction summary included. An activation that a provider error failed
records its session. Its retry continues the session from the last
position it read, and the failed run leaves the provider input. An
activation that a session store fault failed records a fresh, empty
session. The golden journals changed.

**The trace goes to the host's logger.** `createRuntime({ logger })` and
Cloudflare `configure({ logger })` take a `TraceLogger`. The sink gives it
one `TraceRecord` for each step: `room`, `seat`, and the stamped step. With
no logger, the sink drops the steps. `readActivation`, `ActivationRead` and
`ActivationPass` are gone from `@ambionframework/ambion`. `traceJournals`
and `traceOpener` are gone from `@ambionframework/ambion/hosting`, and
`Hosting.traces` is gone. The `step` and `trace_error` events are gone.
`createExecutionServices` takes no `storage` and returns no `traces`.
Storage keeps no `ambion/trace` journals. `@ambionframework/pi` no longer
depends on `@ambionframework/journal`.

**A seat keeps its harness session for one exchange, and the `memory`
option is gone.** `pi()`, `claude()` and `codex()` take no `memory`. Every
executor records its session on the `ended` lease entry. The room hands it
to the next activation of the same seat in the same exchange as
`spec.resume`. The first activation of a seat in each exchange starts
fresh. The session is a cache with best-effort persistence: on Node,
Claude, Codex and Pi keep it on the local disk, and a Pi seat on
Cloudflare keeps it in memory.
A lost session starts fresh from the record. Remove `memory` from
each executor definition. `resumesForSeat` is gone from
`@ambionframework/ambion/hosting`. The golden journals changed.

**`@ambionframework/pi-journal` and the Pi transcript audit are gone.** The
activation trace, given to the host's logger, shows what a seat did.
`seatSessionId`, the `transcripts` and `room` options of `createPiExecutor`,
the `transcripts` service of `createExecutionServices`, and the `audit_error`
event are gone. Storage keeps no `ambion/pi-session` journals. Pass a `logger`
to `createRuntime` to read the steps.

**The executor conformance suite has a case for the fresh start.** An
executor that declares `memory` starts a fresh session when the view names
none. The Claude harness takes no `memory` option.

**A second seat alarm returns while a run is live.** `SeatObject.alarm()`
returns at once while a run is live in the object. Before, a second call
treated the live run as one that an eviction lost. It released the lease
as `failed`, and the room refused the run's next say. workerd runs one
alarm at a time, and a test that calls `alarm()` directly, as
`runDurableObjectAlarm` does, reached this path. An object that was
evicted mid-activation holds no live run, and its next alarm still
releases the lost run.

**A stall of the workstation host does not cut the output early.** After
the exit status, the channel closes 1 second after the last output. When
that timer fires more than half a second late, the process stalled, and
output can wait unread behind the stall. `SshEnv` then waits one more
second, up to the 5-second limit. The view ends with the drain notice only
when output arrived in the last second before the limit.

**The just-bash backends run `git`.** Each agent's shell has `git` from
`just-git`, with no configuration from the host. The author of every commit
is the agent's name, and `git config` does not change it. `git` has no
network access, so a remote is a path on the workspace's filesystem. The
backend's guidance names the subcommands and these limits.

**New package: `@ambionframework/just-bash`.** It holds `memoryBackend`,
`directoryBackend`, and their `MemoryBackendFile`, `MemoryBackendOptions`,
`MemoryBashBackend`, and `SeedWriter` types. The `./just-bash` entry of
`@ambionframework/workspace` is gone, and the workspace no longer depends
on `just-bash`. A host that uses the workstation installs no just-bash.
Import from `@ambionframework/just-bash` where you imported from
`@ambionframework/workspace/just-bash`.

**The workspace root entry exports four more environment helpers.**
`HomeEnv` is a base class for an `ExecutionEnv` with `cwd`,
`absolutePath`, `joinPath`, and `readTextLines`. `withDeadline` runs a
command under a `Deadline` and turns a thrown error into `unknown`.
`deliverView` hands the output view to `onUpdate` and returns the result.
`DEFAULT_TIMEOUT_SECONDS` is 30. The just-bash backends and the
workstation both build on them.

**The hosting entry holds the room tools once.** `roomTools(view, binding,
options?)` returns `say`, `seat`, and `unseat` for one activation, or `say`
alone for a closing activation. `agentTools(view, agent, signal, current)`
returns the tools of the definition in the same form, and
`toolContext(agent, view, call, signal, onUpdate?)` builds the context of
one call. The entry also exports the `RoomTool`, `RoomToolBinding`,
`RoomToolContent`, `RoomToolOptions`, and `RoomToolResult` types. The Pi,
Claude, and Codex executors adapt these tools and keep no copy of their
rules. A Claude or Codex call of a definition tool now takes its call id
before `prepareArguments` runs.

**`@ambionframework/workspace` imports `typebox` and bundles no copy of it.**
The SQL tools use `typebox` at runtime, and the manifest declared it only for
development. tsdown then inlined `typebox` 1.3.18 into `dist`, 143 KB of the
296 KB. `typebox` is now a dependency of the package.

**`@ambionframework/pi-journal` takes `@earendil-works/pi-agent-core` as a
peer dependency.** The package uses only its types. The host that stores Pi
sessions supplies the one copy that the host and the package share.

**`@ambionframework/claude` and `@ambionframework/codex` no longer install
`typebox`.** Each package uses only its types, and no built file imports it.

**Package hygiene reads the built files.** `pnpm run check:packages` fails on
an import in `dist` of a package that the manifest does not declare as a
runtime or peer dependency. It also fails on bundled code from outside the
package's own `src`.

**New package: `@ambionframework/workstation`.** `workstationBackend(options)`
returns a `BashBackend` over SSH to one remote server, with one Unix account
for each agent. File calls go over SFTP, and each command runs in its own
process group, which a timeout or an abort kills. The backend pins the
server's host key, keeps one client for each agent, and closes a client
after `idleTimeout` seconds unused, 300 by default. `credentialFor` gives
the key of each agent and of the host account. See
[Workstation](docs/workstation.md).

**`WorkspaceFiles` writes its temporary file beside the target.** An
export lands in `<target>.<random>.part` in the target's folder, and the
rename onto the target stays on one filesystem. It wrote under `/tmp`
before, and a server that mounts `/tmp` as a filesystem of its own refused
that rename.

**`openWorkspace` takes its backends by kind.** The `backend` option is
now `WorkspaceBackends`: `{ bash, sql? }`. Write
`backend: { bash: memoryBackend() }` where you wrote
`backend: memoryBackend()`. `WorkspaceBackend` is renamed `BashBackend`,
and `MemoryWorkspaceBackend` is renamed `MemoryBashBackend`. The root entry
exports the `WorkspaceBackends`, `SqlBackend`, `SqlEnv`, `SqlOutcome`,
`SqlRow`, `SqlRunOptions`, `SqlValue`, and `WorkspaceFiles` types.

**The `sql` tool runs on a SQL backend, and a workspace with no SQL
backend has no `sql` tool.** `backend.sql` takes a `SqlBackend`: a shared
database that need not live on the shell's filesystem. The new
`@ambionframework/workspace/sqlite` entry exports `sqliteBackend(location)`,
the default SQL backend over `node:sqlite`. It refuses a statement that
opens a host file, rolls back a transaction that a call leaves open,
detaches every database a call attached,
refuses a result with two columns of one name, and stops a call after
`timeout` seconds, 30 by default. The SQL backend runs under an
owner of its own. `connect(agent, files)` gives it the calling agent's
`WorkspaceFiles` on the bash backend. `run(sql, { maxRows, export? })`
gives the last statement's columns, its first `maxRows` rows, and its row
count, and writes an export as CSV through `files`. The root entry exports
`sqlResult`, which does the preview, the count, and the streamed export
for a backend. The `sql` tool takes `sql`, `export`, and `maxRows`, an integer up to 1000.
`Workspace.sql` exposes the SQL owner, and `dispose()` disposes the SQL
owner and then the bash owner.

**The `sql` tool no longer runs `sqlite3` through the shell.** The tool
loses its `database` and `timeout` parameters. `WorkspaceLayout` loses
`database`, and the root entry no longer exports `SHARED_DATABASE`. The
just-bash backends hold no shared database at `/workspace/shared.db`. To
keep a shared database, set `backend.sql` to `sqliteBackend(path)`.

**`./conformance` exports `sqlConformance`,** the cases every
`SqlBackend` passes.

**`SqlValue` moves from `./sql` to the root entry.** `./sql` no longer
exports the type.

**The default tool guidance names four tools with no SQL backend, and five
with one.** The `sql` paragraph names the backend's `database` and adds the
backend's own guidance.

**A `WorkspaceBackend` now names its own layout.** A new `WorkspaceLayout`
type, exported from the root, holds three paths: `audit`, the audit log a
caller sets no `path` for; `database`, the database a `sql` call names none
for; and `rooms`, the root `mirror()` writes every room's record under.
`WorkspaceBackend` gains a required `layout` field. `openWorkspace` reads it:
the audit log opens at `layout.audit` when `options.audit.path` is absent,
the `sql` tool opens `layout.database` when a call names no `database`, and
`mirror()` writes under `layout.rooms`. The room-mirror guidance also names
this actual path, in place of the fixed text it stated before.
`memoryBackend` and `directoryBackend` both name `/workspace/audit.jsonl`,
`/workspace/shared.db`, and `/rooms`, so no file moves.

**`openWorkspace` builds one host agent, and `Workspace` exposes it.** The
identity `mirror()` writes as, `<name>-host`, is now `Workspace.host`. A
backend with real accounts can give it credentials.

**The root entry of `@ambionframework/workspace` exports the environment
helpers.** `resolvePath`, `Deadline`, `boundedView`, `spill`, `TMP`,
`randomName`, `tempDirPath`, `tempFilePath`, `spillPath`, and the
`MinimalWriter` type move out of `bash-env.ts` into a neutral
`execution-env.ts` module, which imports no `just-bash`. `bash-env.ts` keeps
only the just-bash mapping and calls these helpers. A new `ExecutionEnv`
backend now builds on the same helpers, from the root entry, without a
dependency on just-bash.

**`destroy()` leaves the workspace resource contract.** `WorkspaceResource`,
`ResourceBackend`, and `SqlResource` no longer have a `destroy` member. On a
shared server, a resource's own `destroy()` would delete the files of every
account. `dispose()` releases local handles and keeps the persisted data. A
host deletes the data that it owns.

**`@ambionframework/cli` is removed.** It provided `ambion new` and `ambion
dev`. It also carried its Node 26.4 floor, the OpenTUI floor, onto every
package, whether or not that package needed it.

**Every library package now needs Node 22.19 or newer, not 26.4.**
`examples/workbench` keeps the 26.4 floor, because it depends directly on
`@opentui/core`. CI tests both floors.

**The workspace change log is removed.** It recorded a `write` or an `edit`
call only. A change through `bash`, `sql`, or a script never reached it, and
the audit log already records every tool call with its arguments and its
provenance. `changes.ts` is gone. `@ambionframework/workspace` no longer
exports `openChangeLog`, `DEFAULT_CHANGE_LOG`, `ChangeLog`,
`ChangeLogOptions`, `ChangeQuery`, or `WorkspaceChange`. `openWorkspace` no
longer takes a `changes` option, and `Workspace` no longer has a `changes()`
method. `WorkspaceBackend` no longer has `changedPaths`, and the just-bash
backends no longer set it.

**`WorkspaceAgent` loses `identity`.** No backend read the field; each one
keys on `name` alone. `WorkspaceAgent` is now `{ name }`. The workspace's own
host agent, for the room mirror, now carries only a name.

**The root entry of `@ambionframework/workspace` loads no backend.** A new
`./just-bash` entry exports `memoryBackend`, `directoryBackend`,
`MemoryBackendFile`, `MemoryBackendOptions`, `MemoryWorkspaceBackend`, and
`SeedWriter`. The root entry no longer exports them. `directoryBackend`
imports `ReadWriteFs` from `just-bash` at the top of its module now, not
with a lazy `import()` on first connect.

**The root entry no longer exports the resource contract or the SQL
resource.** `openResource`, `ResourceBackend`, `ResourceEnv`,
`WorkspaceAgent`, and `WorkspaceResource` stay on `./resource`.
`openSqlResource`, `PROVENANCE_COLUMNS`, `SqlProvenance`, `SqlResource`,
`SqlResourceEnv`, `SqlResourceOptions`, and `SqlValue` stay on `./sql`. Each
entry held them already; only the root re-export is gone.

**The root entry no longer exports three names with no consumer.**
`ROOM_MIRROR_GUIDANCE`, `roomMirrorPath`, and `DEFAULT_ROTATE_BYTES` are
gone from the root. `mirror.ts` still exports `roomMirrorPath`, now
`roomMirrorPath(root, roomName)`, and the guidance text as a function,
`roomMirrorGuidance(root)`, for the package's own tests.
`DEFAULT_ROTATE_BYTES` has no replacement. It stays a local default
in `log.ts`, unexported.

**A new `@ambionframework/workspace/conformance` entry holds the
`ExecutionEnv` rules the built-in tools need.** It exports
`workspaceConformance(harness)` and the `ConformanceBackend` and
`ConformanceCase` types. The cases cover a rename that replaces an
existing target, a recursive `createDir`, a forced and a recursive
`remove`, the file error codes, `~` expansion, an abort apart from a
timeout, the bounded output view with its spill file, and a distinct
temporary name under `/tmp`. The memory and directory backends run the
suite in `test/conformance.test.ts`. The just-bash adapter tests that
duplicated these rules are gone from `test/workspace.test.ts`. What stays
just-bash-specific stays adapter-only: the error-code mapping for
`canonicalPath`, `createDir`, and `remove`; `exec`'s `cwd` option and its
statelessness across calls; stderr joining stdout in one output stream;
and a temp file's prefix and suffix.

**The `sql` tool export needs only the `sqlite3` command.** The export path no
longer calls `xan` to count rows or `readTextLines` to preview them. It reads
the temporary CSV file once and scans it for RFC 4180 records: a newline
outside a quoted value ends a record, a newline inside a value stays in the
value, and a doubled quote is an escaped quote. The row count comes from this
same scan, and so does the preview, so a quoted newline no longer splits a
preview row. The tool holds the whole export in memory while it scans, so the
preview keeps a quoted newline inside its record.

**The neutral layer now owns the five default tools, and a backend adds only
its own.** `openWorkspace` builds `read`, `write`, `edit`, `bash`, and `sql`
itself, over the backend's `layout.database`, and binds them before any tool
the backend adds. `WorkspaceBackend.tools` is now optional: a backend states
only the tools it adds beyond the five defaults. `justBashTools` is gone from
`just-bash.ts`, and neither just-bash backend imports `createReadTool`,
`createWriteTool`, `createEditTool`, `createBashTool`, or `createSqlTool` any
longer, nor lists a `tools` field of its own.

**Tool guidance now has one owner for its shared part.** The neutral layer
states the five tools, the shared files, and the `sql` tool's shared
database, with `ATTACH ':memory:'`, `export`, and the SQLite dialect. A
just-bash backend's own guidance now states only its shell: the coreutils,
`jq`, `yq`, `xan`, and `sqlite3`, `js-exec` and `python3`, no network, and no
wall between one agent's home and another's. `openWorkspace` joins the tool
guidance, the backend's shell guidance, the audit guidance, and the rooms
guidance, in that order.

**The assistant's instructions no longer repeat the summary duties.** The
room renders the summary duties into every closing activation. The
assistant's summary defaults now add only evidence, artifact paths,
constraints, unfinished work, and the verification rules.

**A failed draft from another seat no longer counts against the summary
writer.** The fold counted every closing lease at a close's boundary as an
attempt of the writer, whatever its seat. A journal that held another seat's
failed draft moved the writer's next id and could abandon the summary before
the writer tried. The kernel writes no such journal itself. The new verified
rule `draftsClose` decides which leases draft a close, for the attempt count
and for the summary verdict.

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
