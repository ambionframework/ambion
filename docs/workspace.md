# The workspace

**The workspace is the just-bash and Pi binding of the resource
contract.** The optional `@ambionframework/workspace` package provides a
workspace resource and its filesystem. Agents receive access through
ordinary tool bundles. Workspace files remain separate from the
collaboration journal. [Resources](resources.md) states the contract, the
SQL binding, and the rules for references and provenance.

## Open one resource

```ts
import { openWorkspace, memoryBackend } from '@ambionframework/workspace';

const drive = openWorkspace({ name: 'team-site', backend: memoryBackend() });
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

## Give the resource to an agent

`workspace.tools()` returns an ordinary Ambion `ToolBundle`. A backend supplies
its tools and optional guidance. The bundle binds each backend tool through
the resource owner and keeps one stable identity. Pass the bundle in an
agent's `bundles` field.

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
import {
  BACKGROUND_CONTEXT,
  directoryBackend,
  openLog,
  openWorkspace,
} from '@ambionframework/workspace';

const drive = openWorkspace({ name: 'town', backend: directoryBackend('./data') });
const host = { name: 'host', identity: 'Writes the room record.' };
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
  backend: memoryBackend(),
  audit: {},
});
```

**The log is an ordinary file an agent reads.** The default path is
`/workspace/audit.jsonl`; set `path` to change it, and `maxBytes` to change
the 5 MiB rotation threshold. An agent reads the log with `read` or
`bash cat`, the same as any file a peer wrote, and sees every call any
agent in any room made, including its own past calls. `jq` filters one
entry out of many, by `room`, `tool`, `agent`, or `activation`.

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

## Record what changed

**`openWorkspace` can keep a change log, and `workspace.changes` answers
what changed during one exchange.** Set `changes`. Each successful `write`
or `edit` call through `workspace.tools()` appends one line to
`/workspace/changes.jsonl`: the paths, the agent, the tool, the activation,
and the exchange. `path` and `maxBytes` work as they do for `audit`.

```ts
const drive = openWorkspace({ name: 'team-site', backend: memoryBackend(), changes: {} });
const changes = await drive.changes({ exchange: { owner: 'andrei', from: 4 } });
```

**`changes` returns the entries of one exchange, oldest first.** An entry
matches when its `exchange.owner` and `exchange.from` equal the query. A call
made outside an exchange never matches. `changes` returns `[]` when the
workspace has no `changes` option. The read includes rotated files.

**The backend names the changed paths.** A `WorkspaceBackend` may supply
`changedPaths`. The just-bash backends name the resolved path of a `write` or
an `edit` call. The neutral resource contract has no part in it.

**Only `write` and `edit` leave a change.** A `bash` call changes files
through a shell the workspace cannot inspect, including `js-exec`,
`python3`, redirects, `mv`, and `rm`. A `sql` call changes rows. None of
them appears in the change log in 0.1.0.

**A failed call leaves no change.** The audit log records the failure. The
change log records the call only after it succeeds. A cut activation still
leaves the change of a call that finished, because the record runs over its
own unconditional context.

**The change log is best-effort.** It is not a journal transaction. A crash
between the filesystem change and the log append drops the entry, so the log
can lag the files. A write failure calls `onError` and does not fail the tool
call. The room's journal stays the record.

## Mirror a room's messages

**`workspace.mirror(room)` mirrors one room's message record to
`/rooms/<room name>/messages.jsonl`, built on `openLog`.** Call it once the
room has started; it needs no other setup.

```ts
import { memoryBackend, openWorkspace } from '@ambionframework/workspace';
import { startRoom } from '@ambionframework/ambion';

const site = openWorkspace({ name: 'town', backend: memoryBackend() });
const session = await startRoom({ name: 'lobby', agents: [/* ... */] });

const mirror = await site.mirror(session);
// later, on shutdown:
await session.stop();
await mirror.stop();
```

`mirror()` writes as an identity the workspace owns; a caller names only the
room. Stop the room before the mirror. The room's own shutdown commits a
`left` message for every present visitor; a mirror already stopped never
sees it.

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
extra `/` would resolve outside `/rooms`; `mirror()` refuses that name and
writes nothing.

