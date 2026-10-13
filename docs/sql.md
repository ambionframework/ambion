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
  [Trust](trust.md) states the limit of the guard.
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
