# Changelog

## Unreleased

**`openWorkspace` takes its backends by kind, and a workspace can take a
SQL backend.** The `backend` option is now `WorkspaceBackends`:
`{ bash, sql? }`. Write `backend: { bash: memoryBackend() }` where you
wrote `backend: memoryBackend()`. `WorkspaceBackend` is renamed
`BashBackend`, and `MemoryWorkspaceBackend` is renamed `MemoryBashBackend`.
`backend.sql` is an optional `SqlBackend`: a shared database that need not
live on the shell's filesystem. The root entry exports the
`WorkspaceBackends`, `SqlBackend`, `SqlEnv`, `SqlOutcome`, `SqlRow`, and
`SqlValue` types. With a SQL backend, the `sql` tool runs its statements
on that backend under an owner of its own, and takes `sql`, `export`, and
`maxRows`. `export` writes the CSV file on the shell. `Workspace.sql`
exposes the SQL owner, and `dispose()` disposes both owners. With no SQL
backend, the workspace works as before. The package ships no
`SqlBackend`.

**`./conformance` exports `sqlConformance`,** the cases every
`SqlBackend` passes.

**`SqlValue` moves from `./sql` to the root entry.** `./sql` no longer
exports the type.

**The default tool guidance states the file tools and the `sql` tool in
two paragraphs.** The first paragraph no longer says that `sql` works over
the shared files.

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
