/**
 * The `sql` tool over a SQL backend.
 *
 * A workspace with a SQL backend gives its agents this tool. A workspace
 * with no SQL backend has no `sql` tool. The statements run on the SQL
 * resource. The backend gives back a preview of the last statement's rows and
 * their count. With `export`, the backend writes every row as CSV to the
 * agent's files on the bash backend (`WorkspaceFiles`), and the tool shows
 * the head of the file. With `import`, the backend reads a CSV file from the
 * agent's files into the table `import.rows` for the one call, and the
 * statements copy the rows into the shared tables. Each call passes its
 * provenance, so a backend with append-only tables writes it on each row.
 */

import {
	type AmbionTool,
	contentText,
	defineTool,
	type ToolContext,
} from '@ambionframework/ambion';
import {
	type AgentToolResult,
	BACKGROUND_CONTEXT,
	withAbortSignal,
} from '@earendil-works/pi-agent-core';
import { type Static, Type } from 'typebox';
import { callEnvelope } from './call-envelope.ts';
import type { Capability } from './capability.ts';
import { formatBytes } from './format-bytes.ts';
import { markdownTable } from './markdown-table.ts';
import type { WorkspaceResource } from './resource.ts';
import type {
	SqlBackend,
	SqlEnv,
	SqlOutcome,
	SqlProvenance,
	SqlRunOptions,
} from './sql-backend.ts';
import { IMPORT_TABLE, MAX_IMPORT_BYTES } from './sql-import.ts';
import { csvHeader, csvRecord, NULL_SENTINEL } from './sql-result.ts';

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
	rows: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: MAX_PREVIEW_ROWS,
			description: `How many rows the preview shows, up to ${MAX_PREVIEW_ROWS}. The default is 50.`,
		}),
	),
});

type SqlParams = Static<typeof sqlSchema>;

/** What the tool needs from the workspace: the SQL resource and the database name. */
interface SqlToolOptions {
	readonly sql: WorkspaceResource<SqlEnv>['use'];
	readonly database: string;
}

/** Guidance for the `sql` tool over a SQL backend that the workspace names `database`. */
function sqlToolGuidance(database: string): string {
	return [
		`sql runs statements on one shared database, ${database}. Every agent queries this`,
		`database. Put structured data that a colleague needs here as a named table or view:`,
		`the colleague queries it by its name at once, with no copy. Reach this database with`,
		`sql alone. The`,
		`tool shows the last result as a table and keeps the data in the database. Set export to`,
		`write the full result as a CSV file in your workspace for another tool or script.`,
		`Set import to read a CSV file with a header from your workspace, up to ${formatBytes(MAX_IMPORT_BYTES)}. Its rows`,
		`are the table ${IMPORT_TABLE} for that call alone: every value is text, and \\N is NULL. Copy`,
		`them in the same call with INSERT INTO ... SELECT, and CAST each value. Wait for the`,
		`process that writes the file before you import it.`,
	].join('\n');
}

/** The SQL capability: the `sql` tool over the SQL resource, its note, and the note of the backend. */
export function sqlCapability(
	backend: SqlBackend,
	resource: WorkspaceResource<SqlEnv>,
): Capability {
	const { label, guidance } = backend;
	return {
		tools: [createSqlTool({ sql: resource.use, database: label })],
		notes: [sqlToolGuidance(label), guidance],
	};
}

/** Build the `sql` tool that runs on the SQL resource. */
function createSqlTool(options: SqlToolOptions): AmbionTool {
	return defineTool({
		name: 'sql',
		label: 'SQL',
		description:
			'Run statements on the shared database. Share a table or a view; it needs no copy. Set export to write a CSV file, and import to read one.',
		parameters: sqlSchema,
		execute: (params: SqlParams, ctx) => run(options, params, ctx),
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
		maxRows: params.rows ?? PREVIEW_ROWS,
		provenance: provenanceOf(ctx),
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

/** The provenance of one tool call: its envelope, and the time. */
function provenanceOf(ctx: ToolContext): SqlProvenance {
	const { exchange, ...placed } = callEnvelope(ctx);
	return {
		...placed,
		...(exchange === undefined
			? {}
			: {
					...(exchange.person === undefined ? {} : { exchange_person: exchange.person }),
					exchange_from: String(exchange.from),
				}),
		at: new Date().toISOString(),
	};
}

/** `result` with a first line that names the imported file and counts its rows. */
function withImport(result: SqlResult, imported: { path: string; rows: number }): SqlResult {
	const { path, rows } = imported;
	const line = `Imported ${rows} ${plural(rows)} from ${path} into ${IMPORT_TABLE}.`;
	const text = contentText(result.content);
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

/** A statement the database refused: an error whose text names the database and the fault. */
function failed(database: string, message: string): never {
	const text = message.trim() === '' ? 'The query failed.' : message.trim();
	throw new Error(`SQL error on ${database}:\n${text}\nCorrect the statement and run it again.`);
}

function report(text: string, details: SqlDetails): SqlResult {
	return { content: [{ type: 'text', text }], details };
}
