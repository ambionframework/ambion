# Snapshots

**A snapshot gives a message a ref to bytes that cannot change.** Every
workspace has the `snapshot` and `restore` tools, and the host methods
`workspace.snapshot` and `workspace.readSnapshot`. An object backend keeps the
bytes. [Workspace](workspace.md) states the layout, the host identity, and
the other tools.

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
carries. One file holds at most what one object holds
([The object backend](#the-object-backend)). `SNAPSHOT_LIMITS` holds both. A ref longer than 2048 characters is refused.
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

**The workspace gives the key.** It hashes the bytes and passes the digest,
64 lowercase hex digits of SHA-256. A backend refuses any other key with a
`RangeError`, and forms its own key from the digest. No metadata travels with an object: the path and the provenance live
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
([Workstation](workstation.md#the-layout-on-a-server)).

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
bash resource.

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
