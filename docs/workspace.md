# The workspace

**Applications own domain data and tool resources.** The optional
`@ambionframework/workspace` package provides a workspace resource and its
filesystem. Agents receive access through ordinary tool bundles. Workspace
files remain separate from the collaboration journal.

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
starts after destruction is refused.

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
  instructions: 'Read the pour plan before you answer.',
  model: 'anthropic/claude-sonnet-5',
  bundles: [drive.tools()],
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

`ToolContext` contains `agent`, `signal`, `callId`, `onUpdate`, and `room`.
`room` names the room the call ran in; it is absent for a call made outside
a room. `ToolContext` holds no workspace or resource field.

## Record every tool call

**`openWorkspace` can record every bound tool call to a rotating JSONL file
on the workspace's own filesystem.** Set `audit`, and every call through
`workspace.tools()` appends one line: the room, the agent, the tool, the
full arguments, and the full result or error.

```ts
const drive = openWorkspace({
  name: 'team-site',
  backend: memoryBackend(),
  audit: {},
});
```

**The log is an ordinary file an agent reads.** The default path is
`/workspace/audit.jsonl`; set `path` to change it. `path` must be absolute:
a relative path would resolve against whichever agent's home connects
first, splitting the log one way for that agent and another way for every
other. An agent reads the log with `read` or `bash cat`, the same as any
file a peer wrote, and sees every call any agent made, including its own
past calls.

**Tool guidance tells every agent the log exists.** `openWorkspace` appends
a note naming the path and what each line holds to the bundle's guidance, so
an agent that reads its own tool guidance already knows to look for it.

**A file rotates once it reaches `maxBytes`.** The default is 5 MiB
(5 &times; 1024 &times; 1024 bytes). A rotated file keeps its old lines under
a timestamped name beside the active file. The active file starts empty at
the same path.

**Recording one entry runs inside the tool call's own queued operation.**
The workspace resource lets one operation touch the filesystem at a time
(see [Open one resource](#open-one-resource)), and the audit write shares
the same `ExecutionEnv` as the call it records. The entry and the call never
separate under concurrent work from other agents.

**A cut or aborted call is still recorded.** The record runs after the call
ends, whatever ended it, over its own unconditional context rather than the
caller's abort signal. A room that cuts an activation mid-call still leaves
a trace of what that call was doing.

**An entry too large for the backend to hold falls back to a short notice.**
A `write` call whose content the filesystem has no room for still leaves one
line naming the call and the failure, in place of the full entry, instead of
leaving no trace at all.

**A write or rotation failure goes to `onError`, not to the tool call.** The
call that triggered the failure still returns its own result. The log is
best-effort: a full disk delays the record, not the agent. A throwing
`onError` callback is caught, and never replaces the tool call's own outcome.

**Only a call through `workspace.tools()` is recorded.** A direct
`workspace.use` call reaches the backend with no entry. It is host code, not
a tool a model called.

**The log shares the workspace's boundary.** just-bash gives no wall between
one agent's home and another's (see [Backends and limits](#backends-and-limits)),
and the log is no exception: any agent's `bash` or `write` call can alter or
remove it, the same as any other file on the workspace.

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

## Use a resource without the room runtime

`@ambionframework/workspace/resource` exports `openResource` and the same
memory and directory backends. This entry loads no Ambion runtime.

```ts
import { memoryBackend, openResource } from '@ambionframework/workspace/resource';

const drive = openResource({ name: 'team-site', backend: memoryBackend() });
await drive.use({ name: 'surveyor', identity: 'Quantity surveyor.' }, async (env) => {
  const result = await env.writeFile('notes.txt', 'Checked the plan.');
  if (!result.ok) throw result.error;
});
await drive.dispose();
```

`WorkspaceResource` exposes `name`, `use`, `dispose`, and `destroy`.
Its `ResourceBackend` needs `connect` and `destroy`; `dispose` is optional.
A custom resource backend does not need tools or model guidance.

The root `openWorkspace` function creates this same owner and binds the
backend tools to its `use` method. `WorkspaceBackend` adds Pi harness tools
and optional guidance to the resource backend contract. `Workspace` adds
`tools()` to the resource surface. Direct operations and tool calls share
one queue and one lifecycle. Existing root imports and tool bundles are unchanged.

## Destroy a resource

```ts
await drive.destroy();
```

Destruction immediately revokes new and queued work. It waits for an active
operation and its cleanup, then asks the backend to delete its data once.
Concurrent calls join that deletion. A successful deletion is terminal. A
failed deletion leaves the resource active and retryable, though the backend
can have deleted some data before it reports failure.

`dispose()` releases local resources and terminally closes the handle. A
directory resource keeps its files when it is disposed. `destroy()` during
disposal, or after disposal, is refused. `dispose()` during destruction joins
the destruction. A failed release or deletion leaves its operation retryable.

A `use` callback must not await another `use`, `dispose`, or `destroy` call
on the same owner. The owner serializes those operations, so such nesting
would wait for the callback that is already running.

## Backends and limits

`memoryBackend()` keeps files in process. Its optional seed writes files
before the first use, and `readFiles()` supports host inspection. Disposal
releases its cached filesystem, so a disposed resource does not recreate a
seeded filesystem.

`directoryBackend(root)` operates on a real directory. It creates the root
when a backend operation needs it. `destroy()` deletes its contents and
keeps the root directory.

Both backends use just-bash. They provide a virtual Unix filesystem and shell
for tools, with JavaScript and Python execution available. Network commands
are absent. just-bash is single-user: agents sharing one resource can read
each other's homes. The default workspace does not provide operating-system isolation between
agents or distributed ownership of a shared directory. Hosts own credentials
and authorization for external services.

Backends perform raw filesystem I/O below the owner. They do not maintain a
second destruction mark or a second operation queue.
