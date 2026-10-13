# SQL

## Query the shared database

**`backend.sql` is an optional `SqlBackend`: a shared database that need not
live on the filesystem of the bash backend.** With no SQL backend, the
workspace has no `sql` tool ([Workspace](workspace.md#open-one-resource)
states the backends of a workspace).

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
another agent reads at once.

**`params` binds values to a statement.** Write `?` in the statement and
list the values in `params`: text, a number, or `null`. The backend binds
each value, so a quote or a keyword in a value cannot change the statement.
A whole number binds as an integer. Use `1` or `0` for a boolean. A call with a
non-empty `params` holds one statement. A call with more fails before it
runs any.
A skill [macro](skills.md#write-a-macro) passes each argument that came from the
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
  its transaction to itself.
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

### The schema option

**`schema` prepares the database at each open.** It holds the tables,
views, triggers, and seed rows that the agents share.

```ts
const sql = sqliteBackend('./data/lab.db', {
  schema: 'CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, label TEXT, UNIQUE (label))',
});
```

- **The schema runs at each open.** Write it to run again, with
  `CREATE TABLE IF NOT EXISTS` and `INSERT OR IGNORE`. A failure of the
  schema rejects the call that opens the database, and the next call opens
  it again.
- **A call can change any table.** The backend keeps no table from an
  UPDATE, a DELETE, a DROP, or a trigger. [Trust](trust.md) states the
  limit. A trigger runs in the call of the agent that fires it.
- **The backend does not deduplicate.** A retried activation that inserts
  again inserts again. Give the table a UNIQUE constraint when a row must
  appear once.
- **The rows share no journal transaction.** A crash between an INSERT
  and the journal write of the activation can leave a row for an
  activation that the journal never committed. The journal stays the
  record of the room.

### The SqlBackend interface

**`SqlBackend` holds four properties, and `SqlEnv` holds two.** A new SQL
backend, such as a database server with one account for each agent,
implements them.

- **`SqlBackend`:** `label`, `guidance`, `connect`, and `dispose`.
  `guidance` and `dispose` are optional.
- **`SqlEnv`:** `run` and `cleanup`.

The `./conformance` entry exports no SQL conformance suite.

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

**`workspace.sql` is the SQL resource, for host code.** It has its own queue.

**A SQL operation may wait on the bash resource, and a bash operation never
waits on the SQL resource.** An export and an import wait for the running
shell operation to end. Do not await `workspace.sql.use` inside a callback of
`workspace.use`: that callback holds the bash resource.

**The audit log stays on the filesystem of the bash backend.** A `sql` call
runs on the SQL resource. Its entry is an operation on the bash resource, by
the one rule of
[Record every tool call](workspace.md#record-every-tool-call).
