# The workspace

**The workspace is the just-bash and Pi binding of the resource
contract.** The optional `@ambionframework/workspace` package provides a
workspace resource and its filesystem. A workspace has one bash backend
and can have one SQL backend
([Query the shared database](#query-the-shared-database)). Agents receive access through
ordinary tool bundles. Workspace files remain separate from the
collaboration journal. [Resources](resources.md) states the contract, the
SQL binding, and the rules for references and provenance.

## Open one resource

```ts
import { openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/workspace/just-bash';

const drive = openWorkspace({ name: 'team-site', backend: { bash: memoryBackend() } });
```

`openWorkspace` returns one owner for a backend and its data. A host creates
one owner for each shared filesystem it intends agents to share. The package
does not coordinate separate owners or processes.

The owner serializes complete operations. Each `use` call checks revocation,
opens a fresh backend environment for its agent, runs the operation, and
cleans up the environment in `finally`.

```ts
await drive.use(
  agent,
  async (env) => {
    const result = await env.writeFile('/home/surveyor/notes.txt', 'Checked the plan.');
    if (!result.ok) throw result.error;
  },
  signal,
);
```

The resource checks revocation before it connects. A queued operation that
starts after disposal is refused.

## The layout and the host identity

**A `BashBackend` names a `layout`: where it keeps the audit log and the
room mirrors.** `WorkspaceLayout` holds two paths:

| Field   | Names the default for                                    |
| ------- | -------------------------------------------------------- |
| `audit` | `openWorkspace`'s `audit` option, when it sets no `path` |
| `rooms` | `mirror()`, the root every room's record writes under    |

A caller's own `audit.path` on `openWorkspace` wins over the layout's
default. `memoryBackend` and `directoryBackend` name the same layout:
`/workspace/audit.jsonl` and `/rooms`. A new backend states its own layout;
nothing in the neutral layer fixes a path of its own.

**`openWorkspace` builds one host agent, `<name>-host`, and `mirror()`
writes as it.** `Workspace.host` exposes this identity. A backend with real
accounts gives it credentials, the same as any other agent it connects.

```ts
const drive = openWorkspace({ name: 'town', backend: { bash: memoryBackend() } });
console.log(drive.host); // { name: 'town-host' }
```

## Give the resource to an agent

`workspace.tools()` returns an ordinary Ambion `ToolBundle`. The neutral layer
binds four file tools first: `read`, `write`, `edit`, and `bash`. A workspace
with a SQL backend adds `sql`
([Query the shared database](#query-the-shared-database)). A workspace with
no SQL backend has no `sql` tool. The bash backend then adds its own tools,
and its own guidance about its own shell, if it has any. The bundle binds every tool through the resource owner and
keeps one stable identity. Pass the bundle in an agent's `bundles` field.

```ts
import { defineAgent, defineTool } from '@ambionframework/ambion';

const surveyor = defineAgent({
  name: 'surveyor',
  identity: 'Quantity surveyor. Holds the tonnage.',
  executor: pi({
    instructions: 'Read the pour plan before you answer.',
    model: 'anthropic/claude-sonnet-5',
    bundles: [drive.tools()],
  }),
});
```

The core flattens bundles when it defines the agent. Bundle guidance is
included for every activation. The `tools` field accepts ordinary typed
Ambion tools. Every activation also receives the room's `say`, `seat`, and
`unseat` tools.

Custom tools close over the resource. They select the calling agent and pass
the call signal to `use`.

```ts
import { Type } from 'typebox';

const readPlan = defineTool({
  name: 'read_plan',
  description: 'Read the current pour plan.',
  parameters: Type.Object({}),
  execute: async (_params, ctx) =>
    drive.use(
      ctx.agent,
      async (env) => {
        const result = await env.readTextFile('/home/surveyor/pour-plan.md');
        if (!result.ok) throw result.error;
        return result.value;
      },
      ctx.signal,
    ),
});
```

`ToolContext` contains `agent`, `signal`, `callId`, `onUpdate`, `room`,
`activation`, and `exchange`. `room` names the room the call ran in and
`activation` names the activation. Both are absent for a call made outside
a room.

`exchange` holds the `owner` and `from` of the exchange that was open when
the activation read the record. It is absent when no exchange was open. The
executor builds the context once per call and freezes it. `ToolContext` holds no
workspace or resource field.

## Write an append-only log

**`openLog` writes JSON Lines to one absolute path, and rotates it by
size.** `append` writes one JSON-compatible record as one line over a
caller's `env`, then rotates the file once it has reached the byte
threshold: the active file is renamed aside under a timestamped name, and a
fresh file starts at the same path. A record is never split by a rotation.

```ts
import { BACKGROUND_CONTEXT, openLog, openWorkspace } from '@ambionframework/workspace';
import { directoryBackend } from '@ambionframework/workspace/just-bash';

const drive = openWorkspace({ name: 'town', backend: { bash: directoryBackend('./data') } });
const host = { name: 'host' };
const journal = openLog({ path: '/var/log/room/journal.jsonl' });

await drive.use(host, (env) =>
  journal.append(env, { kind: 'said', text: 'hi' }, BACKGROUND_CONTEXT),
);
```

**A log names one absolute path, not a directory.** `path` must be
absolute: a relative path would resolve against whichever agent's home
connects first, splitting the log one way for that agent and another way
for every other. A caller scopes two logs apart by giving them two paths; a
room's full record, an audit trail, and a metrics feed each open one log at
its own path, over one shared workspace, with no collision.

**A log carries no state of its own.** `openLog` does no I/O and holds no
count: every fact rotation needs — whether the active file exists, and how
large it is — comes from the path on the caller's `env` at the time of the
call. Opening a log again after a restart, or opening a second handle to the
same path, needs no recovery step, because there is nothing to recover.

**`rotateBytes` sets the byte threshold, and the default is 8 MiB.**
Rotation runs after a write, never before: the record that first pushes the
file past the threshold stays in the file it landed in, and the next record
starts the fresh one. A log does not delete a rotated file; a host that
wants retention lists the directory and prunes its own way.

**`append` must run one call at a time over one log.** Concurrent calls
racing the same rotation decision could both decide to rotate, or neither.
A caller inside `resource.use()` gets serialization for free from the
owner's queue (see [Open one resource](#open-one-resource)); a caller
holding `env` directly serializes its own calls.

## Record every tool call

**`openWorkspace` can record every bound tool call to a rotating JSONL file
on the workspace's own filesystem, built on `openLog`.** Set `audit`, and
every call through `workspace.tools()` appends one line: the room, the
agent, the tool, the activation and the exchange it ran in, the full
arguments, and the full result or error. An image the result carries keeps
its shape, with its byte count in place of its data: the log records that
the call returned a picture, not the picture (`loggedToolResult`, from
`@ambionframework/ambion`).

```ts
const drive = openWorkspace({
  name: 'team-site',
  backend: { bash: memoryBackend() },
  audit: {},
});
```

**The log is an ordinary file an agent reads.** The default path is the
backend's `layout.audit`. Set `path` to open it somewhere else, and
`maxBytes` to change the 5 MiB rotation threshold. An agent reads the log
with `read` or `bash cat`, the same as any file a peer wrote, and sees every
call any agent in any room made, including its own past calls. `jq` filters
one entry out of many, by `room`, `tool`, `agent`, or `activation`.

**Tool guidance tells every agent the log exists.** `openWorkspace` appends
a note naming the path and what each line holds to the bundle's guidance, so
an agent that reads its own tool guidance already knows to look for it.

**Recording one entry runs inside the tool call's own queued operation.**
The workspace resource lets one operation touch the filesystem at a time
(see [Open one resource](#open-one-resource)), and the audit write shares
the same `ExecutionEnv` as the call it records. The entry and the call never
separate under concurrent work from other agents, and this is also what
serializes the log's own rotation decision.

**A cut or aborted call is still recorded.** The record runs after the call
ends, whatever ended it, over its own unconditional context. It does not
depend on the caller's abort signal. A room that cuts an activation mid-call
still leaves a trace of what that call was doing.

**An entry too large for the backend to hold falls back to a short notice.**
A `write` call whose content the filesystem has no room for still leaves one
line naming the call and the failure, in place of the full entry.

**A write or rotation failure calls `onError`.** The tool call itself keeps
its own result. The log is best-effort: a full disk delays the record. It
does not delay the agent. A throwing `onError` callback is caught inside the
log, so it never reaches the tool call's own outcome.

**Only a call through `workspace.tools()` is recorded.** A direct
`workspace.use` call reaches the backend with no entry. It is host code, and
the guidance the log describes speaks to the model alone.

**The log shares the workspace's boundary.** just-bash gives no wall between
one agent's home and another's (see [Backends and limits](#backends-and-limits)),
and the log is no exception: any agent's `bash` or `write` call can alter or
remove it, the same as any other file on the workspace.

## Mirror a room's messages

**`workspace.mirror(room)` mirrors one room's message record to
`<layout.rooms>/<room name>/messages.jsonl`, built on `openLog`.** The
just-bash backends name `layout.rooms` `/rooms`. Call it once the room has
started; it needs no other setup.

```ts
import { startRoom } from '@ambionframework/ambion';
import { openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/workspace/just-bash';

const site = openWorkspace({ name: 'town', backend: { bash: memoryBackend() } });
const session = await startRoom({ name: 'lobby', agents: [/* ... */] });

const mirror = await site.mirror(session);
// later, on shutdown:
await session.stop();
await mirror.stop();
```

`mirror()` writes as `workspace.host`, the `<name>-host` agent `openWorkspace`
built (see [The layout and the host identity](#the-layout-and-the-host-identity)),
so a caller names only the room. Stop the room before the mirror. The room's
own shutdown commits a `left` message for every present visitor; a mirror
already stopped never sees it.

**`await site.mirror(room)` returns once recovery is caught up, not once
every message is durably on disk.** Its promise resolves after the
backfill has queued every past message for the workspace to write. The
writes themselves still run on the workspace's own queue; `mirror.stop()`
is what waits for the last of them to land.

**One line per message, in the room's own order.** Every line is the
room's own `Message` type — `said`, `arrived`, `left`, `seated`, `unseated`,
or `summary` — plus `room`, the room's name. Every kind also carries `at`,
an ISO timestamp the runtime stamps when the message lands:

| `kind`                                  | Fields beyond `room`, `kind`, `seq`, `at`           |
| --------------------------------------- | --------------------------------------------------- |
| `said`                                  | `from`, `to` (absent for a broadcast), `text`       |
| `arrived`, `left`, `seated`, `unseated` | `subject`, and `identity` on `arrived` and `seated` |
| `summary`                               | `from`, `to`, `text`, `covers: { from, through }`   |

An agent reads its own room's file with `read` or `bash cat`, the same as
any file a peer wrote.

**Every line carries the `seq` a message ref names.** A ref of the form
`ambion://room/<name>/message/<seq>` (see [agent.md](agent.md)) points at
the line whose `seq` field matches. An agent finds it with
`jq 'select(.seq == <seq>)'`; it never needs to fetch or parse the URI to
do it. `jq` filters on `kind` or `from` the same way.

**The mirror holds more messages than one activation's context.** A seat's
context window can trim older messages, through `limits.context.messages`,
or fold a closed exchange into one summary line. A message missing from
context this activation still has its own line in `messages.jsonl`. Find
it by `seq`.

**This is a secondary, best-effort copy.** `packages/journal` remains the
source of truth for the room. A write failure calls `onError` and the room
keeps running; a gap is possible, and not retried.

**Recovery needs no cursor of its own.** `mirror()` subscribes to the room
before it reads, then backfills from the highest `seq` already on disk —
the same recipe [durability](durability.md) gives any external reader. A
message the subscription sees while that backfill is still in flight is
held, not written early: writing it first would mark it accounted for, and
the backfill would then skip it as already written. A restart neither
misses a message nor writes one twice; a message seen from both the live
subscription and the backfill is written once.

**A room's name is not validated at the kernel today.** This is the first
place a room name turns into a filesystem path. A name holding `..` or an
extra `/` would resolve outside `layout.rooms`; `mirror()` refuses that name
and writes nothing.

**Every workspace's guidance names the room-mirror convention, whether or
not anything mirrors there.** The note is generic — it names no room — so
it costs nothing to state unconditionally, the same way an agent already
learns its `/home/<name>` convention. An agent finds the field guide above
by reading a room's own file; the guidance only points at the path, and
names the backend's actual `layout.rooms`.

**Directory-per-room organizes the data; it does not wall it off.** Every
room sharing one workspace shares its filesystem boundary (see
[Backends and limits](#backends-and-limits)). An agent seated in one room
reads another room's `messages.jsonl` the same way, with the same `seq`
and `jq` filter it uses on its own.

## Query the shared database

**A workspace has one bash backend, and it can have one SQL backend.**
The `backend` option holds the backends by kind, as `WorkspaceBackends`.
`backend.bash` is a `BashBackend`, and every workspace has one.
`backend.sql` is an optional `SqlBackend`: a shared database that need not
live on the shell's filesystem. A later kind of backend gets its own key.
With no SQL backend, the workspace has no `sql` tool.

**`sqliteBackend` from `@ambionframework/workspace/sqlite` is the default
SQL backend.** It opens one SQLite database through `node:sqlite`, at a
host path or at `:memory:`. The file lives beside the bash backend's
filesystem, so the shell does not reach it. The first call creates the
file and its directory. `dispose()` closes the database and keeps the file.

```ts
import { openWorkspace } from '@ambionframework/workspace';
import { directoryBackend } from '@ambionframework/workspace/just-bash';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';

const lab = openWorkspace({
  name: 'lab',
  backend: { bash: directoryBackend('./data/lab'), sql: sqliteBackend('./data/lab.db') },
});
```

**The `sql` tool runs statements on the shared database.** Every agent
queries this one database, so a table or a view one agent creates is data
another agent reads at once. The tool takes these parameters:

| Parameter | Meaning                                                         |
| --------- | --------------------------------------------------------------- |
| `sql`     | One or more statements. The last query gives the preview.       |
| `export`  | A path in the workspace for the full result as CSV.             |
| `maxRows` | How many rows the preview shows, up to 1000. The default is 50. |

**The preview stays in context and writes nothing to disk.** The tool shows
the last query's result as a Markdown table, capped at `maxRows`. It keeps
the data in the database. An agent reads the result and continues. A
statement that the database refuses comes back as text that names the
database, so the agent can correct it.

**Share through a table or a view.** The data stays in the shared database, so
no agent copies a file. A view holds its own query and reflects the current
tables. `sqlite_master` holds each view's definition, so an agent reads how a
shared view was built before the agent trusts its data. Prefer a view or a
table for every hand-off between agents.

**`export` writes the full result into the shell's filesystem, and the
tool returns a preview.** Set it when a script or another tool needs the
rows. The SQL backend streams every row as CSV to the calling agent's
files through `WorkspaceFiles`, and gives back the first `maxRows` rows and
the row count. The tool shows the head of the file. A failed query leaves
an existing file unchanged. A NULL value reads as `\N`, and a blob reads
as hex.

**A result never enters memory whole.** The backend keeps the first
`maxRows` rows and counts the rest. An export streams in chunks.

### The SQLite backend

- **The dialect is SQLite.** Dates are functions, `||` joins text, and a
  column type is an affinity. The backend's guidance states this.
- **`ATTACH` opens `:memory:` alone.** A private scratch database lives for
  one call, and one statement joins it with the shared tables. After each
  call the backend detaches every attached database, so no other call reads
  it. SQLite reads `:memory:` in lower case alone, so the backend compares
  it exactly.
- **No statement opens another host file.** The backend refuses an
  `ATTACH` of anything but `':memory:'` and a `VACUUM INTO`, and runs no
  later statement of the call. A check of each statement's text holds on
  every supported Node, and skips what SQLite skips: whitespace, comments,
  an empty `;`, and a comment that runs to the end. SQL that holds a NUL
  character gives an `ok: false` outcome. A Node whose `node:sqlite` has `setAuthorizer` also
  refuses an `ATTACH` in the engine. `node:sqlite` loads no extension.
- **A call commits its own transaction.** Every agent shares one handle. A
  call that leaves a transaction open gets it rolled back and an `ok: false`
  outcome, so no write from a later call lands inside it.
- **A result keeps one value per column name.** A last statement with two
  columns of one name gives an `ok: false` outcome that asks for `AS`.
- **A call stops between statements and between rows.** `sqlResult` yields
  to the event loop every 256 rows, so an abort and the time limit can
  fire, and other rooms keep running. A call stops after 30 seconds; set
  `timeout` in `sqliteBackend(location, { timeout })` to change it, to a
  value above 0 and at most 2147483. A timeout is an `ok: false` outcome,
  and an abort rejects. A stopped export removes its temporary file and
  leaves the target unchanged.
- **One statement that gives no rows runs to its end.** `node:sqlite` has no
  hook to stop a statement, so the backend cannot stop such a statement
  early. For example, an aggregate over an unbounded recursive query does
  not return.

### The SqlBackend interface

**`SqlBackend` holds four members, and `SqlEnv` holds two.** A new SQL
backend, such as a database server with one account for each agent,
implements them.

| Member                              | Meaning                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `connect(agent, files, signal?)`    | An `SqlEnv` for one agent. A backend with accounts connects as it      |
| `dispose()`                         | Optional. Release local handles, and keep the data                     |
| `database`                          | The name the tool reports and the guidance states, with no credential  |
| `guidance`                          | Optional. The dialect and the limits of the database                   |
| `SqlEnv.run(sql, options, context)` | Run the statements in order, and give a preview of the last one's rows |
| `SqlEnv.cleanup()`                  | The owner calls it after each operation                                |

**`files` is the agent's view of the bash backend.** `WorkspaceFiles` has
one method, `writeFile(path, chunks, context)`. It resolves `~` and a
relative path under the agent's home, creates missing directories, and
writes the chunks to a temporary file that it then renames onto `path`. It
gives the absolute path. Each call is one operation on the bash owner, as
the calling agent.

**`run` takes `maxRows` and an optional `export` path.** An `ok` outcome
holds the last statement's `columns`, its first `maxRows` rows, its
`rowCount`, and the absolute `export` path when the options named one. A
statement that the database or the backend refuses gives
`{ ok: false, message }`, and the run stops there. A call past the
backend's time limit gives the same. A fault of the connection or of
`WorkspaceFiles`, and an abort by the caller, reject.

**`sqlResult` does the preview, the count, and the export for a backend.**
The root entry exports it. A backend passes the last statement's columns,
a row iterator, the options, and `files`. It reads the rows once, and
streams the CSV to `files` in chunks. A backend with a native export writes
through `files` itself.

**Each backend gets its own resource owner.** A long `bash` command does
not delay a query. `workspace.use` and `mirror()` reach the bash owner.
`workspace.sql` is the SQL owner, for host code.

**A SQL operation may wait on the bash owner, and a bash operation never
waits on the SQL owner.** An export waits for the running shell operation
to end. Do not await `workspace.sql.use` inside a callback of
`workspace.use`: that callback holds the bash owner. `dispose()` disposes
the SQL owner first, so an export in progress still reaches the bash
owner, and then the bash owner.

**Two owners give no total order across the backends.** Each owner orders
its own operations. A `bash` call and a `sql` call from two agents can
finish in either order.

**The audit log stays on the shell's filesystem.** The entry of a `sql`
call is one more operation on the bash owner after the call ends. It runs
over its own unconditional context, so a cut call still leaves its entry.
Another operation on the bash owner can run between the call and its
entry.

**A new SQL backend passes `sqlConformance`** (see
[The conformance suite](#the-conformance-suite)).

## The resource contract

The contract lives in [Resources](resources.md).

The memory and directory backends are the Pi binding. They export from the
`./just-bash` entry. The root entry names `WorkspaceEnv`, the Pi
`ExecutionEnv` that has a zero-argument `cleanup()`. `BashBackend`
extends `ResourceBackend<WorkspaceEnv>` and adds optional Pi harness tools
beyond the four file tools, optional guidance about the backend's own shell,
and a required `layout` (see
[The layout and the host identity](#the-layout-and-the-host-identity)).
`openWorkspace` creates the resource owner, builds the four file tools, and
binds them, and any tool the backend adds, to its `use` method. `Workspace` adds `tools()`, `host`, and `mirror()` to the
resource surface. Direct operations and tool calls share one queue and one
lifecycle.

**A new backend implements `connect()` and an `ExecutionEnv`, over the
shared helpers below, and names its own `layout`.** It adds only the tools
and the guidance beyond the four file tools, passes
`@ambionframework/workspace/conformance`, and loads no just-bash.

**The root entry also exports the environment helpers a new `ExecutionEnv`
backend needs.** `resolvePath` holds the `~` and relative path rule.
`Deadline` tells an abort apart from a timeout. `boundedView` and `spill`
build the bounded output view and its spill file, `spill` over a minimal
writer of one `mkdir` plus one `writeFile`. `TMP`, `randomName`,
`tempDirPath`, `tempFilePath`, and `spillPath` name the temporary paths
under `/tmp`. These helpers import no just-bash, so a backend over any
filesystem builds an `ExecutionEnv` on them.

## The conformance suite

`@ambionframework/workspace/conformance` holds the `ExecutionEnv` rules the
built-in tools need: a rename that replaces an existing target, a recursive
`createDir`, a forced and a recursive `remove`, the file error codes, `~`
expansion, an abort apart from a timeout, the bounded output view with its
spill file, and a distinct name under `/tmp` for each temporary file or
directory.

A case is a `ConformanceCase`: a name and a `run` that throws on failure.
The entry loads no test framework and no just-bash, so any backend runs it.
`workspaceConformance(harness)` takes a named backend with an `open()` that
returns a fresh `BashBackend` and a `dispose()`, and returns the cases:

```ts
import { workspaceConformance } from '@ambionframework/workspace/conformance';
import { describe, it } from 'vitest';

describe.each(backends)('$name', (harness) => {
  for (const c of workspaceConformance(harness)) it(c.name, c.run);
});
```

The memory and directory backends run the suite first
(`packages/workspace/test/conformance.test.ts`). A new backend runs it
before it takes on tool-specific tests of its own.

**`sqlConformance(harness)` holds the cases of a `SqlBackend`.** The
harness has the same shape, with an `open()` that returns a fresh
`SqlBackend`. The cases check the rows of the last statement, NULL as
`null`, a last statement with no result, a refused statement as an
outcome that stops the run, one database for every agent, and an abort
before the first statement. A test backend over `node:sqlite` runs them
(`packages/workspace/test/sql-backend.test.ts`).

## Dispose of a resource

```ts
await drive.dispose();
```

Disposal immediately revokes new and queued work. It waits for an active
operation and its cleanup, then asks the backend to release its local
handles once. Concurrent calls join that release. A successful disposal is
terminal. A failed disposal leaves the resource active and retryable.

Disposal keeps the persisted workspace. A directory resource keeps its
files, and an in-memory resource releases its cached filesystem. A host
deletes the data that it owns.

A `use` callback must not await another `use` or `dispose` call on the same
owner. The owner serializes those operations, so such nesting would wait
for the callback that is already running.

## Backends and limits

`memoryBackend()` keeps files in process. Its optional seed writes files
before the first use, and `readFiles()` supports host inspection. Disposal
releases its cached filesystem, so a disposed resource does not recreate a
seeded filesystem.

`directoryBackend(root)` operates on a real directory. It creates the root
when a backend operation needs it. Disposal releases the filesystem handle
and keeps the root directory and its files.

Both backends use just-bash. They provide a virtual Unix filesystem and shell
for tools, with JavaScript and Python execution available. Network commands
are absent. just-bash is single-user: agents sharing one resource can read
each other's homes. The default workspace does not provide operating-system isolation between
agents or distributed ownership of a shared directory. Hosts own credentials
and authorization for external services.

Backends perform raw filesystem I/O below the owner. They do not keep a
second operation queue.

**A new backend follows one recipe.** It implements `connect()` and an
`ExecutionEnv` over the shared helpers (see [The resource
contract](#the-resource-contract)), names its own `layout`, and adds only
the tools and the shell guidance beyond the four file tools every workspace
already has. It passes `@ambionframework/workspace/conformance` and loads
no just-bash.

### The null device

**`/dev/null` discards writes and reads empty on both backends.** A
redirect to it, and a `write` tool call on it, change nothing. The device
lives in a layer above the filesystem, so the directory backend writes no
`dev` entry under its root and the memory backend holds no `/dev` file.

**The standard devices are present on both backends.** `/dev/zero`,
`/dev/stdin`, `/dev/stdout`, `/dev/stderr` and `/dev/fd` exist and read
empty. `/dev/zero` does not stream bytes. `ls /dev` lists the same names on
each backend.
