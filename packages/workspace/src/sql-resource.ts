/**
 * A read-only SQL resource: the second binding of the neutral resource contract.
 *
 * The resource owns one SQLite database that lives beside the journal and never
 * shares a transaction with it. An agent reads with `query` and appends with
 * `record`. `query` runs on a handle that refuses every write. `record` is the
 * only mutation path: a parameterized INSERT into a table that the host lists
 * in `writable`. It stamps the calling agent, room, activation, and exchange
 * into the columns that the table declares for them.
 *
 * The resource does not deduplicate. A retried activation that calls `record`
 * again inserts again. The application owns the idempotency of its own effects,
 * for example with a UNIQUE column and INSERT OR IGNORE in its schema.
 *
 * This module is separate from the just-bash `sql` tool. That tool runs
 * statements on a database inside the workspace filesystem. This resource
 * opens its own database file through `node:sqlite`.
 */

import { DatabaseSync } from 'node:sqlite';
import { defineTool, type ToolBundle, type ToolContext } from '@ambionframework/ambion';
import { Type } from 'typebox';
import { callEnvelope } from './call-envelope.ts';
import { markdownTable } from './markdown-table.ts';
import {
	openResource,
	type ResourceBackend,
	type ResourceEnv,
	type WorkspaceResource,
} from './resource.ts';
import type { SqlValue } from './sql-backend.ts';

/** The columns `record` fills from the tool context, when the table declares them. */
export const PROVENANCE_COLUMNS = [
	'agent',
	'room',
	'activation',
	'exchange_owner',
	'exchange_from',
	'at',
] as const;

/** The provenance one `record` call carries. An absent field leaves its column NULL. */
export type SqlProvenance = Partial<Record<(typeof PROVENANCE_COLUMNS)[number], string>>;

/** What a caller of `use` reaches. */
export interface SqlResourceEnv extends ResourceEnv {
	/** Run one statement on the read-only handle and return its rows. */
	query(sql: string): Record<string, SqlValue>[];
	/** Insert one row into a writable table. Returns the new rowid. */
	record(table: string, values: Record<string, SqlValue>, provenance?: SqlProvenance): number;
}

export interface SqlResourceOptions {
	/** The resource name. It follows the `openResource` name rule. */
	name: string;
	/** A database file path, or `:memory:` for a database that lives with the resource. */
	location: string;
	/** Statements that run at every open: tables, views, and seed rows. Write them to run again. */
	schema?: string;
	/** The tables `record` may append to. `record` refuses every other table. */
	writable?: readonly string[];
	/** How many rows the `query` preview shows. The default is 50. */
	maxRows?: number;
}

/** A SQL resource: the owner, and the tools an agent uses. */
export interface SqlResource extends WorkspaceResource<SqlResourceEnv> {
	/** The `query` and `record` tools, with the guidance that explains them. */
	tools(): ToolBundle;
}

const PREVIEW_ROWS = 50;

let memoryCounter = 0;

const GUIDANCE =
	'The SQL resource holds structured records. Use `query` to read with one SELECT statement, and add a LIMIT to a large table. ' +
	'Use `record` to append one row to a table that accepts records. `query` cannot change data. ' +
	'The room stamps your name, the activation, and the exchange into the provenance columns of a recorded row.';

/** Open one SQL resource. The two handles stay open until `dispose`. */
export function openSqlResource(options: SqlResourceOptions): SqlResource {
	const maxRows = options.maxRows ?? PREVIEW_ROWS;
	const handles = openHandles(options);
	const owner = openResource<SqlResourceEnv>({
		name: options.name,
		backend: sqlBackend(handles, new Set(options.writable ?? [])),
	});
	const close = (): void => {
		handles.reader.close();
		handles.writer.close();
	};
	// The handles close after the owner drains its queue.
	return Object.freeze({
		name: owner.name,
		use: owner.use,
		tools: () => bundle(owner, maxRows),
		dispose: closing(owner, close),
	});
}

interface Handles {
	reader: DatabaseSync;
	writer: DatabaseSync;
}

/** Open the writer, run the schema on it, then open the reader. */
function openHandles(options: SqlResourceOptions): Handles {
	const memory = options.location === ':memory:';
	memoryCounter += 1;
	const target = memory
		? `file:ambion-sql-${options.name}-${memoryCounter}?mode=memory&cache=shared`
		: options.location;
	const writer = new DatabaseSync(target);
	try {
		if (options.schema !== undefined) writer.exec(options.schema);
		const reader = new DatabaseSync(target, { readOnly: true });
		return { reader, writer };
	} catch (error) {
		writer.close();
		throw error;
	}
}

/** A `dispose` that closes the handles once the owner finishes. */
function closing(owner: WorkspaceResource<SqlResourceEnv>, close: () => void): () => Promise<void> {
	let closed = false;
	return async () => {
		await owner.dispose();
		if (closed) return;
		closed = true;
		close();
	};
}

