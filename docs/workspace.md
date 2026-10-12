# The workspace

**The workspace is a resource that holds files and a shell.** The optional
`@ambionframework/workspace` package provides a workspace resource and its
tools. The package `@ambionframework/just-bash` provides the memory and
directory backends over just-bash. Agents receive access through
ordinary tool bundles. Workspace files remain separate from the
collaboration journal. [Resources](resources.md) states the resource contract,
tool bundles, and the rules for references and provenance.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/ambion-capabilities-dark.svg">
  <img alt="A room and its workspace, by capability. A room activates an agent, and the agent calls the tools of a workspace. The workspace gives an agent five capabilities: processes, optional fetch of a process, optional tables, optional repositories, and files and objects. Optional skills add macros that compose runs by name. The five share the homes and the snapshots. An opt-in audit log holds tool calls, and an opt-in room mirror holds messages. A message cites any of it with a ref. A person and the host steer the room." src="assets/ambion-capabilities.svg">
</picture>

## Open one resource

```ts
import { openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/just-bash';

const drive = openWorkspace({ name: 'team-site', backend: { bash: memoryBackend() } });
```

`openWorkspace` returns one workspace for a backend and its data. A host
creates one workspace for each shared filesystem it intends agents to share.
The package does not coordinate separate workspaces or processes.

