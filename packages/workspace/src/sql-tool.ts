/**
 * The `sql` tool over a SQL backend.
 *
 * A workspace with a SQL backend gives its agents this tool. A workspace
 * with no SQL backend has no `sql` tool. The statements run on the SQL
 * owner. The backend gives back a preview of the last statement's rows and
 * their count. With `export`, the backend writes every row as CSV to the
 * agent's files on the bash backend (`WorkspaceFiles`), and the tool shows
 * the head of the file. With `import`, the backend reads a CSV file from the
 * agent's files into the table `import.rows` for the one call, and the
 * statements copy the rows into the shared tables.
 *
 * The audit entry of a call runs as one more operation on the bash owner,
 * after the call ends, over `BACKGROUND_CONTEXT`. A cut call still leaves
 * its entry.
 */

import { type AmbionTool, defineTool, type ToolContext } from '@ambionframework/ambion';
import {
	type AgentToolResult,
	BACKGROUND_CONTEXT,
	withAbortSignal,
} from '@earendil-works/pi-agent-core';
import { type Static, Type } from 'typebox';
import type { AuditLog } from './audit.ts';
import type { WorkspaceEnv } from './backend.ts';
import { markdownTable } from './markdown-table.ts';
import type { WorkspaceResource } from './resource.ts';
import type { SqlEnv, SqlOutcome, SqlRunOptions } from './sql-backend.ts';
import { IMPORT_TABLE, MAX_IMPORT_BYTES } from './sql-import.ts';
import { csvHeader, csvRecord, NULL_SENTINEL } from './sql-result.ts';
import { recordedOnShell } from './tools.ts';

/** How many rows the preview shows when the caller names no limit. */
const PREVIEW_ROWS = 50;

/** The most rows one preview shows. A larger result goes to a file through `export`. */
const MAX_PREVIEW_ROWS = 1000;

/** What the tool reports beside its text, for logs and UI. */
interface SqlDetails {
	database: string;
	rows: number;
	export?: string;
	/** The absolute path of the imported file, and its row count. */
	import?: string;
	imported?: number;
}

type SqlResult = AgentToolResult<SqlDetails>;

type Rows = Extract<SqlOutcome, { ok: true }>;

const sqlSchema = Type.Object({
	sql: Type.String({
		description: 'One or more SQL statements. The last query gives the preview.',
	}),
	export: Type.Optional(
		Type.String({
			description:
				'A file path for the full result as CSV. Omit it to keep the result in the database.',
		}),
	),
	import: Type.Optional(
		Type.String({
			description: `A CSV file path. Its rows are the table ${IMPORT_TABLE} for this call alone, as text, with \\N as NULL.`,
		}),
	),
	maxRows: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: MAX_PREVIEW_ROWS,
			description: `How many rows the preview shows, up to ${MAX_PREVIEW_ROWS}. The default is 50.`,
		}),
	),
});

type SqlParams = Static<typeof sqlSchema>;

/** What the tool needs from the workspace: the two owners, the database name, and the audit log. */
export interface SqlToolOptions {
	readonly sql: WorkspaceResource<SqlEnv>['use'];
	readonly shell: WorkspaceResource<WorkspaceEnv>['use'];
	readonly database: string;
	readonly audit?: AuditLog;
}

/** Guidance for the `sql` tool over a SQL backend that the workspace names `database`. */
export function sqlToolGuidance(database: string): string {
	return [
		`sql runs statements on one shared database, ${database}. Every agent queries this`,
		`database, so a table or a view you create is data another agent reads at once. Share`,
		`through a view or a table; this needs no copy. Reach this database with sql alone. The`,
		`tool shows the last result as a table and keeps the data in the database. Set export to`,
		`write the full result as a CSV file in your workspace for another tool or script.`,
		`Set import to read a CSV file with a header from your workspace, up to ${MAX_IMPORT_BYTES / 1024 / 1024} MiB. Its rows`,
		`are the table ${IMPORT_TABLE} for that call alone: every value is text, and \\N is NULL. Copy`,
		`them in the same call with INSERT INTO ... SELECT, and CAST each value. Wait for the`,
		`process that writes the file before you import it.`,
	].join('\n');
}

