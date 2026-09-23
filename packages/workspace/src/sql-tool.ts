/**
 * The `sql` tool over a SQL backend.
 *
 * A workspace with a SQL backend gives its agents this tool in place of the
 * shell `sql` tool of `./sql.ts`. The statements run on the SQL owner. The
 * database need not live on the shell's filesystem.
 *
 * `export` crosses the two backends. The tool runs the query on the SQL
 * owner and holds the rows in memory. It then releases the SQL owner and
 * writes the CSV file on the shell owner. No operation holds both owners,
 * so two calls never wait on each other.
 *
 * The audit entry of a call runs as one more operation on the shell owner,
 * after the call ends, over `BACKGROUND_CONTEXT`. A cut call still leaves
 * its entry.
 */

import { type AmbionTool, defineTool, type ToolContext } from '@ambionframework/ambion';
import {
	BACKGROUND_CONTEXT,
	type Context,
	type ExecutionEnv,
	withAbortSignal,
} from '@earendil-works/pi-agent-core';
import { type Static, Type } from 'typebox';
import type { AuditLog } from './audit.ts';
import type { WorkspaceEnv } from './backend.ts';
import type { WorkspaceResource } from './resource.ts';
import {
	absolutePath,
	ensureParent,
	exported,
	failed,
	NULL_SENTINEL,
	PREVIEW_ROWS,
	previewed,
	type SqlResult,
} from './sql.ts';
import type { SqlEnv, SqlRow, SqlValue } from './sql-backend.ts';
import { auditEntry } from './tools.ts';

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
	maxRows: Type.Optional(
		Type.Number({ description: 'How many rows the preview shows. The default is 50.' }),
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
	].join('\n');
}

/** Build the `sql` tool that runs on the SQL owner and exports through the shell owner. */
export function createBackendSqlTool(options: SqlToolOptions): AmbionTool {
	const record = async (params: SqlParams, ctx: ToolContext, outcome: Outcome): Promise<void> => {
		if (options.audit === undefined) return;
		const audit = options.audit;
		try {
			await options.shell(ctx.agent, (env) =>
				audit.record(env, auditEntry('sql', params, ctx, outcome), BACKGROUND_CONTEXT),
			);
		} catch {
			// The log is best-effort. A closed shell owner does not replace the call's own outcome.
		}
	};
	return defineTool({
		name: 'sql',
		label: 'SQL',
		description:
			'Run statements on the shared database. Share a table or a view; it needs no copy. Set export for a CSV file.',
		parameters: sqlSchema,
		execute: async (params, ctx) => {
			try {
				const result = await run(options, params, ctx);
				await record(params, ctx, { result });
				return result;
			} catch (error) {
				await record(params, ctx, { error });
				throw error;
			}
		},
	});
}

type Outcome = { result: unknown } | { error: unknown };

async function run(
	options: SqlToolOptions,
	params: SqlParams,
	ctx: ToolContext,
): Promise<SqlResult> {
	const context =
		ctx.signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(ctx.signal, BACKGROUND_CONTEXT);
	const outcome = await options.sql(ctx.agent, (env) => env.run(params.sql, context), ctx.signal);
	if (!outcome.ok) return failed(options.database, outcome.message);
	const maxRows = params.maxRows ?? PREVIEW_ROWS;
	const target = params.export;
	if (target === undefined) return previewed(options.database, outcome.rows, maxRows);
	return options.shell(
		ctx.agent,
		(env) => writeExport(env, options.database, outcome.rows, target, maxRows, context),
		ctx.signal,
	);
}

/**
 * Write `rows` as CSV to a temporary file, then move it to `target`. A
 * failed write leaves an existing file at `target` unchanged.
 */
async function writeExport(
	env: ExecutionEnv,
	database: string,
	rows: readonly SqlRow[],
	target: string,
	maxRows: number,
	context: Context,
): Promise<SqlResult> {
	const exportPath = await absolutePath(env, target, context);
	await ensureParent(env, exportPath, context);
	const records = csvRecords(rows);
	const temp = await env.createTempFile({ suffix: '.csv' }, context);
	if (!temp.ok) throw temp.error;
	try {
		const text = records.length === 0 ? '' : `${records.join('\n')}\n`;
		const written = await env.writeFile(temp.value, text, context);
		if (!written.ok) throw written.error;
		const moved = await env.renameFile(temp.value, exportPath, context);
		if (!moved.ok) throw moved.error;
	} finally {
		await env.remove(temp.value, { force: true }, context);
	}
	return exported(database, records.slice(0, maxRows + 1), rows.length, exportPath);
}

/** The CSV records of `rows`: a header from the first row's columns, then one record per row. */
function csvRecords(rows: readonly SqlRow[]): string[] {
	const first = rows[0];
	if (first === undefined) return [];
	const columns = Object.keys(first);
	const header = columns.map(csvText).join(',');
	return [header, ...rows.map((row) => columns.map((name) => csvField(row[name])).join(','))];
}

/** One CSV field: `\N` for NULL, hex for a blob, and RFC 4180 quoting for the rest. */
function csvField(value: SqlValue | undefined): string {
	if (value === null || value === undefined) return NULL_SENTINEL;
	if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
	return csvText(String(value));
}

function csvText(text: string): string {
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