function sqlBackend(
	handles: Handles,
	writable: ReadonlySet<string>,
): ResourceBackend<SqlResourceEnv> {
	const env: SqlResourceEnv = {
		query: (sql) => runQuery(handles.reader, sql),
		record: (table, values, provenance) =>
			runRecord(handles.writer, writable, table, values, provenance),
		cleanup: async () => undefined,
	};
	return {
		connect: async () => env,
		dispose: async () => undefined,
	};
}

/** Run one statement. `query_only` is set before each run, so an earlier PRAGMA cannot lift it. */
function runQuery(reader: DatabaseSync, sql: string): Record<string, SqlValue>[] {
	reader.exec('PRAGMA query_only = ON');
	return reader.prepare(sql).all() as Record<string, SqlValue>[];
}

function quoteName(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function tableColumns(writer: DatabaseSync, table: string): Set<string> {
	const rows = writer.prepare(`PRAGMA table_info(${quoteName(table)})`).all();
	return new Set(rows.map((row) => String(row.name)));
}

/** The provenance columns to fill: those the table declares and the call supplies. */
function stampedColumns(columns: Set<string>, provenance?: SqlProvenance): [string, string][] {
	const stamped: [string, string][] = [];
	for (const name of PROVENANCE_COLUMNS) {
		const value = provenance?.[name];
		if (columns.has(name) && value !== undefined) stamped.push([name, value]);
	}
	return stamped;
}

function checkColumns(table: string, columns: Set<string>, names: string[]): void {
	for (const name of names) {
		if ((PROVENANCE_COLUMNS as readonly string[]).includes(name) && columns.has(name)) {
			throw new Error(`Column '${name}' of '${table}' is reserved for provenance.`);
		}
		if (!columns.has(name)) throw new Error(`Table '${table}' has no column '${name}'.`);
	}
}

function runRecord(
	writer: DatabaseSync,
	writable: ReadonlySet<string>,
	table: string,
	values: Record<string, SqlValue>,
	provenance?: SqlProvenance,
): number {
	if (!writable.has(table)) throw new Error(`Table '${table}' does not accept records.`);
	const columns = tableColumns(writer, table);
	checkColumns(table, columns, Object.keys(values));
	const entries: [string, SqlValue][] = [
		...Object.entries(values),
		...stampedColumns(columns, provenance),
	];
	if (entries.length === 0) throw new Error('A record needs at least one value.');
	const names = entries.map(([name]) => quoteName(name)).join(', ');
	const marks = entries.map(() => '?').join(', ');
	const result = writer
		.prepare(`INSERT INTO ${quoteName(table)} (${names}) VALUES (${marks})`)
		.run(...entries.map(([, value]) => value));
	return Number(result.lastInsertRowid);
}

function provenanceOf(ctx: ToolContext): SqlProvenance {
	const { exchange, ...placed } = callEnvelope(ctx);
	return {
		...placed,
		...(exchange === undefined
			? {}
			: { exchange_owner: exchange.owner, exchange_from: String(exchange.from) }),
		at: new Date().toISOString(),
	};
}

const querySchema = Type.Object({
	sql: Type.String({ description: 'One SELECT statement. The resource refuses every write.' }),
	maxRows: Type.Optional(
		Type.Number({
			description: 'How many rows the preview shows. The default is the resource cap.',
		}),
	),
});

const recordSchema = Type.Object({
	table: Type.String({ description: 'A table that accepts records.' }),
	values: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()]), {
		description: 'The column values of the new row. Provenance columns fill themselves.',
	}),
});

function bundle(owner: WorkspaceResource<SqlResourceEnv>, cap: number): ToolBundle {
	const query = defineTool({
		name: 'query',
		label: 'Query',
		description: 'Read rows from the SQL resource with one SELECT statement.',
		parameters: querySchema,
		execute: (params, ctx) =>
			owner.use(
				ctx.agent,
				(env) => renderTable(env.query(params.sql), params.maxRows ?? cap),
				ctx.signal,
			),
	});
	const record = defineTool({
		name: 'record',
		label: 'Record',
		description: 'Append one row to a table of the SQL resource. Returns the new rowid.',
		parameters: recordSchema,
		execute: (params, ctx) =>
			owner.use(
				ctx.agent,
				(env) => {
					const id = env.record(params.table, params.values, provenanceOf(ctx));
					return `Recorded row ${id} in ${params.table}.`;
				},
				ctx.signal,
			),
	});
	return Object.freeze({ tools: Object.freeze([query, record]), guidance: GUIDANCE });
}

/** Render rows as a GitHub Markdown table, capped at `maxRows`, with a footer. */
function renderTable(rows: Record<string, SqlValue>[], maxRows: number): string {
	if (rows.length === 0) return 'No rows.';
	const columns = Object.keys(rows[0] ?? {});
	const shown = rows.slice(0, maxRows);
	const footer =
		rows.length > shown.length
			? `Shows ${shown.length} of ${rows.length} rows. Add a LIMIT.`
			: `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}.`;
	return `${markdownTable(columns, shown)}\n\n${footer}`;
}
