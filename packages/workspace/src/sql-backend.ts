/**
 * The SQL backend: a shared database beside the bash backend.
 *
 * Every workspace has a bash backend. A SQL backend is optional. When a
 * workspace has one, the `sql` tool runs its statements on this backend,
 * under a resource of its own. The database need not live on the filesystem
 * of the bash backend.
 *
 * `connect(agent, files)` gives one agent an environment over the
 * database. `files` is the agent's view of the bash backend: the backend
 * writes a result file there, and gives back a preview of the rows. It
 * also reads a CSV file there for an import. A backend with accounts
 * connects as that agent. A backend with one file gives every agent the
 * same handle.
 *
 * This module holds types only, so the root entry loads no database
 * driver. `docs/workspace.md` states the contract.
 */

import type { ResourceEnv, WorkspaceAgent } from './resource.ts';

/** A value that a SQL database stores. */
export type SqlValue = string | number | bigint | Uint8Array | null;

/** A value that a caller binds to a `?` placeholder: text, a number, or null. */
export type SqlParam = string | number | null;

/** One result row, keyed by column name. */
export type SqlRow = Readonly<Record<string, SqlValue>>;

/**
 * What one `readFile` gives back. A file that is missing, that is not a
 * file, that the agent cannot read, or that holds more than `maxBytes`, is
 * an `ok: false` outcome with a message for the agent.
 */
export type WorkspaceRead =
	| {
			readonly ok: true;
			/** The absolute path of the file. */
			readonly path: string;
			readonly text: string;
	  }
	| { readonly ok: false; readonly message: string };

/**
 * What a SQL backend reaches of the bash backend: the calling agent's
 * files. Each call is one operation on the bash resource, as that agent.
 */
export interface WorkspaceFiles {
	/**
	 * Read the UTF-8 text of `path`, when it holds at most `maxBytes`
	 * bytes. `~` and a relative path resolve under the agent's home. The
	 * read follows a symbolic link, and checks the size before it reads.
	 */
	readFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<WorkspaceRead>;
	/**
	 * Write `chunks` to `path`, and give its absolute path. `~` and a
	 * relative path resolve under the agent's home, and missing parent
	 * directories are created. The file replaces `path` only after every
	 * chunk lands, so a failure leaves `path` unchanged.
	 */
	writeFile(
		path: string,
		chunks: Iterable<string> | AsyncIterable<string>,
		signal?: AbortSignal,
	): Promise<string>;
}

/**
 * Who made one call, and when: the fields that a backend with provenance
 * writes into the columns of the same names. An absent field leaves its
 * column NULL.
 */
export interface SqlProvenance {
	/** The name of the agent. */
	readonly agent?: string;
	readonly room?: string;
	readonly activation?: string;
	/**
	 * The person of the exchange that was open when the activation read the
	 * record. An exchange with no person leaves the column NULL.
	 */
	readonly exchange_person?: string;
	/** The seq that opened that exchange, as text. */
	readonly exchange_from?: string;
	/** The time of the call, as an ISO 8601 string. */
	readonly at?: string;
}

/** What one `run` gives back, and where it writes the full result. */
export interface SqlRunOptions {
	/** How many rows of the last statement the outcome holds. It rounds down; below 0 is 0. */
	readonly maxRows: number;
	/** A workspace path for every row of the last statement, as CSV. */
	readonly export?: string;
	/**
	 * A workspace path of a CSV file. Its rows are the table `import.rows`
	 * for this run alone, before the first statement runs.
	 */
	readonly import?: string;
	/**
	 * Values for the `?` placeholders of the one statement of `sql`, in
	 * order. The backend binds them as values, so a quote or a keyword in a
	 * value cannot change the statement. A run with `params` and more than
	 * one statement fails. An empty list binds nothing.
	 */
	readonly params?: readonly SqlParam[];
	/**
	 * Who makes this run. A backend with provenance writes it on each row
	 * that the run inserts into an append-only table. The `sql` tool sets
	 * it from the tool call.
	 */
	readonly provenance?: SqlProvenance;
}

/** What one import staged: the absolute path of the file, and its row count. */
export interface SqlImported {
	readonly path: string;
	readonly rows: number;
}

/**
 * What one `run` gives back. A statement that the database or the backend
 * refuses is an `ok: false` outcome with the message, and so is a call
 * that runs past the backend's time limit. A fault of the connection or of
 * `WorkspaceFiles`, and an abort by the caller, reject the promise.
 */
export type SqlOutcome =
	| {
			readonly ok: true;
			/** The columns of the last statement. A statement with no result has none. */
			readonly columns: readonly string[];
			/** The first `maxRows` rows of the last statement. */
			readonly rows: readonly SqlRow[];
			/** How many rows the last statement gave, in all. */
			readonly rowCount: number;
			/** The absolute path of the export, when the options named one. */
			readonly export?: string;
			/** The file and the row count of the import, when the options named one. */
			readonly import?: SqlImported;
	  }
	| { readonly ok: false; readonly message: string };

/**
 * Where `sqlImport` puts the rows of a CSV file: a table that lives for one
 * run. `create` makes the table with the columns of the header, and
 * `insert` adds one batch of rows. Every value is text or null.
 */
export interface SqlImportTable {
	create(columns: readonly string[]): void | Promise<void>;
	insert(rows: readonly (readonly (string | null)[])[]): void | Promise<void>;
}

/** What one agent reaches through a SQL backend. */
export interface SqlEnv extends ResourceEnv {
	/**
	 * Run one or more statements in order. The outcome holds a preview of
	 * the last statement's rows and their count. With `options.export`, the
	 * backend writes every row of the last statement to that path through
	 * `WorkspaceFiles`. With `options.import`, the backend reads that CSV
	 * file through `WorkspaceFiles` into the table `import.rows` first, and
	 * drops the table after the run. The run stops at the first statement
	 * that fails. An aborted `signal` rejects before the next
	 * statement runs. With `options.params`, the text holds one statement.
	 */
	run(sql: string, options: SqlRunOptions, signal?: AbortSignal): Promise<SqlOutcome>;
}

/**
 * A shared database that a workspace opens beside its bash backend. The
 * workspace opens a resource over it and passes each agent's
 * `WorkspaceFiles` to `connect`.
 */
export interface SqlBackend {
	/**
	 * The label of the database that the `sql` tool reports and the guidance
	 * states: a file path, or an address with no credential in it.
	 */
	readonly label: string;
	/** Guidance about this database: its dialect and its limits. */
	readonly guidance?: string;
	connect(agent: WorkspaceAgent, files: WorkspaceFiles, signal?: AbortSignal): Promise<SqlEnv>;
	/** Release host-local resources, and keep the data. */
	dispose?(): Promise<void>;
}
