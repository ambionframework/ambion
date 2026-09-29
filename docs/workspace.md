# The workspace

**The workspace is the Pi binding of the resource contract.** The optional
`@ambionframework/workspace` package provides a workspace resource and its
tools. The package `@ambionframework/just-bash` provides the memory and
directory backends over just-bash. A workspace has one bash backend,
and it can have one SQL backend
([Query the shared database](#query-the-shared-database)) and one git
backend ([Git](git.md)). Agents receive access through
ordinary tool bundles. Workspace files remain separate from the
collaboration journal. [Resources](resources.md) states the contract, the
SQL binding, and the rules for references and provenance.

## Open one resource

```ts
import { openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/just-bash';

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
`snapshot()` write as it.** `Workspace.host` exposes this identity. A
backend with real accounts gives it credentials, the same as any other agent
it connects.

```ts
const drive = openWorkspace({ name: 'town', backend: { bash: memoryBackend() } });
console.log(drive.host); // { name: 'town-host' }
```

## Give the resource to an agent

`workspace.tools()` returns an ordinary Ambion `ToolBundle`. The neutral layer
binds three file tools first: `read`, `write`, and `edit`. The five process
tools come next: `bash`, `ps`, `status`, `wait`, and `cancel`. `bash` starts
each command as a background process and returns its handle
([Processes](processes.md)). The bundle also reminds each seat of its
processes at the start of an activation. `snapshot` and `restore` come next:
one freezes files and gives the refs that cite them, and the other puts the
bytes of a cited snapshot in the agent's files
([Snapshot a file](#snapshot-a-file)).
A workspace
with a SQL backend adds `sql`
([Query the shared database](#query-the-shared-database)). A workspace with
no SQL backend has no `sql` tool. The bash backend adds its own guidance
about its own shell, if it has any. The bundle binds every tool through the
resource owner and keeps one stable identity. Pass the bundle in an agent's `bundles` field.

**A failure is an error, and every result tells the agent what to do.**
The workspace tools share these rules:

- **A failure is a tool error.** A harness and a host tell it from a
  success by the error flag of the result. A bad path, an unknown handle,
  and the limit of running processes are failures. A bad ref, a refused
  statement, a refused fork or clone, and a process that ended badly are
  failures too. So are an abort, a fault of a backend, and an invalid
  argument.
- **The text of a failure states the problem and the next step.** A
  process that ended badly gives its output and its state line. A refused
  statement names the database and the fault. An unknown handle names
  `bash`, which returns the handle.
- **The file tools are Pi's.** `read`, `write`, and `edit` report a bad
  path as a tool error, as Pi does.

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
`activation`, and `exchange`. [Resources](resources.md#references-and-provenance)
states what the last three hold. The executor builds the context once per
call and freezes it. `ToolContext` holds no workspace or resource field.

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
import { BACKGROUND_CONTEXT, openLog, openWorkspace } from '@ambionframework/workspace';
import { directoryBackend } from '@ambionframework/just-bash';

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
owner's queue (see [Open one resource](#open-one-resource)). A caller that
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
`maxBytes` to change the 5 MiB rotation threshold. `maxBytes` must be a
positive, finite number. An agent reads the log
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
line naming the call and the failure, in place of the full entry. The
fallback retries the write alone. A failure to create the log's directory
goes to `onError` and never becomes this notice.

**A directory, write, or rotation failure calls `onError`.** The tool call
itself keeps its own result. The log is best-effort: a full disk delays the
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
started; it needs no other setup.

```ts
import { startRoom } from '@ambionframework/ambion';
import { openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/just-bash';

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
room's own `Message` type plus `room`, the room's name. Every kind also
carries `at`, an ISO timestamp the runtime stamps when the message lands.
`refs` is absent when the message cites nothing:

| `kind`                                  | Fields beyond `room`, `kind`, `seq`, `at`                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `said`                                  | `from`, `to` (absent for a broadcast), `text`, `refs`, and `after` and `owner` on a scheduled say |
| `returned`                              | `to`, `owner`, `message` (the seq of the scheduled say), `text`, `refs`                           |
| `dismissed`                             | `from` (absent for the host), `message` (the seq of the scheduled say)                            |
| `arrived`, `left`, `seated`, `unseated` | `subject`, and `identity` on `arrived` and `seated`                                               |
| `summary`                               | `from`, `to`, `text`, `covers: { from, through }`, `refs`                                         |

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
default is `workspace.host`. A relative path resolves against the working
directory of that agent. `workspace.readSnapshot(ref)` gives the bytes back.

```ts
const [report] = await drive.snapshot(['/home/analyst/report.md'], {
  agent: { name: 'analyst' },
});
await visit.send({ text: 'The report for review.', refs: [report] });
const bytes = await drive.readSnapshot(report);
```

**The `snapshot` tool gives an agent the same refs.** It reads the files as
the calling agent, and its result lists one ref for each path. The guidance
tells every agent to cite a file with a snapshot ref in the `refs` of a
say. The audit log records each call.

| Step | Owner  | What happens                                                                                 |
| ---- | ------ | -------------------------------------------------------------------------------------------- |
| 1    | bash   | The agent that reads finds every file. A path that is not one readable file fails the call.  |
| 2    | bash   | For each file in turn, the agent that reads reads the bytes.                                 |
| 3    | —      | The workspace hashes the bytes with SHA-256.                                                 |
| 4    | object | The host agent, `<name>-host`, puts the bytes under their digest. Then the next file starts. |
| 5    | —      | The workspace gives the refs.                                                                |

**The `restore` tool puts the bytes of a cited snapshot in an agent's files.**
It takes `ref` and an optional `path`. The default path is
`~/snapshots/<digest>/<name>`, where `<name>` is the last part of the path
in the ref. The host agent gets the object on the object owner, and the
workspace checks it. The calling agent then writes the file on the bash
owner and reads it with `read` or `bash`. No agent holds a credential of
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
larger file fails with the backend's own error. The workstation reads a
file of any size.

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
  /** The store that errors name, with no credential: a folder or a bucket URL. */
  readonly store: string;
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

**The default file store writes through the bash owner as the host
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

**The object backend has its own resource owner.** `Workspace.objects`
exposes it for host code. An object operation may wait on the bash owner,
since the default store writes through it. No bash operation waits on the
object owner: `snapshot` reads on the bash owner and then puts on the
object owner, and `restore` gets on the object owner and then writes on the
bash owner. `dispose` drains the SQL owner, the bash owner, the object
owner, and the git owner, in that order, so a use that starts after
`dispose` is refused at once.

**A new object backend passes `objectConformance`** from
`@ambionframework/workspace/conformance`. A harness opens a store and gives
the backend. A harness that can open the same store again gives `reopen`.

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

## Query the shared database

**A workspace has one bash backend, and it can have one SQL backend.**
The `backend` option holds the backends by kind, as `WorkspaceBackends`.
`backend.bash` is a `BashBackend`, and every workspace has one.
`backend.sql` is an optional `SqlBackend`: a shared database that need not
live on the shell's filesystem. `backend.git` is an optional
`GitBackend`: the repositories of the workspace, which [Git](git.md)
describes. `openWorkspace` throws when `bash.gitTransports` does not hold
the transport of the git backend
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
| `rows`    | How many rows the preview shows, up to 1000. The default is 50.    |

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

**`export` writes the full result into the shell's filesystem, and the
tool returns a preview.** Set it when a script or another tool needs the
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
- **A call does not stop while it waits for the bash owner.** An export
  and an import wait for the running shell operation to end. The time
  limit applies when the wait ends, and the SQL owner stays held for the
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
  that opens the database, and the next call opens it again.
- **An append-only table accepts INSERT alone.** An UPDATE, a DELETE, a
  REPLACE, and an upsert that changes a row fail. Temporary triggers on
  the one connection hold the rule, and `recursive_triggers` is on, so a
  REPLACE fires the delete trigger.
- **No statement lifts the guard.** The backend refuses a DROP or an
  ALTER of an append-only table, a DROP of its triggers, and a PRAGMA of
  `recursive_triggers` or `writable_schema`. It refuses a DROP, an ALTER,
  or a PRAGMA whose target it cannot read, for example one with a comment
  inside it. The call stops at that statement.
- **The backend also checks the engine.** SQLite changes a flag PRAGMA
  when it compiles the statement, also under `EXPLAIN`. So after each
  compile the backend reads `recursive_triggers` and `writable_schema`,
  sets back a flag that changed, and refuses the statement.
- **No temporary table hides an append-only table.** SQLite reads an
  unqualified name in `temp` first. After each statement the backend
  drops a temporary table or view with the name of an append-only table,
  and refuses the statement.
- **Provenance fills the columns that a table declares.** The columns are
  `agent`, `room`, `activation`, `exchange_owner`, `exchange_from`, and
  `at`. The `sql` tool passes the provenance of each tool call in
  `SqlRunOptions.provenance`, and a trigger after each INSERT writes it.
  An INSERT that sets one of these columns fails. A host call with no
  provenance leaves them NULL.
- **A row with NULL provenance can take the provenance of a later call.**
  The guard lets the UPDATE of the stamp through: it sets each provenance
  column from NULL to the value of the running call. An agent can run the
  same UPDATE on a row from the schema or from a host call. No UPDATE
  changes a data column or a provenance column that holds a value.
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
two methods. Each call is one operation on the bash owner, as the calling
agent, and each resolves `~` and a relative path under the agent's home.

- **`writeFile(path, chunks, context)`** creates missing directories, and
  writes the chunks to a temporary file beside `path`, which it then
  renames onto `path`. The rename stays in one folder, so it stays on one
  filesystem. It gives the absolute path.
- **`readFile(path, maxBytes, context)`** follows a symbolic link, checks
  the size of the file, and then reads its UTF-8 text. A missing file, a
  path that is not a file, a file that the agent cannot read, and a file
  over `maxBytes` give `{ ok: false, message }`. An abort rejects.

**`run` takes `maxRows`, an optional `export` path, an optional `import`
path, and an optional `provenance`.** A backend with provenance writes
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

**Each backend gets its own resource owner.** A long `bash` command does not
delay a query. A process runs off the bash owner, so it does not delay a file
tool either ([Processes](processes.md#a-process)). `workspace.use` and
`mirror()` reach the bash owner. `workspace.sql` is the SQL owner, for host
code.

**A SQL operation may wait on the bash owner, and a bash operation never
waits on the SQL owner.** An export and an import wait for the running
shell operation to end. Do not await `workspace.sql.use` inside a callback of
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

**The SQL cases run on `sqliteBackend` alone.** They live in the SQLite
tests (`packages/workspace/test/support/sql-cases.ts`) until a second SQL
backend exists. That backend moves them back to the conformance entry
(see [The conformance suite](#the-conformance-suite)).

## The resource contract

The contract lives in [Resources](resources.md).

The memory and directory backends are the Pi binding. They export from the
package `@ambionframework/just-bash`, which depends on the workspace. The root
entry names `WorkspaceEnv`, the Pi `ExecutionEnv` that has a zero-argument
`cleanup()`. `BashBackend` extends `ResourceBackend<WorkspaceEnv>` and adds
optional guidance about the backend's own shell and a required `layout` (see
[The layout and the host identity](#the-layout-and-the-host-identity)). A
backend adds no tool: the workspace binds the same tools over every backend.
`openWorkspace` creates the resource owner, builds the three file tools, and
binds them to its `use` method. It also opens
the process table and builds the five process tools over it
([Processes](processes.md)). `workspace.processes` gives the host the
processes of this run ([The host's view](processes.md#the-hosts-view)).
`Workspace` adds `tools()`, `host`, and `mirror()` to the resource surface.
Direct operations and tool calls share one queue and one lifecycle.

**A new backend implements `connect()` and an `ExecutionEnv`, over the
shared helpers below, and names its own `layout`.** It adds only the tools
and the guidance beyond the ten tools every workspace has, passes
`@ambionframework/workspace/conformance`, and loads no just-bash.

**The root entry also exports the environment helpers a new `ExecutionEnv`
backend needs.** The just-bash backends and the workstation both build on
them.

| Helper                                             | What it does                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `resolvePath`                                      | Holds the `~` and relative path rule                                     |
| `HomeEnv`                                          | A base class: `cwd`, `absolutePath`, `joinPath`, and `readTextLines`     |
| `Deadline`, `withDeadline`                         | Tell an abort apart from a timeout; turn a thrown error into `unknown`   |
| `DEFAULT_TIMEOUT_SECONDS`                          | The 30 seconds a command gets when its caller names no timeout           |
| `boundedView`, `deliverView`                       | Build the bounded output view, and hand it to `onUpdate` with the result |
| `TMP`, `randomName`, `tempDirPath`, `tempFilePath` | Name the temporary paths under `/tmp`                                    |
| `runScript`                                        | Runs one script, and gives its exit code and its output as text          |
| `shellQuote`                                       | Puts one word in single quotes for `bash`                                |

**A backend writes no spill file.** Every `bash` call writes its whole
output to a process file ([Processes](processes.md)), so a backend ignores
`capture.spill`.

These helpers import no just-bash, so a backend over any filesystem builds
an `ExecutionEnv` on them.

## The conformance suite

`@ambionframework/workspace/conformance` holds the `ExecutionEnv` rules the
built-in tools need: a rename that replaces an existing target, a recursive
`createDir`, a forced and a recursive `remove`, the file error codes, `~`
expansion, an abort apart from a timeout, the bounded output view, and a
distinct name under `/tmp` for each temporary file or directory.

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
(`packages/just-bash/test/conformance.test.ts`). A new backend runs it
before it takes on tool-specific tests of its own. The workspace package
runs the suite on the memory backend to test the suite itself
(`packages/workspace/test/conformance.test.ts`).

**The SQL cases of a `SqlBackend` run in the SQLite tests.** A harness
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

Disposal immediately revokes new and queued work. It waits for an active
operation and its cleanup, stops every background process of this run and
waits for it to end ([Processes](processes.md#life-and-disposal)), then asks
the backend to release its local handles once. Concurrent calls join that
release. A successful disposal is terminal. A failed disposal leaves the
resource active and retryable.

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

Backends perform raw filesystem I/O below the owner. They do not keep a
second operation queue.

**A new backend follows one recipe.** It implements `connect()` and an
`ExecutionEnv` over the shared helpers (see [The resource
contract](#the-resource-contract)), names its own `layout`, and adds only
the tools and the shell guidance beyond the ten tools every workspace
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
