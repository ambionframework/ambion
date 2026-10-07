# The workspace

> **`fetch` is available when the bash backend has endpoints.** It reads a
> path of a running process that listens on `$PORT`, with GET. The workspace
> keeps the body as a snapshot. An image reaches the model as an image, and
> the text of the result names its export path. The host reads a process with
> `workspace.fetch`.

**The workspace is a resource that holds files and a shell.** The optional
`@ambionframework/workspace` package provides a workspace resource and its
tools. The package `@ambionframework/just-bash` provides the memory and
directory backends over just-bash. A workspace has one bash backend,
and it can have one SQL backend
([Query the shared database](#query-the-shared-database)) and one git
backend ([Git](git.md)). Agents receive access through
ordinary tool bundles. Workspace files remain separate from the
collaboration journal. [Resources](resources.md) states the resource contract,
tool bundles, and the rules for references and provenance.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/ambion-capabilities-dark.svg">
  <img alt="A room and its workspace, by capability. A room activates an agent. The room's journal holds a person's question, what an agent says, a say to itself, the close, an optional summary, and the returned say. The agent calls the tools of a workspace. It says what it finds, with refs to what it names. An agent says to itself with a delay. The exchange closes while the say waits. When the say is due, the room gives it back, and the returned say opens an exchange. Every Pi, Claude, and Codex seat has compose and describe from its executor. compose joins the tools of the agent in one call. describe gives their signatures. The workspace gives an agent five capabilities. Two are built in, and three are optional. Processes are built in. bash starts a process that outlives the activation. ps lists it, wait reads it, and cancel stops it. At the start of each activation, a reminder lists the seat's processes. A process can serve HTTP on $PORT. The optional fetch reads it, and the workspace keeps the body as a snapshot. Optional tables add sql: agents pass work in a table or a view. Optional repositories add repos and fork: an agent forks a template, then pushes. Files and objects are built in. read, write, and edit reach the files. snapshot puts the bytes of a file in a folder or an S3 bucket, and restore gives them back. Optional skills add macros. Each agent reads its skills from ~/.skills. A skill stores macros, and compose runs a macro by name. The five share the homes and the snapshots. Each agent has a home. A snapshot ref names bytes. An opt-in audit log holds tool calls. An opt-in room mirror holds messages. A message cites any of it with a ref. A person and the host steer the room. A person on a visit asks a question and reads results. The host is application code. It lists processes, cancels one, and hears each start and end. Each one posts a message to the room. A message cites a file with a ref. A restart replays the entries." src="assets/ambion-capabilities.svg">
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

**Each backend has its own resource.** `openWorkspace` opens a bash resource
with `WorkspaceEnv` and an object resource with `ObjectEnv` for snapshots.
It opens a SQL resource with `SqlEnv` when `backend.sql` is set, and a git
resource with `GitEnv` when `backend.bash.git` is set. The resources share
[the resource contract](resources.md#the-resource-contract). `workspace.use`
reaches the bash resource; `workspace.sql` and `workspace.git` expose the
optional resources. The snapshot methods use the object resource.

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

`workspace.tools()` returns an ordinary Ambion `ToolBundle`. The neutral layer
binds four file tools first: `read`, `write`, `edit`, and `apply_patch`. The four process
tools come next: `bash`, `ps`, `wait`, and `cancel`. `bash` starts
each command as a background process and returns its handle
([Processes](processes.md)). The bundle reminds each seat of its processes.
`snapshot`
and `restore` come next:
one freezes files and gives the refs that cite them, and the other puts the
bytes of a cited snapshot in the agent's files
([Snapshot a file](#snapshot-a-file)).
A backend with `endpoints` adds `fetch`, which reads a path of a running
process with GET and keeps the body as a snapshot
([Read a process with fetch](#read-a-process-with-fetch)). Network requests
run outside the bash resource. Only process checks and export writes use it.
`fetch` returns each image as an image part and names its export path in
the text of the result. `read` of an image returns the image part and a text
part, `Image path: <path>`. A format that the tool does not attach, such as
BMP, returns the text part alone. A model that cannot read images still learns
where the file is. `fetch` keeps the image bytes in the exports and
snapshots, and `read` leaves its source file unchanged.
A workspace with a SQL backend adds `sql`
([Query the shared database](#query-the-shared-database)). A workspace with
no SQL backend has no `sql` tool. The bash backend adds its own guidance
about its own shell, if it has any. Tools use the resources for storage
operations; process waits and `fetch` requests run outside those
operations. The bundle keeps one stable identity. Pass it in an executor's
`bundles` field ([Tool bundles](resources.md#tool-bundles)).

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

## Give an agent skills

**`workspace.tools({ skills })` gives one agent a fixed set of skills.**
`loadSkills` reads the set once on the host. The guidance of the bundle
lists the skills, and each respond activation copies their files into
`~/.skills` in the agent's home. [Skills](skills.md) holds the contract.

```ts
const skills = await loadSkills(fromDirectory('./agents/surveyor/skills'));
const bundles = [drive.tools({ skills })];
```

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

**A log names one absolute path, not a directory.** `path` must be
absolute: a relative path would resolve against whichever agent's home
connects first, splitting the log one way for that agent and another way
for every other. `path` must also be normalized, with no trailing slash. A
doubled slash, a `.` or `..` segment, or a trailing slash can name one file
on one backend and a different file on another. `openLog` and the audit log
refuse each of these at open. A caller scopes two logs apart by giving
them two paths; a room's full record, an audit trail, and a metrics feed
each open one log at its own path, over one shared workspace, with no
collision.

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

**A call with invalid arguments has an entry.** The tool refuses the call
before it runs. The entry holds the arguments of the call as the tool
received them, and the validation error.

**A call that ends after `dispose` starts leaves no entry.** The bash
resource refuses the record of that call, the same as any operation queued after
`dispose`. The call keeps its own result, and its other effects stay.
The log's `onError` receives an error that names the tool and the call id.

**A cut or aborted call is still recorded.** The record runs after the call
ends, whatever ended it, with no abort signal. It does not
depend on the caller's abort signal. A room that cuts an activation mid-call
still leaves a trace of what that call was doing.

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

**The log shares the workspace's boundary.** just-bash gives no wall between
one agent's home and another's (see [Backends and limits](#backends-and-limits)),
and the log is no exception: any agent's `bash` or `write` call can alter or
remove it, the same as any other file on the workspace.

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

**A room's name is not validated at the kernel today.** This is the first
place a room name turns into a filesystem path. A name holding `..` or an
extra `/` would resolve outside `layout.rooms`; `mirror()` refuses that name
and writes nothing.

**The guidance names the room mirror when the host sets `rooms: true`.**
`openWorkspace` takes `rooms`, which defaults to `false`. The file exists
only when the host calls `mirror()`, so a workspace with no mirror states
nothing about it. A host that mirrors its rooms sets the option, and the
guidance of every seat then points at the path. The note names no room. It
names the backend's actual `layout.rooms`, and says that the file can hold
messages that the context of the seat trimmed or folded. The option changes
the guidance alone. `mirror()` works with or without it.

**Directory-per-room organizes the data; it does not wall it off.** Every
room sharing one workspace shares its filesystem boundary (see
[Backends and limits](#backends-and-limits)). An agent seated in one room
reads another room's `messages.jsonl` the same way, with the same `seq`
and `jq` filter it uses on its own.

## Snapshot a file

**A snapshot freezes the bytes of a file and gives a ref that names them.**
A path names a file that can change after a message cites it. A snapshot
ref names the bytes that the file held at the snapshot:

```text
ambion://workspace/<workspace name>/snapshot/<sha256 of the bytes>/<absolute path>
```

The kernel owns the form ([Definitions and tools](agent.md)). The workspace
makes the snapshot, and its object backend keeps the bytes
([The object backend](#the-object-backend)).

**`workspace.snapshot(paths)` gives one ref for each path, in order.** The
host calls it. `options.agent` names the agent that reads the files, and the
default is `workspace.mirrorAgent`. A relative path resolves against the working
directory of that agent. `workspace.readSnapshot(ref)` gives the bytes back.

```ts
const [report] = await drive.snapshot(['/home/analyst/report.md'], {
  agent: { name: 'analyst' },
});
await visit.send({ text: 'The report for review.', refs: [report] });
const bytes = await drive.readSnapshot(report);
```

**The `snapshot` tool gives an agent the same refs.** It reads the files as
the calling agent, and its result lists one ref for each path. The `refs` field
of `say` and the description of `snapshot` tell every agent to cite a file
with a snapshot ref. The audit log records each call.

| Step | Resource | What happens                                                                                 |
| ---- | -------- | -------------------------------------------------------------------------------------------- |
| 1    | bash     | The agent that reads finds every file. A path that is not one readable file fails the call.  |
| 2    | bash     | For each file in turn, the agent that reads reads the bytes.                                 |
| 3    | —        | The workspace hashes the bytes with SHA-256.                                                 |
| 4    | object   | The host agent, `<name>-host`, puts the bytes under their digest. Then the next file starts. |
| 5    | —        | The workspace gives the refs.                                                                |

**The `restore` tool puts the bytes of a cited snapshot in an agent's files.**
It takes `ref` and an optional `path`. The default path is
`~/snapshots/<digest>/<name>`, where `<name>` is the last part of the path
in the ref. The host agent gets the object on the object resource, and the
workspace checks it. The calling agent then writes the file on the bash
resource and reads it with `read` or `bash`. No agent holds a credential of
the object store.

| Outcome | The result                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------- |
| Written | `Wrote the <n> bytes of <ref> to <path>.`, and `details` with `ref`, `path`, and `bytes`       |
| Refused | A tool error: not a snapshot ref, a ref of another workspace, no object, or bytes that changed |

**The same bytes give the same ref.** An object has its digest as its key,
so a second snapshot of the same bytes at the same path gives the same ref
and stores nothing new. The same bytes at two paths give two refs and one
object.

**A later change to the file does not change a ref.** The object holds the
bytes of the snapshot. A new snapshot of the changed file gives a new ref.
The object outlasts a restart of the host when its store does. Nothing
removes an object today.

**`readSnapshot` and `restore` check the bytes against the digest.** Each
refuses a ref of another workspace, a missing object, and bytes whose
SHA-256 differs from the digest. The check holds on every object backend,
so a backend promises storage alone.

**The limits.** One call takes 1 to 16 paths, the count of refs one message
carries. One file holds at most what one object holds: 5 GiB, the limit of
one S3 PutObject ([The object backend](#the-object-backend)).
`SNAPSHOT_LIMITS` holds both. A ref longer than 2048 characters is refused.
The call finds every file first. A path that is not a file stores nothing.
A file that is too large, has too long a ref, or has a second path in the
call also stores nothing. The call then reads, hashes, and puts one file at
a time, so it holds one file in memory. A call that fails while it puts can
leave an object with no ref. The object is harmless, and a later snapshot
of the same bytes uses it.

**A bash backend can read less than an object holds.** The limits above are
the object store's. The just-bash directory backend reads at most 10 MiB of
one file. The memory backend holds 128 MiB in all. On those backends, a
larger file fails with the backend's own error. The workstation reads at
most 10 MiB of one regular file. A larger file, a device file, and a FIFO
fail with `invalid`. These limits apply to a whole-file read: `readBinaryFile`
and `readTextFile`, and the tools that use them. The `read` tool of a text
file reads byte ranges with `readRange`, which has no size limit. A range
read of a device file or a FIFO fails with `invalid` on the workstation.

## The object backend

**`backend.objects` names where the bytes of each snapshot live.** It is an
`ObjectBackend`. When it is absent, `openWorkspace` opens a file store at
`layout.snapshots` on the bash backend. So every workspace has `snapshot`
and `restore`, and the bytes have one path.

```ts
interface ObjectEnv extends ResourceEnv {
  /** Store `bytes` under `digest`. A put of a digest the store holds writes nothing. */
  put(digest: ObjectDigest, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** The bytes under `digest`, or `undefined` when the store has none. */
  get(digest: ObjectDigest, signal?: AbortSignal): Promise<Uint8Array | undefined>;
}

interface ObjectBackend extends ResourceBackend<ObjectEnv> {
  /** The label that errors use for the store, with no credential: a folder or a bucket URL. */
  readonly label: string;
}
```

**The workspace gives the key.** It hashes the bytes and passes the digest,
64 lowercase hex digits of SHA-256. A backend refuses any other key with a
`RangeError`, forms its own key from the digest, and refuses an object past
5 GiB. No metadata travels with an object: the path and the provenance live
in the ref and in the message that cites it.

**The limits are the limits of S3.** R2 and MinIO hold the same, so a store
of any kind takes what S3 takes. One object holds at most 5 GiB, the limit
of one PutObject. The ports pass whole buffers, and no backend makes a
multipart upload. One key holds at most 1024 bytes. The digest takes 64,
so an S3 prefix holds at most 960. `SNAPSHOT_LIMITS.bytes` is
the object limit. No bash backend sets a limit of the store.

| Backend                    | Entry                           | Where the bytes live                                              |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| The default file store     | none: `openWorkspace` opens it  | One file per digest at `layout.snapshots`, on the bash backend    |
| `s3ObjectBackend(options)` | `@ambionframework/workspace/s3` | One object per digest at `<bucket>/<prefix><digest>` on an S3 API |

**The default file store writes through the bash resource as the host
agent.** A put writes a temporary file beside the target, then renames it,
and it writes nothing when the file exists. On `memoryBackend` the bytes
live in process, on `directoryBackend` in the directory, and on a
workstation in a folder that only the host account writes
([Workstation](workstation.md#the-layout-on-a-server)). just-bash has no
wall between accounts, so an agent can change a file of the store; the
digest check then refuses it.

**`s3ObjectBackend` stores the bytes in a bucket of an S3 API.** It serves
Amazon S3, Cloudflare R2, and MinIO. `aws4fetch` signs each request with
SigV4 over the global `fetch`, and the entry loads no other library.

```ts
import { s3ObjectBackend } from '@ambionframework/workspace/s3';

const lab = openWorkspace({
  name: 'lab',
  backend: {
    bash: directoryBackend('./data/lab'),
    objects: s3ObjectBackend({
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'ambion-snapshots',
      prefix: 'lab/',
      accessKeyId: process.env.S3_KEY ?? '',
      secretAccessKey: process.env.S3_SECRET ?? '',
    }),
  },
});
```

| Option                                           | Meaning                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `endpoint`, `region`, `bucket`                   | The S3 API. `region` is `us-east-1` for MinIO and `auto` for R2             |
| `prefix`                                         | A key prefix, so one bucket serves more than one workspace: one prefix each |
| `accessKeyId`, `secretAccessKey`, `sessionToken` | The credential of the host. No agent holds it                               |
| `pathStyle`                                      | The bucket in the path. The default is `true`, which MinIO needs            |
| `retries`                                        | Runs again of a request that failed with a 5xx or a 429. The default is 2   |

**A put never rewrites an object.** It reads the head first and writes
nothing when the object exists. Otherwise it sends the bytes with
`If-None-Match: *`. A 412 means that a concurrent put stored the same bytes
first. A 409 means that a concurrent put is in progress, so the put reads
the head again and sends again, at most three times. The put also sends
`x-amz-checksum-sha256`, so the store refuses bytes that changed on the
way. A `get` refuses an object past 5 GiB before its bytes enter memory.
`s3ObjectBackend` refuses a prefix past 960 bytes, and a prefix with a
character outside the ones S3 calls safe: `A-Z a-z 0-9 ! - _ . * ' ( )`
and `/`. A response that is not
a success rejects with the status and the S3 error code.

**Grant the host credential `s3:GetObject`, `s3:PutObject`, and
`s3:ListBucket`.** Without `s3:ListBucket`, S3 gives 403 for a missing
object. A put then sends the bytes, and the conditional put decides. A
`get` of a missing object then rejects with the 403.

**Give each workspace its own prefix or bucket.** Two workspaces that share
a prefix share their objects. A ref names its workspace, and `readSnapshot`
refuses a ref of another workspace. But the host of either workspace can
read every object under the prefix.

**The object backend has its own resource.** `Workspace.objects` exposes it
for host code. An object operation may wait on the bash resource, since the
default store writes through it. No bash operation waits on the object
resource: `snapshot` reads on the bash resource and then puts on the object
resource, and `restore` gets on the object resource and then writes on the
bash resource. `dispose` drains the SQL resource, the bash resource, the
object resource, and the git resource, in that order, so a use that starts
after `dispose` is refused at once.

**A new object backend passes `objectConformance`** from
`@ambionframework/workspace/conformance`. A
`ConformanceFixture<ObjectConformanceStore>` opens a store and gives the
backend. A fixture that can open the same store again gives `reopen`.

- `put` then `get` gives the same bytes: 1 byte, bytes with zeros, 0 bytes,
  and 1 MiB.
- `get` of an unknown digest gives `undefined`.
- A second `put` of one digest succeeds and keeps the bytes, and two puts
  of one digest at once both succeed.
- Every agent reaches one store.
- `put` and `get` refuse a key that is not a SHA-256 digest.
- A `put` with an aborted signal rejects and stores nothing.
- The bytes outlast `dispose`, when the store can open again.

The workspace package runs the cases on the default file store over
`memoryBackend` and `directoryBackend`. The S3 tier runs them on MinIO.

**The S3 tier runs against MinIO in Docker.** `test/s3/setup.sh` starts the
server and writes the file that `AMBION_S3` names; without that variable,
every test of the tier skips. `pnpm --filter @ambionframework/workspace run
test:s3` runs it, and the `object-store` CI job runs it on each push. The
official `minio/minio` image no longer exists on Docker Hub. The script
runs Chainguard's build, `cgr.dev/chainguard/minio`, pinned by digest,
since only its `latest` tag is free. The container keeps `/data` on a tmpfs
that the image's user owns. The tier proves what only a real server can:

- The server accepts the SigV4 signature.
- A bad credential fails with `SignatureDoesNotMatch`.
- The conditional put keeps the first bytes.
- A workspace over S3 keeps no copy of a snapshot on its bash filesystem.

A local HTTP server in the unit tests gives the two answers that MinIO does
not: a 403 head and a 409 put.

## Read a process with fetch

**`fetch` reads one path of a running process with GET.** The process
serves HTTP on its `$PORT` ([Processes](processes.md#processes-that-serve-http)).
The workspace keeps the body as a snapshot, writes it to `~/.fetch`, and
returns the ref. The tool is present when the bash backend has `endpoints`.
That fact does not change in a session, so the tool list of a seat stays the
same, and the `bash` schema is the same on every backend.

| Parameter | Type   | Rule                                                         |
| --------- | ------ | ------------------------------------------------------------ |
| `process` | string | The name or the handle of a running process                  |
| `path`    | string | `^/[^\s#]*$`, at most 2048 characters, with its query string |

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

**The declared output is the same for every call.**

| Field                | Meaning                                                   |
| -------------------- | --------------------------------------------------------- |
| `process`            | The name of the process, or its handle when it has none   |
| `handle`, `owner`    | The handle at the read, and the agent that started it     |
| `path`, `status`     | The path that the call read, and the HTTP status          |
| `mediaType`, `bytes` | The media type in lower case, and the size of the body    |
| `sha256`             | The digest of the body                                    |
| `ref`, `file`        | The snapshot ref to cite, and the absolute export path    |
| `json`, `text`       | The parsed JSON body, or the whole text body, up to 4 MiB |

**The limits are constants.** The host cannot change them.

| Limit                           | Value  |
| ------------------------------- | ------ |
| The body of one call            | 64 MiB |
| JSON and text in the output     | 4 MiB  |
| An image part                   | 5 MiB  |
| The body shown for a bad status | 2 KiB  |
| The request                     | 60 s   |

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

## Query the shared database

**A workspace has one bash backend, and it can have one SQL backend.**
The `backend` option holds the backends by kind, as `WorkspaceBackends`.
`backend.bash` is a `BashBackend`, and every workspace has one.
`backend.sql` is an optional `SqlBackend`: a shared database that need not
live on the filesystem of the bash backend. `backend.bash.git` is an optional
`GitBackend`: the repositories of the workspace, which [Git](git.md)
describes. The bash backend takes it as an option of its own package, so a
wrong pair is a compile error
([The contract](git.md#the-contract)). With no SQL backend, the
workspace has no `sql` tool.

**`sqliteBackend` from `@ambionframework/workspace/sqlite` is the default
SQL backend.** It opens one SQLite database through `node:sqlite`, at a
host path or at `:memory:`. The file lives beside the bash backend's
filesystem, so the shell does not reach it. The first call creates the
file and its directory. `dispose()` closes the database and keeps the file.

```ts
import { openWorkspace } from '@ambionframework/workspace';
import { directoryBackend } from '@ambionframework/just-bash';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';

const lab = openWorkspace({
  name: 'lab',
  backend: { bash: directoryBackend('./data/lab'), sql: sqliteBackend('./data/lab.db') },
});
```

**The `sql` tool runs statements on the shared database.** Every agent
queries this one database, so a table or a view one agent creates is data
another agent reads at once. The tool takes these parameters:

| Parameter | Meaning                                                            |
| --------- | ------------------------------------------------------------------ |
| `sql`     | One or more statements. The last query gives the preview.          |
| `export`  | A path in the workspace for the full result as CSV.                |
| `import`  | A path in the workspace of a CSV file, as the table `import.rows`. |
| `params`  | Values for the `?` placeholders of one statement, in order.        |
| `rows`    | How many rows the preview shows, up to 1000. The default is 50.    |

**`params` binds values to a statement.** Write `?` in the statement and
list the values in `params`: text, a number, or `null`. The backend binds
each value, so a quote or a keyword in a value cannot change the statement.
A whole number binds as an integer. Use `1` or `0` for a boolean. A call with a
non-empty `params` holds one statement. A call with more fails before it
runs any.
A skill [macro](macros.md#write-a-macro) passes each argument that came from the
model through `params`.

**The preview stays in context and writes nothing to disk.** The tool shows
the last query's result as a Markdown table, capped at `rows`. It keeps
the data in the database. An agent reads the result and continues. A
statement that the database refuses fails the call. The error text names
the database and the fault, and asks the agent to correct the statement.

**Share through a table or a view.** The data stays in the shared database, so
no agent copies a file. A view holds its own query and reflects the current
tables. `sqlite_master` holds each view's definition, so an agent reads how a
shared view was built before the agent trusts its data. Prefer a view or a
table for every hand-off between agents.

**`export` writes the full result into the filesystem of the bash backend,
and the tool returns a preview.** Set it when a script or another tool needs the
rows. The SQL backend streams every row as CSV to the calling agent's
files through `WorkspaceFiles`, and gives back the first `maxRows` rows and
the row count. The tool shows the head of the file. A failed query leaves
an existing file unchanged. A NULL value reads as a bare `\N`, and the
text `\N` reads as `"\N"`. A blob reads as hex.

**A result never enters memory whole.** The backend keeps the first
`maxRows` rows and counts the rest. An export streams in chunks.

**`import` reads a CSV file of the workspace into the table `import.rows`
for one call.** The backend reads the file through `WorkspaceFiles`, as
the calling agent, before the first statement runs. The statements then
copy what they need into the shared tables. The backend drops the table
after the call. The first line of the report names the file and counts its rows.

```text
sql:    CREATE TABLE sweep (step INTEGER, ohms REAL, ma REAL);
        INSERT INTO sweep
          SELECT CAST(step AS INTEGER), CAST(ohms AS REAL), CAST(ma AS REAL)
          FROM import.rows;
import: sweep/results.csv
```

- **SQL decides what lands.** The import only parses. The statements
  choose the columns, CAST each value, and handle a duplicate with the
  dialect's own `INSERT`.
- **The CSV is the one that `export` writes.** RFC 4180, a header first,
  and a bare `\N` for NULL. A quoted `"\N"` is the text `\N`. A line
  ends with LF, CRLF, or CR, and a byte order mark is skipped.
- **Every other value is text.** A column of `import.rows` has no type,
  so a number reads back as text until a CAST. A blob that an export
  wrote as hex stays hex text. Text and NULL read back as they were.
- **The header names the columns.** Each column needs a name with no NUL
  character, and no two names match without regard to case. A header
  over the column limit of the database gives the database's message.
- **A malformed file runs no statement.** A missing file, a directory, a
  row with the wrong count of values, and a quoted value with no end give
  an `ok: false` outcome that names the file. No statement of the call
  runs.
- **An import reads at most 32 MiB.** The file enters memory whole, so
  `WorkspaceFiles` checks its size before it reads. The rows go to the
  table in batches, and the import yields to the event loop between
  batches, so an abort and the time limit can fire during the staging.
- **A process can still write the file.** Wait for the process that
  writes the file before the import. The guidance of the tool says so.

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
- **An import is a scratch database.** The backend attaches `:memory:`
  as `import` and stages the rows there, so the detach after each call
  drops it. With `import`, an `ATTACH ... AS import` in the same call
  fails.
- **A call commits its own transaction.** Every agent shares one handle. A
  call that leaves a transaction open gets it rolled back and an `ok: false`
  outcome, so no write from a later call lands inside it.
- **The backend runs one call at a time.** A call waits for the call
  before it, also when two workspaces share one backend. So a call keeps
  its transaction and its provenance to itself.
- **A result keeps one value per column name.** A last statement with two
  columns of one name gives an `ok: false` outcome that asks for `AS`.
- **A call stops between statements and between rows.** `sqlResult` yields
  to the event loop every 256 rows, so an abort and the time limit can
  fire, and other rooms keep running. A call stops after 30 seconds; set
  `timeout` in `sqliteBackend(location, { timeout })` to change it, to a
  value above 0 and at most 2147483. A timeout is an `ok: false` outcome,
  and an abort rejects. A stopped export removes its temporary file and
  leaves the target unchanged.
- **A call does not stop while it waits for the bash resource.** An export
  and an import wait for the running shell operation to end. The time
  limit applies when the wait ends, and the SQL resource stays held for the
  wait.
- **One statement that gives no rows runs to its end.** `node:sqlite` has no
  hook to stop a statement, so the backend cannot stop such a statement
  early. For example, an aggregate over an unbounded recursive query does
  not return.

### Records: append-only tables with provenance

**Three options make the database hold records.** A record is a row that
no agent changes after it lands, with the agent, the room, the
activation, and the exchange that wrote it.

```ts
const sql = sqliteBackend('./data/lab.db', {
  schema:
    'CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, label TEXT, agent TEXT, activation TEXT, at TEXT)',
  appendOnly: ['runs'],
  provenance: true,
});
```

| Option       | Meaning                                                               |
| ------------ | --------------------------------------------------------------------- |
| `schema`     | Statements that run at each open: tables, views, and seed rows        |
| `appendOnly` | The tables that accept INSERT alone. Each must exist after the schema |
| `provenance` | Fill the provenance columns of each append-only table from the call   |

- **The schema runs at each open.** Write it to run again, with
  `CREATE TABLE IF NOT EXISTS` and `INSERT OR IGNORE`. A failure of the
  schema, or an append-only table that does not exist, rejects the call
  that opens the database, and the next call opens it again. The backend
  finds an append-only table by its name in any case, as SQLite does.
- **An append-only table accepts INSERT alone.** An UPDATE, a DELETE, a
  REPLACE, and an upsert that changes a row fail. Temporary triggers on
  the one connection hold the rule, and `recursive_triggers` is on, so a
  REPLACE fires the delete trigger.
- **The backend refuses the statements that lift the guard.** It refuses
  a DROP or an ALTER of an append-only table, a DROP of its triggers, and
  a PRAGMA of `recursive_triggers`, `writable_schema`, or `query_only`.
  The flag `query_only` would stop the writes of every agent on the
  database. The backend reads a name as the SQLite tokenizer does. It
  refuses a DROP, an ALTER, or a PRAGMA whose target it cannot read, for
  example one with a comment inside it. The call stops at that statement.
  A statement outside this list can still lift the guard, for example
  `PRAGMA temp_store`. [Trust](trust.md) states the limit, and backlog
  item F1 holds the allow-list that closes it.
- **The backend also checks the engine.** SQLite changes a flag PRAGMA
  when it compiles the statement, also under `EXPLAIN`. So after each
  compile the backend reads `recursive_triggers`, `writable_schema`, and
  `query_only`, sets back a flag that changed, and refuses the statement.
- **No temporary table hides an append-only table.** SQLite reads an
  unqualified name in `temp` first. After each statement the backend
  drops a temporary table or view with the name of an append-only table,
  and refuses the statement.
- **No call creates a trigger.** A trigger runs in the call of the agent
  that fires it. So a trigger of one agent could insert a row under the
  provenance of another agent, or skip the stamp. With `appendOnly`, the
  backend refuses `CREATE TRIGGER` and `CREATE TEMP TRIGGER`, also the
  `INSTEAD OF` trigger of a view. The text check reads the keywords with
  white space or comments between them. On a Node whose `node:sqlite` has
  `setAuthorizer`, the engine also denies each trigger. On Node 22 the text
  check holds alone. The `schema` can create a trigger, because it runs
  before the guard. That trigger runs in each call.
- **The guard triggers alone call the guard functions.** The stamp calls
  `ambion_provenance`, `ambion_stamp`, and `ambion_stamped`. The backend
  refuses a statement that names one of them, in any quotes. The engine
  also denies a call outside a guard trigger, where Node has an authorizer.
- **Provenance fills the columns that a table declares.** The columns are
  `agent`, `room`, `activation`, `exchange_person`, `exchange_from`, and
  `at`. The `sql` tool passes the provenance of each tool call in
  `SqlRunOptions.provenance`, and a guard trigger after each INSERT writes
  it. An INSERT that sets one of these columns fails. An exchange with no
  person leaves `exchange_person` NULL. A host call with no provenance
  leaves them all NULL. A RETURNING clause gives the row before the
  stamp fills it, so a caller reads the provenance with a SELECT.
- **Provenance needs a table that the stamp can fill.** The stamp finds
  the new row by its rowid, so the backend refuses a table WITHOUT ROWID
  when it opens the database. SQLite writes a DEFAULT before the guard
  reads the new row, so the backend also refuses a provenance column with
  a DEFAULT other than NULL. The message names the table or the column.
- **The stamp fills only the row that its INSERT added.** The guard lets
  the UPDATE of the stamp through: it sets each provenance column from
  NULL to the value of the running call. The stamp marks its row before
  the UPDATE, and the guard refuses an UPDATE of a row with no mark. The
  backend clears the marks before each statement.
- **Only the host writes a row with no provenance.** A seed row of the
  schema and a row of a host call with no provenance keep NULL in each
  provenance column. A row of an agent keeps NULL only where its call has
  no value, such as `exchange_person`. No later call fills a NULL, and no
  UPDATE changes a data column.
- **One agent can stop the writes of every agent.** The guard keeps the
  rows. It does not keep the database open for writes. For example,
  `CREATE UNIQUE INDEX one ON runs ((1))` refuses each INSERT after the
  first row. `PRAGMA foreign_keys = ON` stays on for later calls, and on a
  schema with `REFERENCES` it refuses an INSERT with no parent row. Another
  agent can drop the index or set the PRAGMA back. The refusal of
  `CREATE TRIGGER` also removes a trigger that denies with `RAISE(ABORT)`.
- **The backend does not deduplicate.** A retried activation that inserts
  again inserts again. Give the table a UNIQUE constraint when a row must
  appear once.
- **The records share no journal transaction.** A crash between an INSERT
  and the journal write of the activation can leave a row for an
  activation that the journal never committed. The journal stays the
  record of the room.
- **The guidance names the append-only tables and the provenance
  columns,** so an agent leaves those columns out of an INSERT.

### The SqlBackend interface

**`SqlBackend` holds four properties, and `SqlEnv` holds two.** A new SQL
backend, such as a database server with one account for each agent,
implements them.

| Property                            | Meaning                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `connect(agent, files, signal?)`    | An `SqlEnv` for one agent. A backend with accounts connects as it      |
| `dispose()`                         | Optional. Release local handles, and keep the data                     |
| `label`                             | The name the tool reports and the guidance states, with no credential  |
| `guidance`                          | Optional. The dialect and the limits of the database                   |
| `SqlEnv.run(sql, options, signal?)` | Run the statements in order, and give a preview of the last one's rows |
| `SqlEnv.cleanup()`                  | The resource calls it after each operation                             |

**`files` is the agent's view of the bash backend.** `WorkspaceFiles` has
two methods. Each call is one operation on the bash resource, as the calling
agent, and each resolves `~` and a relative path under the agent's home.

- **`writeFile(path, chunks, signal?)`** creates missing directories, and
  writes the chunks to a temporary file beside `path`, which it then
  renames onto `path`. The rename stays in one folder, so it stays on one
  filesystem. It gives the absolute path.
- **`readFile(path, maxBytes, signal?)`** follows a symbolic link, checks
  the size of the file, and then reads its UTF-8 text. A missing file, a
  path that is not a file, a file that the agent cannot read, and a file
  over `maxBytes` give `{ ok: false, message }`. An abort rejects.

**`run` takes `maxRows`, an optional `export` path, an optional `import`
path, optional `params`, and an optional `provenance`.** With `params`, the
text holds one statement. The backend binds the values to its `?`
placeholders in order, and fails the run when the text holds more than one
statement. An empty list binds nothing. A backend with provenance writes
`provenance` on each row that the run inserts into an append-only table.
An `ok` outcome holds the last statement's `columns`, its first `maxRows`
rows, its `rowCount`, the absolute `export` path when the options named
one, and the `import` path and row count when the options named one. A
statement that the database or the backend refuses gives
`{ ok: false, message }`, and the run stops there. A call past the
backend's time limit gives the same. A fault of the connection or of
`WorkspaceFiles`, and an abort by the caller, reject.

**`sqlResult` does the preview, the count, and the export for a backend.**
The root entry exports it. A backend passes the last statement's columns,
a row iterator, the options, and `files`. It reads the rows once, and
streams the CSV to `files` in chunks. A backend with a native export writes
through `files` itself.

**`sqlImport` does the import for a backend.** The root entry exports it.
A backend passes the path, `files`, and a `SqlImportTable`: `create`
makes the table with the columns of the header, and `insert` adds one
batch of rows. `sqlImport` reads the file, parses it, and gives back the
path and the row count, or `{ ok: false, message }`. The table must be
`import.rows` to the statements of the call, and the backend drops it
after the call.
A backend with a native import, such as `COPY`, reads through `files`
itself.

**Each backend gets its own resource.** A long `bash` command does not
delay a query. A process runs off the bash resource, so it does not delay a
file tool either ([Processes](processes.md#a-process)). `workspace.use` and
`mirror()` reach the bash resource. `workspace.sql` is the SQL resource, for
host code.

**A SQL operation may wait on the bash resource, and a bash operation never
waits on the SQL resource.** An export and an import wait for the running
shell operation to end. Do not await `workspace.sql.use` inside a callback of
`workspace.use`: that callback holds the bash resource. `dispose()` disposes
the SQL resource first, so an export in progress still reaches the bash
resource, and then the bash resource.

**Two resources give no total order across the backends.** Each resource
orders its own operations. A `bash` call and a `sql` call from two agents can
finish in either order.

**The audit log stays on the filesystem of the bash backend.** A `sql` call
runs on the SQL resource. Its entry is an operation on the bash resource, by
the one rule of
[Record every tool call](#record-every-tool-call).

**The SQL cases run on `sqliteBackend` alone.** They live in the SQLite
tests (`packages/workspace/test/support/sql-cases.ts`) until a second SQL
backend exists. That backend moves them back to the conformance entry
(see [The conformance suite](#the-conformance-suite)).

## Declared outputs

**Eleven tools declare their output for `compose`.** Each sets
`compose: { output }` with a TypeBox schema. A `compose` call binds the tool
as its `details` and checks them against the schema at every call
([Compose](compose.md#bindings)). A tool that is not in the table declares
none, so `compose` binds it as text. `write`, `edit`, and
`apply_patch` declare none, because code needs only their success or their rejection.

**Each output has a named type.** The schema carries an `$id`, which is the
name in the `Type` column. The description of `compose` lists `name -> Type`
for each tool, and `describe` renders the type once for all tools that
share it ([Compose](compose.md#the-catalog)). `wait` gives `WaitResult`, a
union of `ProcessResult` and `WaitedResult`. `Process` and `Truncation` are the named types
inside them.

| Tool       | Type             | Declared output                                                                                                      |
| ---------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `sql`      | `SqlResult`      | `database`, `count`, `columns`, `rows`, and `export`, `import`, and `imported` when the call sets them.              |
| `snapshot` | `SnapshotResult` | `refs`: one ref for each path, in order.                                                                             |
| `restore`  | `RestoreResult`  | `ref`, `path` of the file, and `bytes`.                                                                              |
| `read`     | `ReadResult`     | `path`, `text`, and the lines `from`, `to`, `lines`, and `next` and `truncation` when they apply.                    |
| `bash`     | `ProcessResult`  | `process`, `text`, `read`, and `truncation` when the result cut the output.                                          |
| `cancel`   | `ProcessResult`  | The same facts as `bash`.                                                                                            |
| `ps`       | `PsResult`       | `processes`: the facts of each process of the caller.                                                                |
| `wait`     | `WaitResult`     | On one handle, the facts of `bash`. On several, `processes` and `ended`.                                             |
| `repos`    | `ReposResult`    | `server`, and `repositories` with the id, branches, and clone URL of each.                                           |
| `fork`     | `ForkResult`     | `repository`, `source`, `url`, and `clone` when the call made a working copy.                                        |
| `fetch`    | `FetchResult`    | `process`, `handle`, `owner`, `path`, `status`, `mediaType`, `bytes`, `sha256`, `ref`, `file`, and `json` or `text`. |

**The `read` details give the text with no notice.** `text` holds the lines
that the result shows, and the notice lines of a direct call stay out of it.
`from` and `to` are the first and the last line of `text`, counted from 1.
`lines` is the count of lines in the file. It is present when the scan
reached the end of the file, and absent when the view ended before it.
`next` is the offset that continues the read. It is present when lines
remain after a `limit` or after the cut at 2000 lines or 50 KB.
`truncation` is present with that cut. Its totals count the lines and the
bytes that the scan saw. When the first line alone exceeds 50 KB, `text` is
empty, and `truncation.firstLineExceedsLimit` is true. For an image, `text`
is empty, `image.mimeType` names the format, and the other line fields are
absent. The `text` of a `read` and of a process tool is also in the content
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

**The git, snapshot, and fetch tools declare the facts that they already
report.** `repos` gives `repositories` as data, with the branches and the
hash of each, so code reads no table. `restore` gives the
absolute path that it wrote. `fetch` gives the status, the digest, the ref,
and the export path, and it gives the JSON body parsed.

**The `sql` details hold the rows that the tool already reads.** `count` is
the count of every row of the last statement. `columns` names its columns.
`rows` holds the preview rows, up to the limit `rows`, one object for each
row. A row value is text, a number, or `null`. A blob is its bytes as
lowercase hex, as the CSV export writes it. A `bigint` is its decimal digits
as text, and a number that is not finite is its text.

**The process facts come from the process table
([Processes](processes.md)).** `process` holds the handle, the
state, the command, and the times of one process. `text` holds the new
output that the result shows, with no bracketed line. `read` holds the
`from` and `to` of those bytes as offsets in the output file. `wait` on
several handles gives `processes`, with every state in the order of the
handles, and `ended`, with the details of each process that ended. A call
that fails on a process that ended badly throws a `ToolFailure` with
the same facts in `details`. A binding copies them to `error.details`. The
`bash` description states this rule for the model.

**The schema is the one source of the type.** The details type of each tool is
`Static` of its schema, so the schema and the type cannot drift. The schema of
`truncation` lists the fields of `ShellOutputTruncation`, and a type test pins
that the two stay assignable. A schema with an `$id` renders once as a
named type in the catalog of `compose`: `Process`, `ProcessResult`,
and `Truncation`. A `Static` type holds mutable arrays, so a tool
copies a readonly array into its details.

## Build a bash backend

`BashBackend` uses [the resource contract](resources.md#the-resource-contract).

The memory and directory backends export from the package
`@ambionframework/just-bash`, which depends on the workspace. The root entry
names `WorkspaceEnv`, the port of a bash backend ([The port](#the-port)).
`BashBackend` extends `ResourceBackend<WorkspaceEnv>` and adds
optional guidance about the backend's own shell and a required `layout` (see
[The layout and the host identity](#the-layout-and-the-host-identity)).
The workspace binds its tools over every backend.
`openWorkspace` opens the bash resource, builds the four file tools, and
binds them to its `use` method. It also opens
the process table and builds the four process tools over it
([Processes](processes.md)). `workspace.processes` gives the host the
processes of this run ([The host's view](processes.md#the-hosts-view)).
`Workspace` adds `tools()`, `mirrorAgent`, and `mirror()` to the resource surface.
Direct file operations and file tool calls use the bash resource.

**A new backend implements `connect()` and `WorkspaceEnv`.** Use the
shared helpers below and name the backend's `layout`. Supply guidance for
its shell and pass `@ambionframework/workspace/conformance`. The backend
loads no just-bash.

**The root entry also exports the environment helpers a new `WorkspaceEnv`
backend needs.** The just-bash backends and the workstation both build on
them.

| Helper                       | What it does                                                             |
| ---------------------------- | ------------------------------------------------------------------------ |
| `resolvePath`                | Holds the `~` and relative path rule                                     |
| `HomeEnv`                    | A base class: the file methods, over `FileOperations` and `classify`     |
| `Deadline`, `withDeadline`   | Tell an abort apart from a timeout; turn a thrown error into `unknown`   |
| `DEFAULT_TIMEOUT_SECONDS`    | The 30 seconds a command gets when its caller names no timeout           |
| `MAX_TIMER_SECONDS`          | The 2,147,483 seconds a timer holds: the ceiling of each timeout         |
| `boundedView`, `deliverView` | Build the bounded output view, and hand it to `onUpdate` with the result |
| `randomName`                 | Names a temporary file beside its target                                 |
| `runScript`                  | Runs one script, and gives its exit code and its output as text          |
| `shellQuote`                 | Puts one word in single quotes for `bash`                                |

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

These helpers import no just-bash, so a backend over any filesystem builds
a `WorkspaceEnv` on them.

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

| Name                                | What it does                                                   |
| ----------------------------------- | -------------------------------------------------------------- |
| `cwd`                               | The home of the agent, and the directory of a relative path    |
| `absolutePath`, `canonicalPath`     | The absolute path, and the path with every link resolved       |
| `readTextFile`, `readBinaryFile`    | Read a file as text or as bytes                                |
| `readRange(path, start, length)`    | Read at most `length` bytes from the byte `start`, at any size |
| `writeFile`, `appendFile`           | Create or extend a file, and create each missing parent        |
| `renameFile`, `remove`, `createDir` | Move a path, remove a path, and make a directory               |
| `fileInfo`, `listDir`, `exists`     | The facts of a path, the children of a directory, and presence |
| `exec(command, options, signal?)`   | Run a command, and give the exit code and the truncation       |
| `cleanup()`                         | Release what the operation held                                |

`exec` options are `cwd`, `env`, `timeout`, `grace`, `capture`, and
`onUpdate`. `capture.limits` bounds the output view. `onUpdate` receives
the one `ShellOutputView` after the command ends and before `exec` resolves.

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

The memory and directory backends run the suite first
(`packages/just-bash/test/conformance.test.ts`). A new backend runs it
before it takes on tool-specific tests of its own. The workspace package
runs the suite on the memory backend to test the suite itself
(`packages/workspace/test/conformance.test.ts`).

**The SQL cases of a `SqlBackend` run in the SQLite tests.** A fixture
has the same shape, with an `open()` that returns a fresh `SqlBackend`.
The cases check the rows of the last statement, NULL as `null`, a last
statement with no result, a refused statement as an outcome that stops
the run, one database for every agent, and an abort before the first
statement. `sqliteBackend` in memory and on a file runs them
(`packages/workspace/test/sqlite.test.ts`).

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
virtual Unix filesystem and shell
for tools, with JavaScript and Python execution available. Network commands
are absent. Each shell also runs `git` from just-git, with the agent's name as
the locked author and no network access. just-bash is single-user: agents sharing one resource can read
each other's homes. The default workspace does not provide operating-system isolation between
agents or distributed ownership of a shared directory. Hosts own credentials
and authorization for external services.

Backends perform raw filesystem I/O below the resource. They do not keep a
second operation queue.

[Build a bash backend](#build-a-bash-backend) states the implementation
requirements and the shared helpers.

### The null device

**`/dev/null` discards writes and reads empty on both backends.** A
redirect to it, and a `write` tool call on it, change nothing. The device
lives in a layer above the filesystem, so the directory backend writes no
`dev` entry under its root and the memory backend holds no `/dev` file.

**The standard devices are present on both backends.** `/dev/zero`,
`/dev/stdin`, `/dev/stdout`, `/dev/stderr` and `/dev/fd` exist and read
empty. `/dev/zero` does not stream bytes. `ls /dev` lists the same names on
each backend.