**The `backend` option holds the backends by kind.** The type is
`WorkspaceBackends`. `backend.bash` is a `BashBackend`, and every workspace has
one. `backend.sql` is an optional `SqlBackend`: a shared database that need not
live on the filesystem of the bash backend ([SQL](sql.md)).
`backend.objects` is an optional `ObjectBackend` for the bytes of each snapshot
([Snapshots](snapshots.md#the-object-backend)). `backend.bash.git` is an
optional `GitBackend` ([Git](git.md)). The bash backend takes it as an option
of its own package, so a wrong pair is a compile error
([The contract](git.md#the-contract)).

**Each backend has its own resource.** `openWorkspace` opens a bash resource
with `WorkspaceEnv` and an object resource with `ObjectEnv` for snapshots.
It opens a SQL resource with `SqlEnv` when `backend.sql` is set, and a git
resource with `GitEnv` when `backend.bash.git` is set. The resources share
[the resource contract](resources.md#the-resource-contract). `workspace.use`
reaches the bash resource; `workspace.sql`, `workspace.objects`, and
`workspace.git` expose the others, for host code. Each resource orders its
own operations, so a `bash` call and a `sql` call from two agents can finish
in either order. A long `bash` command does not delay a query.

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

## Backends and limits

**Both deployments provide the core workspace tools.** A backend with
endpoints also provides `fetch`.

| What an agent gets             | One node: `@ambionframework/just-bash`                               | A remote server: `@ambionframework/workstation`            |
| ------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Where the files are            | In the host's memory, or in a directory on the host                  | On the server                                              |
| Isolation between agents       | None: every agent reads and writes every home                        | One Unix account for each agent, and a private home        |
| Network                        | None                                                                 | The server's network                                       |
| Commands                       | A simulated shell with a fixed set                                   | A real bash with the server's commands                     |
| Output of a running process    | Shows when the process ends                                          | Shows while the process runs                               |
| Output after cancel or timeout | The file stays empty                                                 | The file keeps the output so far                           |
| Work after a host restart      | Memory: none. Directory: the files; earlier processes read as failed | The files, and the processes that still run                |
| Repositories                   | In the host's process, with `justGitBackend`                         | In one account on the server, with `workstationGitBackend` |
| Reading a process over HTTP    | No endpoints, so no `fetch` tool and no `workspace.fetch`            | Loopback forwarding over SSH gives both                    |

`memoryBackend()` keeps files in process. Its optional seed writes files
before the first use, and `readFiles()` supports host inspection. Disposal
releases its cached filesystem, so a disposed resource does not recreate a
seeded filesystem.

`directoryBackend(root)` operates on a real directory. It creates the root
when a backend operation needs it. Disposal releases the filesystem handle
and keeps the root directory and its files.

Both backends use just-bash, and the package `@ambionframework/just-bash`
holds them. The workspace package does not depend on just-bash, so a host
that uses another backend installs no just-bash. The backends provide a
virtual Unix filesystem and shell for tools, with JavaScript and Python
execution available. Network commands are absent. Each shell also runs `git`
from just-git, with the agent's name as the locked author and no network
access. The just-bash backends give no operating-system isolation between
agents ([Trust](trust.md#what-the-kernel-does-not-defend)). Hosts own
credentials and authorization for external services.

Backends perform raw filesystem I/O below the resource. They do not keep a
second operation queue. [Build a bash backend](#build-a-bash-backend) states
the implementation requirements and the shared helpers.

### The null device

**`/dev/null` discards writes and reads empty on both backends.** A
redirect to it, and a `write` tool call on it, change nothing. The device
lives in a layer above the filesystem, so the directory backend writes no
`dev` entry under its root and the memory backend holds no `/dev` file.

**The standard devices are present on both backends.** `/dev/zero`,
`/dev/stdin`, `/dev/stdout`, `/dev/stderr` and `/dev/fd` exist and read
empty. `/dev/zero` does not stream bytes. `ls /dev` lists the same names on
each backend.

## The layout and the host identity

**A `BashBackend` names a `layout`: where it keeps the audit log, the
room mirrors, and the snapshots.** `WorkspaceLayout` holds three paths:

| Field       | Names the default for                                        |
| ----------- | ------------------------------------------------------------ |
| `audit`     | `openWorkspace`'s `audit` option, when it sets no `path`     |
| `rooms`     | `mirror()`, the root every room's record writes under        |
| `snapshots` | `snapshot()`, the folder that holds one copy for each digest |

A caller's own `audit.path` on `openWorkspace` wins over the layout's
default. `memoryBackend` and `directoryBackend` name the same layout:
`/workspace/audit.jsonl`, `/rooms`, and `/snapshots`. A new backend states
its own layout; nothing in the neutral layer fixes a path of its own.

**`openWorkspace` builds one host agent, `<name>-host`, and `mirror()` and
`snapshot()` write as it.** `Workspace.mirrorAgent` exposes this identity. A
backend with real accounts gives it credentials, the same as any other agent
it connects.

```ts
const drive = openWorkspace({ name: 'town', backend: { bash: memoryBackend() } });
console.log(drive.mirrorAgent); // { name: 'town-host' }
```

## Give the resource to an agent

**`workspace.tools()` returns an ordinary Ambion `ToolBundle`.** Pass it in an
executor's `bundles` field ([Tool bundles](resources.md#tool-bundles)). The
bundle keeps one stable identity. It holds the tools of this table and the
guidance of the bash backend about its own shell, if it has any.

| Tools                                  | Present                          | Page                                                    |
| -------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| `read`, `write`, `edit`, `apply_patch` | Always                           | This page ([Apply a patch](#apply-a-patch))             |
| `bash`, `ps`, `wait`, `cancel`         | Always                           | [Processes](processes.md)                               |
| `snapshot`, `restore`                  | Always                           | [Snapshots](snapshots.md)                               |
| `fetch`                                | The bash backend has `endpoints` | [Read a process with fetch](#read-a-process-with-fetch) |
| `sql`                                  | `backend.sql` is set             | [SQL](sql.md)                                           |
| `repos`, `fork`                        | `backend.bash.git` is set        | [Git](git.md)                                           |
| The skills and macros of an agent      | `tools({ skills })`              | [Skills](skills.md)                                     |

**`read` of an image returns the image part and a text part,
`Image path: <path>`.** A format that the tool does not attach, such as BMP,
returns the text part alone. A model that cannot read images still learns
where the file is. `read` leaves its source file unchanged.

**The tools use the resources for storage operations.** Process waits and
`fetch` requests run outside those operations.

**A failure is an error, and every result tells the agent what to do.**
The workspace tools share these rules:

- **A failure is a tool error.** A harness and a host tell it from a
  success by the error flag of the result. A bad path, an unknown handle,
  and the limit of running processes are failures. A bad ref, a refused
  statement, a refused fork or a failed clone, and a process that ended badly are
  failures too. So are an abort, a fault of a backend, and an invalid
  argument.
- **The text of a failure states the problem and the next step.** A
  process that ended badly gives its output and its state line. A refused
  statement names the database and the fault. An unknown handle names
  `bash`, which returns the handle.
- **The workspace implements the file tools.** `read`, `write`, `edit`, and
  `apply_patch` run over the port of the bash backend. They report a bad path as a tool
  error.

```ts
import { defineAgent, defineTool } from '@ambionframework/ambion';
import { pi } from '@ambionframework/pi';

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

**A custom tool passes the calling agent and signal to the resource.**

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

[Resources](resources.md#references-and-provenance) states the provenance
that a tool receives through `ToolContext`.

### Apply a patch

**`apply_patch` changes several files in one call.** Its `input` argument is
a patch in the envelope of the Codex tool of the same name. Every seat that
has the workspace bundle gets `apply_patch` and `edit`. The model chooses
between them.

```text
*** Begin Patch
*** Add File: docs/new.md
+first line
+second line
*** Update File: src/a.ts
*** Move to: src/b.ts
@@ class Parser
 unchanged line
-removed line
+added line
*** Delete File: old.txt
*** End Patch
```

| Line                      | Meaning                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `*** Add File: <path>`    | Creates the file, or replaces it. Each line of the body starts with `+`. |
| `*** Delete File: <path>` | Removes the file. The operation has no body.                             |
| `*** Update File: <path>` | Changes the file with the hunks of the body.                             |
| `*** Move to: <path>`     | Follows `Update File`. The result goes to the new path.                  |

**A hunk is an anchor and lines.** `@@ <text>` moves the search to the line
after the first line that equals the text. Stacked `@@` lines narrow the
search, and each one must match. A line that starts with a space is context.
A line that starts with `-` leaves the file, and a line that starts with `+`
enters it. The first hunk of a file needs no anchor. `*** End of File` after a
hunk matches its lines at the end of the file. An update with a `Move to`
line and no hunk moves the file with no change of content.

**A hunk matches in three passes.** `applyDiff` searches forward from the end
of the previous hunk. It tries the lines exactly, then with the whitespace at
the end of each line dropped, then with the whitespace at both ends dropped.
An anchor matches exactly, then with both ends dropped. A hunk with no match
is an error that shows the lines it looked for. The tool keeps the line
endings of the file, its byte order mark, and a missing final newline. The
tool ends the last line of an added file with a newline.

**A patch applies in full or not at all.** The tool parses the envelope first.
It then reads each file once, through the queue of the resource, and
computes every result in memory. A later operation on the same path sees the
result of the earlier one. The tool writes and removes files after every
operation succeeds. Update, delete, and move need an existing file. A port
fault during the writes is the one case that can leave part of a patch. Its
error names the file and the code.

**The result lists each operation.** The text reads `Applied patch: A
docs/new.md, M src/a.ts -> src/b.ts, D old.txt`. `details.files` holds one
entry for each operation: `path`, `action` (`add`, `update`, `delete`, or
`move`), and `to` for a move. `details.patch` is the unified diff of every
change. A failure names the file as the patch gives it, the operation, and the
reason. It states that nothing was written.

## Write an append-only log

**`openLog` writes JSON Lines to one absolute path, and rotates it by
size.** `append` writes one JSON-compatible record as one line over a
caller's `env`, then rotates the file once it has reached the byte
threshold: the active file is renamed aside under a timestamped name, and a
fresh file starts at the same path. A record is never split by a rotation.

```ts
import { openLog, openWorkspace } from '@ambionframework/workspace';
import { directoryBackend } from '@ambionframework/just-bash';

const drive = openWorkspace({ name: 'town', backend: { bash: directoryBackend('./data') } });
const host = { name: 'host' };
const journal = openLog({ path: '/var/log/room/journal.jsonl' });

await drive.use(host, (env) => journal.append(env, { kind: 'said', text: 'hi' }));
```

**A log names one absolute file path.** The path is normalized and has no
trailing slash, and `openLog` refuses any other form. A caller scopes two logs
apart by giving them two paths. A room's full record, an audit trail, and a
metrics feed each open one log at its own path, over one shared workspace,
with no collision.

**A log carries no state of its own.** `openLog` does no I/O and holds no
count: every fact rotation needs — whether the active file exists, and how
large it is — comes from the path on the caller's `env` at the time of the
call. Opening a log again after a restart, or opening a second handle to the
same path, needs no recovery step, because there is nothing to recover.

**`rotateBytes` sets the byte threshold, and the default is 8 MiB.**
A log does not delete a rotated file; a host that
wants retention lists the directory and prunes its own way.

**`append` must run one call at a time over one log.** Two calls that race
over one rotation can both see the file past the threshold. Both try to
rename it aside, and the second rename fails. That call reports a failure
for a record that the file already holds, so a caller that retries writes a
duplicate. A caller inside `resource.use()` gets serialization from the
queue of the resource (see [Open one resource](#open-one-resource)). A caller that
holds `env` directly serializes its own calls.

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
`rotateBytes` to change the 5 MiB rotation threshold. `rotateBytes` must
be a positive, finite number. An agent reads the log
with `read` or `bash cat`, the same as any file a peer wrote, and sees every
call any agent in any room made, including its own past calls. `jq` filters
one entry out of many, by `room`, `tool`, `agent`, or `activation`.

**Tool guidance tells every agent the log exists.** `openWorkspace` appends
a note naming the path and what each line holds to the bundle's guidance, so
an agent that reads its own tool guidance already knows to look for it.

**The entry is one more operation on the bash resource after the call
ends.** Every tool follows this one rule, the file tools and the tools that
run on another resource alike. Another operation can run between the call
and its entry. The entry is an operation on the one bash resource (see
[Open one resource](#open-one-resource)), so the log's own rotation
decisions stay serialized. `audited` in `src/tools.ts` applies the rule to a
tool, and `workspaceTools` applies it once to every tool of the bundle.

**A call that ends after `dispose` starts leaves no entry.** The bash
resource refuses the record of that call, the same as any operation queued after
`dispose`. The call keeps its own result, and its other effects stay.
The log's `onError` receives an error that names the tool and the call id.

**An entry too large for the backend to hold falls back to a short notice.**
A `write` call whose content the filesystem has no room for still leaves one
line naming the call and the failure, in place of the full entry. The
fallback retries the write alone. A failure to create the log's directory
goes to `onError` and never becomes this notice.

**A directory, write, or rotation failure calls `onError`, and so does a
refused record.** The tool call itself keeps its own result. The log is best-effort: a full disk delays the
record. It does not delay the agent. A throwing `onError` callback is
caught inside the log, so it never reaches the tool call's own outcome.

**Only a call through `workspace.tools()` is recorded.** A direct
`workspace.use` call reaches the backend with no entry. It is host code, and
the guidance the log describes speaks to the model alone.

## Mirror a room's messages

**`workspace.mirror(room)` mirrors one room's message record to
`<layout.rooms>/<room name>/messages.jsonl`, built on `openLog`.** The
just-bash backends name `layout.rooms` `/rooms`. Call it once the room has
started. Set `rooms: true` on `openWorkspace` as well, so the guidance
of each seat names the mirror.

```ts
import { piExecution } from '@ambionframework/pi';
import { createRuntime, startRoom } from '@ambionframework/ambion';
import { memoryJournals } from '@ambionframework/journal';
import { openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/just-bash';

const site = openWorkspace({ name: 'town', backend: { bash: memoryBackend() } });
const runtime = createRuntime({ storage: memoryJournals() });
const session = await startRoom({
  name: 'lobby',
  agents: [/* ... */],
  execution: piExecution(),
  runtime,
});

const mirror = await site.mirror(session);
// later, on shutdown:
await session.stop();
await mirror.stop();
```

`mirror()` writes as `workspace.mirrorAgent`, the `<name>-host` agent `openWorkspace`
built (see [The layout and the host identity](#the-layout-and-the-host-identity)),
so a caller names only the room. The mirror leaves out the reading
preferences of a person, because every agent that reads the file would read
them. Stop the room before the mirror. The room's
own shutdown commits a `left` message for every present visitor; a mirror
already stopped never sees it.

**`await site.mirror(room)` returns once recovery is caught up, not once
every message is durably on disk.** Its promise resolves after the
backfill has queued every past message for the workspace to write. The
writes themselves still run on the workspace's own queue; `mirror.stop()`
is what waits for the last of them to land.

**One line per message, in the room's own order.** Every line is the
room's own `Message` type plus `room`, the room's name. Every kind also
carries `at`, an ISO timestamp the runtime stamps when the message lands.
`refs` is absent when the message cites nothing:

| `kind`                                  | Fields beyond `room`, `kind`, `seq`, `at`                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `said`                                  | `from`, `to` (absent for a broadcast), `text`, `refs`, and `delaySeconds` on a scheduled say               |
| `system`                                | `to` (absent for the room), `text`, `refs`, and `returns` (the seq of the scheduled say) on a returned say |
| `dismissed`                             | `from` (absent for the host), `message` (the seq of the scheduled say)                                     |
| `arrived`, `left`, `seated`, `unseated` | `subject`, and `identity` on `arrived` and `seated`                                                        |
| `summary`                               | `from`, `to`, `text`, `covers: { from, through }`, `refs`                                                  |

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

**The mirror checks the room name as a second guard.** The room accepts
only lowercase, alphanumeric names with dashes. This is the first place a
room name turns into a filesystem path. A name holding `..` or an extra `/`
would resolve outside `layout.rooms`; `mirror()` refuses that name and
writes nothing.

**The guidance names the room mirror when the host sets `rooms: true`.**
`openWorkspace` takes `rooms`, which defaults to `false`. The file exists
only when the host calls `mirror()`, so a workspace with no mirror states
nothing about it. A host that mirrors its rooms sets the option, and the
guidance of every seat then points at the path. The note names no room. It
names the backend's actual `layout.rooms`, and says that the file can hold
messages that the context of the seat trimmed or folded. The option changes
the guidance alone. `mirror()` works with or without it.

## Read a process with fetch

**`fetch` reads one path of a running process with GET.** The process
serves HTTP on its `$PORT` ([Processes](processes.md#processes-that-serve-http)).
The workspace keeps the body as a snapshot, writes it to `~/.fetch`, and
returns the ref. The tool is present when the bash backend has `endpoints`.
That fact does not change in a session, so the tool list of a seat stays the
same, and the `bash` schema is the same on every backend.

**The tool refuses any other parameter.** It has no URL, no host, no port,
no method, and no header. It reaches the port of a running process and
nothing else.

**One call takes seven steps.**

1. Find the running process of that name or handle in any agent of the
   workspace.
2. Send GET to the path through the forward of the process, with a limit of
   60 seconds joined to the signal of the call. Read the body up to the limit.
3. Check that the process still runs. A process that ended during the read
   fails the call.
4. Refuse a status outside 200 to 299, and show the start of its body.
5. Take the media type from the `content-type` header, before `;`, trimmed,
   in lower case. An absent header gives `application/octet-stream`.
6. Keep the bytes: resolve `~/.fetch/<process>/`, put the bytes on the
   object resource, and write the export file.
7. Render the result.

**Step 1 reads the tables of this run.** A handle that the table holds live
resolves from memory, with no read of files. A name uses the same list as
`workspace.processes.list` with `running: true`. An agent joins that list when
it first acts in this run. After a restart of the host, `fetch` finds a process
of an agent once that agent has called a process tool or received a reminder,
or once the host has called `workspace.processes.list({ agent })` for that
agent.

**The export has a name from its content.** The file is
`~/.fetch/<process>/<sha12>.<ext>`, where `<sha12>` is the first 12 digits of
the SHA-256 digest. The same bytes give the same file. Each read writes the
file again, so an edit lasts until the next read of the same bytes. The ref
keeps the received bytes. The extension follows the media type.

| Media type                       | Extension     |
| -------------------------------- | ------------- |
| `application/json`, and `*+json` | `json`        |
| `text/csv`                       | `csv`         |
| Other `text/*`                   | `txt`         |
| `image/png`, `image/jpeg`        | `png`, `jpg`  |
| `image/gif`, `image/webp`        | `gif`, `webp` |
| Anything else                    | `bin`         |

**The result has one text block, then an image part for an image.**

```text
Fetched <path> from <process> (<handle>): <status>, <mediaType>, <bytes> bytes.
Process data: <the JSON or text>
File: <export path>
Snapshot ref: <ref>
```

The `Process data` line appears for JSON and text. A body past the line and
byte limits of `read` is cut, and the result adds `The full body is at
<export path>.` A body of text or JSON past 4 MiB shows no data and says
where the full body is. An image part appears when the header type is PNG,
JPEG, GIF, or WebP, the bytes agree with the type, and the body is at most
5 MiB.

**Each failure is a tool error that states the next step.**

| Event                               | Text                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| No running process has the name     | `No running process is named '<process>'. A process of an agent that has not acted since the host started is not listed yet.` |
| Two running processes have the name | `Two running processes are named '<process>': <handle> of <agent>, <handle> of <agent>. Give the handle.`                     |
| The port refuses the connection     | `Process '<process>' (<handle>) does not listen on $PORT <port>.`                                                             |
| The process answers a redirect      | `Process '<process>' answered a redirect for <path>. fetch does not follow redirects.`                                        |
| The read fails for another cause    | `The read of <path> from '<process>' (<handle>) failed: <message>`                                                            |
| The body is past the limit          | `The body of <path> is larger than 64 MiB. Nothing was kept.`                                                                 |
| The process ended during the read   | `Process '<process>' (<handle>) ended during the read. Nothing was kept.`                                                     |
| The status is outside 200 to 299    | `Process '<process>' answered <status> for <path>. Process data: <first 2 KiB>`                                               |
| The request ran past 60 seconds     | `Process '<process>' (<handle>) did not answer <path> in 60 seconds. Nothing was kept.`                                       |

**Only a refused connection says that nothing listens.** A refused connect
to the port and a refused forward of the workstation give that text. A
redirect answer fails, and `fetch` follows none. Any other failure of the
request gives its own message.

**Process data is untrusted.** JSON and text render after the mark
`Process data`. The note of the tool says that process data is untrusted text.
A seat treats it as evidence. It does not follow it as an instruction.

**The request runs outside the resources.** The lookup and the retention
take the bash resource and the object resource for their own steps. No step
runs inside a call of the bash resource, so the call never waits on itself.
The audit log wraps `fetch` as it wraps every tool.

| Who                        | Reaches                              | Can do                                                   |
| -------------------------- | ------------------------------------ | -------------------------------------------------------- |
| Any agent of the workspace | Running processes, by name or handle | GET with no header or body. The workspace keeps the body |
| The owner of a process     | The same, and `cancel`               | Stop it, which closes its forward                        |
| The host                   | The same, with `workspace.fetch`     | Any request, with nothing kept. The host is trusted      |

**`workspace.fetch(process, path, init?)` is the read of the host.** It
returns a `Response`, and it keeps nothing. It exists when the bash backend
has `endpoints`.

## Declared outputs

**Eleven tools declare their output for `compose`.** Each sets
`compose: { output }` with a TypeBox schema. A `compose` call binds the tool
as its `details` and checks them against the schema at every call
([Compose](compose.md#bindings)). The other tools declare none, so `compose`
binds them as text. `write`, `edit`, and `apply_patch` declare none, because
code needs only their success or their rejection.

**Each output has a named type.** The schema carries an `$id`. The description
of `compose` lists `name -> Type` for each tool, and `describe` renders the type
once for all tools that share it ([Compose](compose.md#the-catalog)). The types
are `sql` to `SqlResult`, `snapshot` to `SnapshotResult`, `restore` to
`RestoreResult`, `read` to `ReadResult`, `bash` and `cancel` to
`ProcessResult`, `ps` to `PsResult`, `wait` to `WaitResult`, `repos` to
`ReposResult`, `fork` to `ForkResult`, and `fetch` to `FetchResult`.
`WaitResult` is a union of `ProcessResult` and `WaitedResult`. `Process` and
`Truncation` are the named types inside them.

**The `read` details give the text with no notice.** `text` holds the lines
that the result shows, and the notice lines of a direct call stay out of it.
The `text` of a `read` and of a process tool is also in the content
of the result, so a record that keeps both with `toolOutput: 'full'` holds
the shown output twice.

**`read` scans a text file in ranges of 1 MiB.** The scan reads the first
range with `readRange`, and reads the next range while the view is not
complete. It counts the newline bytes, skips the lines before `offset`, and
keeps the bytes of the view. The scan holds one range and the view, so the
memory use does not depend on the size of the file. A file of any size gives
a view. When the view ends before the end of the file, the notices omit the
line count: `[Showing lines 1-2000. Use offset=2001 to continue.]`. A file
under 1 MiB is scanned to its end, so its result has `lines` and the line
count in each notice. An image still reads whole, and the limit of the
backend applies to it.

**The `sql` details hold the rows that the tool already reads.** A row value is text, a number, or `null`. A blob is its bytes as
lowercase hex, as the CSV export writes it. A `bigint` is its decimal digits
as text, and a number that is not finite is its text.

## Build a bash backend

**`BashBackend` extends `ResourceBackend<WorkspaceEnv>`** ([the resource
contract](resources.md#the-resource-contract)). It adds optional guidance about
the backend's own shell and a required `layout` (see
[The layout and the host identity](#the-layout-and-the-host-identity)). The
root entry names `WorkspaceEnv`, the port of a bash backend
([The port](#the-port)). The workspace binds its tools over every backend.

**A new backend implements `connect()` and `WorkspaceEnv`.** Use the
shared helpers below and name the backend's `layout`. Supply guidance for
its shell and pass `@ambionframework/workspace/conformance`. The backend
loads no just-bash. The memory and directory backends export from the package
`@ambionframework/just-bash`, which depends on the workspace.

**The root entry also exports the environment helpers a new `WorkspaceEnv`
backend needs.** The just-bash backends and the workstation both build on
them, and they import no just-bash. The helpers are `resolvePath`, `HomeEnv`,
`Deadline` and `withDeadline`, `boundedView` and `deliverView`, `randomName`,
`runScript`, and `shellQuote`. The constant `DEFAULT_TIMEOUT_SECONDS` is the 30
seconds that a command gets when its caller names no timeout, and
`MAX_TIMER_SECONDS` is the 2,147,483 seconds that a timer holds. The TSDoc of
each helper states its contract.

**`HomeEnv` implements the file methods once.** A backend supplies two
abstract properties: `files`, a `FileOperations` with one throwing storage
operation for each method, and `classify`, which turns what an operation
threw into a `FileError`. `HomeEnv` resolves the path, returns `aborted`
when the signal is aborted, runs the operation, and calls
`classify` with the path and a `FileExpect` hint: `file` for a read or a
write, `directory` for `listDir`, and `any` for the rest. `classify` can
return a promise. A backend can override a method that needs more than one
operation. `HomeEnv` also implements `cwd` and `absolutePath`.

**A backend writes no spill file.** Every `bash` call writes its whole
output to a process file ([Processes](processes.md)). A backend keeps the
bounded view of an output and no more.

## The port

**The workspace owns its port.** `WorkspaceEnv` is the files and the shell of
one agent. `backend.ts` declares it, and `port.ts` declares the values that
it passes. The root entry exports both, so a host that runs a Claude or a
Codex seat installs no Pi package to use a workspace.

**Every operation returns a `Result` and never throws.** A file operation
gives `Result<T, FileError>`, and `exec` gives
`Result<ShellExecResult, ShellError>`. `ok` and `err` build a `Result`.
`FileError` has a `code`: `aborted`, `not_found`, `permission_denied`,
`not_directory`, `is_directory`, `invalid`, `not_supported`, or `unknown`.
`ShellError` has the code `aborted`, `timeout`, `spawn_error`, or
`unknown`.

**Every operation takes an optional `AbortSignal` as its last argument.** An
aborted signal ends the operation with the code `aborted`. `cleanup` takes no
signal. A caller that has no signal passes none.

**The port holds only what the repository calls.** It has no `joinPath`,
`readTextLines`, `openTextLineReader`, `createTempDir`, or `createTempFile`.
The shapes derive from the harness types of Pi (MIT License).

## The conformance suite

`@ambionframework/workspace/conformance` holds the `WorkspaceEnv` rules the
built-in tools need: a rename that replaces an existing target, a recursive
`createDir`, a forced and a recursive `remove`, the file error codes, `~`
expansion, an abort apart from a timeout, and the bounded output view.

A case is a `ConformanceCase`: a name and a `run` that throws on failure.
The entry loads no test framework and no just-bash, so any backend runs it.
`workspaceConformance(fixture)` takes a
`ConformanceFixture<WorkspaceConformanceStore>`: a name and an `open()` that
returns a `WorkspaceConformanceStore`, a fresh `BashBackend` with a
`dispose()`. It returns the cases:

```ts
import { workspaceConformance } from '@ambionframework/workspace/conformance';
import { describe, it } from 'vitest';

describe.each(backends)('$name', (fixture) => {
  for (const c of workspaceConformance(fixture)) it(c.name, c.run);
});
```

**One fixture type serves every conformance suite.**
`ConformanceFixture<Subject>` has a `name` and an `open()` that
returns the subject of one case. `conformanceSuite(fixture, cases)` opens the
subject for each case, runs the body, and disposes the subject after, also
when the body throws. `check(condition, what)` throws `what` when the
condition fails. The entries `@ambionframework/journal/conformance`,
`@ambionframework/ambion/conformance`, and
`@ambionframework/workspace/conformance` export the three.

A new backend runs the suite before it takes on tool-specific tests of its own.

## Dispose of a resource

```ts
await drive.dispose();
```

**Workspace disposal closes its resources in dependency order.** It closes
SQL, bash, objects, then git. It stops pending HTTP forwarding at once.
The bash resource cancels every background process of this run and waits
for it to end ([Processes](processes.md#life-and-disposal)). Each resource
follows [the disposal contract](resources.md#the-resource-contract).

**Disposal keeps the persisted workspace.** A directory backend keeps its
files. A memory backend releases its cached filesystem. The host owns
removal of the data.
