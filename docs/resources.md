# Resources

**A resource is application data that an agent's tools reach.** One
contract describes every resource. Two bindings implement it: a filesystem
binding over just-bash and Pi, and a SQL binding over the SQL backend of a
workspace. Every tool call that reaches a resource carries provenance. The
README states the positioning. This page states the contract, the records
of the SQL binding, and the rules for references and provenance.

The [workspace page](workspace.md) covers the filesystem binding.

## The resource contract

`@ambionframework/workspace/resource` is the neutral contract. It exports
`openResource` and the types `ResourceBackend`, `ResourceEnv`,
`WorkspaceAgent`, and `WorkspaceResource`. This entry loads no Ambion runtime
and no model library.

| Name                | Shape                                                    |
| ------------------- | -------------------------------------------------------- |
| `openResource`      | `({ name, backend })` returns a `WorkspaceResource<Env>` |
| `WorkspaceResource` | `name`, `use(agent, op, signal?)`, `dispose()`           |
| `ResourceBackend`   | `connect(agent, signal?)`, optional `dispose()`          |
| `ResourceEnv`       | The smallest environment: one `cleanup()` method         |
| `WorkspaceAgent`    | `{ name }`                                               |

```ts
import { openResource, type ResourceBackend } from '@ambionframework/workspace/resource';

interface NoteEnv {
  readonly notes: string[];
  cleanup(): Promise<void>;
}

const backend: ResourceBackend<NoteEnv> = {
  connect: async () => ({ notes: [], cleanup: async () => {} }),
};

const resource = openResource({ name: 'team-notes', backend });
await resource.use({ name: 'surveyor' }, (env) => {
  env.notes.push('Checked the plan.');
});
await resource.dispose();
```

**One queue serializes every operation.** `use` and `dispose` run one at a
time. The owner calls `cleanup()` on the environment after each operation. A
`use` callback must not await another `use` or `dispose` call on the same
owner. The owner would wait for the callback that is already running.

**Disposal revokes work.** `dispose()` refuses new and queued work at once.
It waits for the active operation and its cleanup, then asks the backend to
release its local handles once. Concurrent calls join that release. A
directory resource keeps its files, and an in-memory resource releases its
cached filesystem. A host deletes the data that it owns. The
[workspace page](workspace.md#dispose-of-a-resource) states the full
lifecycle.

**A binding picks its own `Env`.** The environment extends `ResourceEnv`.
The filesystem binding uses `WorkspaceEnv`, a Pi `ExecutionEnv`. The SQL
binding uses `SqlEnv`, and `workspace.sql` is its owner. `workspace.tools()`
returns the tool bundle of both, which an agent definition lists.

**The contract has no freshness guarantee.** The room's freshness check
governs what an agent says. It does not govern what a tool reads from a
resource. A tool that needs the current state of the room reads the room.

## Keep records in the shared database

**The SQL binding is the SQL backend of a workspace.** `sqliteBackend` from
`@ambionframework/workspace/sqlite` opens one SQLite database through
`node:sqlite`. It needs no model library. The database is a file of its
own. It shares no connection and no transaction with the journal. Agents
reach it through the `sql` tool, and host code through `workspace.sql`
([Query the shared database](workspace.md#query-the-shared-database)).

```ts
import { directoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';

const lab = openWorkspace({
  name: 'lab',
  backend: {
    bash: directoryBackend('./data/lab'),
    sql: sqliteBackend('./data/lab.db', {
      schema: 'CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, label TEXT, agent TEXT)',
      appendOnly: ['runs'],
      provenance: true,
    }),
  },
});
const agent = defineAgent({ ..., bundles: [lab.tools()] });
```

**An append-only table accepts INSERT alone.** An UPDATE, a DELETE, and a
REPLACE of a row fail, and so do a DROP and an ALTER of the table. Other
tables stay open to every statement.

**Provenance fills the columns that a table declares.** With `provenance`,
each INSERT into an append-only table gets the provenance of the call. An
INSERT that sets a provenance column fails.

**The backend does not deduplicate.** A retried activation that inserts
again inserts again. Give the table a UNIQUE constraint when a row must
appear once. The `schema` runs at each open, so write it to run again.

**The records share no journal transaction.** A crash between an INSERT
and the journal write of the activation can leave a row for an activation
that the journal never committed. The journal stays the record of the
room.

## References and provenance

**An artifact is cited as a ref on the record.** A message and a summary
carry `refs`, absolute URIs that the room stores and never reads behind.
[Definitions and tools](agent.md) owns the ref rules. A resource change is
cited by a URI that the resource gives, or by one that the application
chooses.

**A workspace file is cited by a snapshot ref.** The `snapshot` tool and
`workspace.snapshot(paths)` freeze each file and give one ref for it. The
ref names the bytes, so it keeps its meaning when the file changes
([Snapshot a file](workspace.md#snapshot-a-file)). The room does not check
that the workspace holds the copy.

**Provenance names who made a change.** Every tool call receives a
`ToolContext`. It holds `room`, `activation`, and `exchange`. `room` names
the room. `activation` is the id that every event and message of the
activation carries. `exchange` holds the `from` of the exchange that was
open when the activation read the record, and its `person` once a person
spoke in it. It is absent when no exchange was open. All three are absent
outside a room. A binding stamps them where its data allows.

| Binding    | Where provenance lands                                      |
| ---------- | ----------------------------------------------------------- |
| SQL        | The provenance columns of a new row in an append-only table |
| Filesystem | The audit log                                               |

The provenance columns are `agent`, `room`, `activation`, `exchange_person`,
`exchange_from`, and `at`. The `sql` tool passes them in
`SqlRunOptions.provenance`. The backend fills each column that the table
has and that the call supplies. An exchange with no person leaves
`exchange_person` NULL. Host code passes its own `provenance` through
`workspace.sql`.

**Provenance grants no authority.** A tool does not check it to allow or
refuse a call. A tool that needs current state reads the room.

**One contract, two bindings, provenance on every tool call.** The audit log
and the room mirror belong to the filesystem binding. They stay on the
workspace page.
