# Resources

**A resource is application data that an agent's tools reach.** One
contract describes every resource. Two bindings implement it: a filesystem
binding over just-bash and Pi, and a SQL binding over `node:sqlite`. Every
tool call that reaches a resource carries provenance. The README states the
positioning. This page states the contract, the SQL binding, and the rules
for references and provenance.

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
binding uses `SqlResourceEnv`. A binding also adds `tools()`, which returns
the tool bundle an agent definition lists.

**The contract has no freshness guarantee.** The room's freshness check
governs what an agent says. It does not govern what a tool reads from a
resource. A tool that needs the current state of the room reads the room.

## Query a SQL resource

**A SQL resource is the second binding of the resource contract.**
`openSqlResource` from `@ambionframework/workspace/sql` opens one SQLite
database through `node:sqlite`. It needs no model library. The database is a
file of its own. It shares no connection and no transaction with the
journal. The `sql` tool on the workspace page is a different database,
inside the workspace filesystem.

```ts
import { openSqlResource } from '@ambionframework/workspace/sql';

const lab = openSqlResource({
  name: 'lab',
  location: './lab.db',
  schema: 'CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, label TEXT, agent TEXT)',
  writable: ['runs'],
});
const agent = defineAgent({ ..., bundles: [lab.tools()] });
```

**`query` reads and never writes.** It runs one statement on a read-only
handle, and it sets `query_only` before each run. An INSERT, an UPDATE, or a
statement that changes the schema fails. The preview shows 50 rows unless the
caller sets `maxRows`.

**`record` is the only write.** It inserts one row into a table that the host
lists in `writable`. It refuses any other table and any unknown column. It
also refuses a provenance column that the caller sets.

**The resource does not deduplicate.** A retried activation that calls `record`
again inserts again. Give the table a UNIQUE constraint when a row must appear
once. The `schema` runs at every open, so write it to run again.

**The resource shares no journal transaction.** A crash between a `record`
call and the journal write of the activation can leave a row for an
activation that the journal never committed. The journal stays the record of
the room.

## References and provenance

**An artifact is cited as a ref on the record.** A message and a summary
carry `refs`, absolute URIs that the room stores and never reads behind.
[Definitions and tools](agent.md) owns the ref rules. A resource change is
cited by the URI that the application chooses.

**A workspace path is not a ref.** Cite a file with a `file:` URI or another
absolute URI. The room cannot check that the path exists.

**Provenance names who made a change.** Every tool call receives a
`ToolContext`. It holds `room`, `activation`, and `exchange` (`owner` and
`from`). All three are absent outside a room. A binding stamps them where its
data allows.

| Binding    | Where provenance lands                                              |
| ---------- | ------------------------------------------------------------------- |
| SQL        | The `PROVENANCE_COLUMNS` on a recorded row, when the table has them |
| Filesystem | The audit log                                                       |

The `PROVENANCE_COLUMNS` are `agent`, `room`, `activation`, `exchange_owner`,
`exchange_from`, and `at`. `record` fills each column that the table has and
that the context supplies.

**Provenance grants no authority.** A tool does not check it to allow or
refuse a call. A tool that needs current state reads the room.

**One contract, two bindings, provenance on every tool call.** The audit log
and the room mirror belong to the filesystem binding. They stay on the
workspace page.
