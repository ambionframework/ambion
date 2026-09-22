# Changelog

## Unreleased

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
gone from the root. `mirror.ts` still exports the first two for the
package's own tests.

**A new `@ambionframework/workspace/conformance` entry holds the
`ExecutionEnv` rules the built-in tools need.** It exports
`workspaceConformance(harness)` and the `ConformanceBackend` and
`ConformanceCase` types. The cases cover a rename that replaces an
existing target, a recursive `createDir`, a forced and a recursive
`remove`, the file error codes, `~` expansion, an abort apart from a
timeout, the bounded output view with its spill file, and a distinct
temporary name under `/tmp`. The memory and directory backends run the
suite in `test/conformance.test.ts`. The adapter tests that duplicated
these rules are gone from `test/workspace.test.ts`.

**The `sql` tool export needs only the `sqlite3` command.** The export path no
longer calls `xan` to count rows or `readTextLines` to preview them. It reads
the temporary CSV file once and scans it for RFC 4180 records: a newline
outside a quoted value ends a record, a newline inside a value stays in the
value, and a doubled quote is an escaped quote. The row count comes from this
same scan, and so does the preview, so a quoted newline no longer splits a
preview row.

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