**Every workspace's guidance names the `/rooms` convention, whether or not
anything mirrors there.** The note is generic — it names no room — so it
costs nothing to state unconditionally, the same way an agent already
learns its `/home/<name>` convention. An agent finds the field guide above
by reading a room's own file; the guidance only points at the path.

**Directory-per-room organizes the data; it does not wall it off.** Every
room sharing one workspace shares its filesystem boundary (see
[Backends and limits](#backends-and-limits)). An agent seated in one room
reads another room's `messages.jsonl` the same way, with the same `seq`
and `jq` filter it uses on its own.

## Query the shared database

**The `sql` tool runs SQLite statements on one shared database.** The default
backends open the database at `/workspace/shared.db`. Every agent queries this
one file, so a table or a view one agent creates is data another agent reads
at once. The tool takes these parameters:

| Parameter  | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| `sql`      | One or more SQLite statements. The last query gives the preview. |
| `database` | The file opened as `main`. The default is the shared database.   |
| `export`   | A path for the full result as CSV. Omit it to write no file.     |
| `maxRows`  | How many rows the preview shows. The default is 50.              |
| `timeout`  | Seconds before the query stops.                                  |

**The preview stays in context and writes nothing to disk.** The tool shows
the last query's result as a Markdown table, capped at `maxRows`. It keeps the
data in the database. An agent reads the result and continues.

**Share through a table or a view.** The data stays in the shared database, so
no agent copies a file. A view holds its own query and reflects the current
tables. `sqlite_master` holds each view's definition, so an agent reads how a
shared view was built before the agent trusts its data. Prefer a view or a
table for every hand-off between agents.

**The resource owner serializes every write.** The owner runs one operation at
a time (see the queue above), so writes to the shared database take a total
order and one write never overwrites another.

**Attach a private scratch database with `ATTACH ':memory:'`.** The scratch
database lives for one call. A single statement joins the shared tables with
the scratch tables. For data an agent keeps across calls, set `database` to a
private file; the tool opens that file as `main`.

**Export only for a reader outside SQL.** Set `export` when a script or another
tool needs the rows. The tool writes the full result as CSV to that path and
shows the file's head. A NULL value reads as `\N`, so a NULL stays apart from
an empty string.

### just-bash as one implementation

The `sql` contract holds over any backend that supplies a `sqlite3` command.
just-bash is the default implementation, and it has these specific behaviors:

- **It loads the main database into a WebAssembly engine and writes the file
  back after each call.** The owner's serialization keeps this write-back safe:
  two calls never overlap, so no call loses another's write.
- **`ATTACH` opens `:memory:` only.** The engine has no bridge to the virtual
  filesystem, so `ATTACH` of a second file fails to open it. A cross-file join
  is not available; a cross-database join uses a `:memory:` scratch database.
- **CSV is the bridge to `python3`.** The just-bash `python3` has no `sqlite3`
  module, so a Python script reads an exported CSV file.
- **The tool passes command-line flags.** just-bash `sqlite3` reads flags such
  as `-json` and `-csv`. It does not read dot-commands such as `.mode`.
- **The dialect is SQLite.** Dates are functions, `||` joins text, and a column
  type is an affinity.

## The resource contract

The contract lives in [Resources](resources.md).

The memory and directory backends are the Pi binding. They export from the
root entry, with `WorkspaceEnv`, the Pi `ExecutionEnv` that has a zero-argument
`cleanup()`. `WorkspaceBackend` extends `ResourceBackend<WorkspaceEnv>` and
adds Pi harness tools and optional guidance. `openWorkspace` creates the
resource owner and binds the backend tools to its `use` method. `Workspace`
adds `tools()` to the resource surface. Direct operations and tool calls share
one queue and one lifecycle.

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

Backends perform raw filesystem I/O below the owner. They do not maintain a
second destruction mark or a second operation queue.

### The null device

**`/dev/null` discards writes and reads empty on both backends.** A
redirect to it, and a `write` tool call on it, change nothing. The device
lives in a layer above the filesystem, so the directory backend writes no
`dev` entry under its root and the memory backend holds no `/dev` file.

**The standard devices are present on both backends.** `/dev/zero`,
`/dev/stdin`, `/dev/stdout`, `/dev/stderr` and `/dev/fd` exist and read
empty. `/dev/zero` does not stream bytes. `ls /dev` lists the same names on
each backend.