/** Build the `sql` tool that runs on the SQL owner. */
export function createSqlTool(options: SqlToolOptions): AmbionTool {
	return defineTool({
		name: 'sql',
		label: 'SQL',
		description:
			'Run statements on the shared database. Share a table or a view; it needs no copy. Set export to write a CSV file, and import to read one.',
		parameters: sqlSchema,
		execute: recordedOnShell('sql', options.shell, options.audit, (params: SqlParams, ctx) =>
			run(options, params, ctx),
		),
	});
}

async function run(
	options: SqlToolOptions,
	params: SqlParams,
	ctx: ToolContext,
): Promise<SqlResult> {
	const context =
		ctx.signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(ctx.signal, BACKGROUND_CONTEXT);
	const runOptions: SqlRunOptions = {
		maxRows: params.maxRows ?? PREVIEW_ROWS,
		...(params.export === undefined ? {} : { export: params.export }),
		...(params.import === undefined ? {} : { import: params.import }),
	};
	const outcome = await options.sql(
		ctx.agent,
		(env) => env.run(params.sql, runOptions, context),
		ctx.signal,
	);
	if (!outcome.ok) return failed(options.database, outcome.message);
	const result =
		outcome.export === undefined
			? previewed(options.database, outcome)
			: exported(options.database, outcome, outcome.export);
	return outcome.import === undefined ? result : withImport(result, outcome.import);
}

/** `result` with a first line that names the imported file and counts its rows. */
function withImport(result: SqlResult, imported: { path: string; rows: number }): SqlResult {
	const { path, rows } = imported;
	const line = `Imported ${rows} ${plural(rows)} from ${path} into ${IMPORT_TABLE}.`;
	const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
	return report(`${line}\n\n${text}`, { ...result.details, import: path, imported: rows });
}

/** The report of one preview: a Markdown table of the preview rows. */
function previewed(database: string, outcome: Rows): SqlResult {
	const rows = outcome.rowCount;
	if (rows === 0) return report(`Ran on ${database}. No rows.`, { database, rows });
	return report(table(outcome), { database, rows });
}

/** The report of one export: the head of the file as a CSV block, and the row count. */
function exported(database: string, outcome: Rows, exportPath: string): SqlResult {
	const rows = outcome.rowCount;
	const records = [
		csvHeader(outcome.columns),
		...outcome.rows.map((row) => csvRecord(outcome.columns, row)),
	];
	const block =
		outcome.columns.length === 0 ? '(no rows)' : `\`\`\`csv\n${records.join('\n')}\n\`\`\``;
	const footer = `\n\nWrote ${rows} ${plural(rows)} to ${exportPath}. A NULL value reads as ${NULL_SENTINEL}.`;
	return report(`${block}${footer}`, { database, rows, export: exportPath });
}

/** Render the preview rows as a GitHub Markdown table, with a footer that counts every row. */
function table(outcome: Rows): string {
	const { columns, rows, rowCount } = outcome;
	const footer =
		rowCount > rows.length
			? `\n\nShows ${rows.length} of ${rowCount} rows. Add a LIMIT, or set export for the full result.`
			: `\n\n${rowCount} ${plural(rowCount)}.`;
	return `${markdownTable(columns, rows)}${footer}`;
}

function plural(count: number): string {
	return count === 1 ? 'row' : 'rows';
}

function failed(database: string, message: string): SqlResult {
	const text = message.trim() === '' ? 'The query failed.' : message.trim();
	return report(`SQL error on ${database}:\n${text}`, { database, rows: 0 });
}

function report(text: string, details: SqlDetails): SqlResult {
	return { content: [{ type: 'text', text }], details };
}
