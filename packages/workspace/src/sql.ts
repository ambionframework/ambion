/**
 * The `sql` tool: a query interface over one shared SQLite database.
 *
 * The tool runs the agent's statements through the just-bash `sqlite3` command
 * on the shared filesystem. Every agent opens the same file, so a table or a
 * view one agent creates is data another agent queries at once. This is the
 * zero-copy way to share: the data stays in the database, and no agent copies
 * a file. The tool writes a CSV file only when the caller sets `export`, for a
 * script or another tool that reads outside SQL.
 *
 * The default path opens the database in `-json` mode, parses the last result,
 * and shows a Markdown table. It writes nothing to disk. The export path opens
 * the database in `-csv` mode, redirects the full result to the export file,
 * and shows the file's head. Each path runs the query once, so the preview and
 * the stored result agree.
 *
 * just-bash is one implementation of this contract. Its `sqlite3` loads the
 * main database into a WebAssembly engine that has no bridge to the virtual
 * filesystem, so `ATTACH` of a second file cannot open it. `ATTACH ':memory:'`
 * works for a private scratch database inside one call.
 */

import { posix } from 'node:path';
import type {
	AgentHarnessTool,
	AgentToolResult,
	ExecutionEnv,
	ExecutionToolContext,
	ShellExecOptions,
} from '@earendil-works/pi-agent-core';
import { type Static, Type } from 'typebox';

/** The database the tool opens as `main` when the caller names none. */
export const SHARED_DATABASE = '/workspace/shared.db';

/** How many rows the preview shows when the caller names no limit. */
const PREVIEW_ROWS = 50;

/** The CSV text for a NULL value, so a NULL reads apart from an empty string. */
const NULL_SENTINEL = '\\N';

/** The largest `-json` output the default path parses before it asks for a LIMIT. */
const MAX_JSON_BYTES = 1_000_000;

const sqlSchema = Type.Object({
	sql: Type.String({
		description: 'One or more SQLite statements. The last query gives the preview.',
	}),
	database: Type.Optional(
		Type.String({
			description:
				'The database file opened as main. The default is the shared workspace database.',
		}),
	),
	export: Type.Optional(
		Type.String({
			description:
				'A file path for the full result as CSV. Omit it to keep the result in the database.',
		}),
	),
	maxRows: Type.Optional(
		Type.Number({ description: 'How many rows the preview shows. The default is 50.' }),
	),
	timeout: Type.Optional(
		Type.Number({
			description: 'Seconds before the query stops. The default is the shell default.',
		}),
	),
});

type SqlParams = Static<typeof sqlSchema>;

/** What the tool reports beside its text, for logs and UI. */
interface SqlDetails {
	database: string;
	rows: number;
	export?: string;
	truncated?: boolean;
}

type SqlResult = AgentToolResult<SqlDetails>;

/** Create the `sql` tool over the just-bash execution environment. */
export function createSqlTool(): AgentHarnessTool<
	ExecutionToolContext,
	typeof sqlSchema,
	SqlDetails
> {
	return {
		name: 'sql',
		label: 'SQL',
		description:
			'Run SQLite statements on the shared database. Share a table or a view; it needs no copy. Set export for a CSV file.',
		parameters: sqlSchema,
		execute: (_toolCallId, params, signal, _onUpdate, context) => run(context.env, params, signal),
	};
}

async function run(
	env: ExecutionEnv,
	params: SqlParams,
	signal: AbortSignal | undefined,
): Promise<SqlResult> {
	const database = await resolvePath(env, params.database ?? SHARED_DATABASE);
	await ensureParent(env, database);
	const scriptPath = await writeScript(env, params.sql);
	const options: ShellExecOptions = {
		...(signal === undefined ? {} : { abortSignal: signal }),
		...(params.timeout === undefined ? {} : { timeout: params.timeout }),
	};
	const maxRows = params.maxRows ?? PREVIEW_ROWS;
	try {
		if (params.export === undefined)
			return await preview(env, database, scriptPath, maxRows, options);
		const exportPath = await resolvePath(env, params.export);
		await ensureParent(env, exportPath);
		return await exportCsv(env, database, scriptPath, exportPath, maxRows, options);
	} finally {
		await env.remove(scriptPath, { force: true });
	}
}

/** Run the query, parse the JSON result, and show a Markdown table. */
async function preview(
	env: ExecutionEnv,
	database: string,
	scriptPath: string,
	maxRows: number,
	options: ShellExecOptions,
): Promise<SqlResult> {
	const result = await runSqlite(env, ['-json'], database, scriptPath, undefined, options);
	if (result.exitCode !== 0) return failed(database, result.stderr);
	if (result.stdout.length > MAX_JSON_BYTES) {
		const text =
			'The result is large. Add a LIMIT for a preview, or set export to write the full result as CSV.';
		return report(text, { database, rows: 0, truncated: true });
	}
	const rows = parseRows(result.stdout);
	if (rows === undefined) return report(result.stdout.trim(), { database, rows: 0 });
	if (rows.length === 0) return report(`Ran on ${database}. No rows.`, { database, rows: 0 });
	return report(table(rows, maxRows), { database, rows: rows.length });
}

/** Run the query, write the full result as CSV, and show the file's head. */
async function exportCsv(
	env: ExecutionEnv,
	database: string,
	scriptPath: string,
	exportPath: string,
	maxRows: number,
	options: ShellExecOptions,
): Promise<SqlResult> {
	const flags = ['-csv', '-header', '-nullvalue', `'${NULL_SENTINEL}'`];
	const result = await runSqlite(env, flags, database, scriptPath, exportPath, options);
	if (result.exitCode !== 0) {
		await env.remove(exportPath, { force: true });
		return failed(database, result.stderr);
	}
	const head = await env.readTextLines(exportPath, { maxLines: maxRows + 1 });
	const lines = head.ok ? head.value.filter((line) => line !== '') : [];
	const rows = await countRows(env, exportPath);
	const block = lines.length === 0 ? '(no rows)' : `\`\`\`csv\n${lines.join('\n')}\n\`\`\``;
	const footer = `\n\nWrote ${rows} ${plural(rows)} to ${exportPath}. A NULL value reads as ${NULL_SENTINEL}.`;
	return report(`${block}${footer}`, { database, rows, export: exportPath });
}

/** Build one `sqlite3` command that reads the script and, when asked, redirects to a file. */
async function runSqlite(
	env: ExecutionEnv,
	flags: string[],
	database: string,
	scriptPath: string,
	redirect: string | undefined,
	options: ShellExecOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const parts = ['sqlite3', ...flags, quote(database), '<', quote(scriptPath)];
	if (redirect !== undefined) parts.push('>', quote(redirect));
	const result = await env.exec(parts.join(' '), options);
	if (!result.ok) throw result.error;
	return result.value;
}

/** Parse a single JSON array of row objects, or undefined when the output is not one. */
function parseRows(stdout: string): Record<string, unknown>[] | undefined {
	const text = stdout.trim();
	if (text === '') return [];
	if (!text.startsWith('[')) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return Array.isArray(value) ? (value as Record<string, unknown>[]) : undefined;
	} catch {
		return undefined;
	}
}

/** Render rows as a GitHub Markdown table, capped at `maxRows`, with a footer. */
function table(rows: Record<string, unknown>[], maxRows: number): string {
	const columns = Object.keys(rows[0] ?? {});
	const shown = rows.slice(0, maxRows);
	const header = `| ${columns.map(cell).join(' | ')} |`;
	const rule = `| ${columns.map(() => '---').join(' | ')} |`;
	const body = shown.map((row) => `| ${columns.map((name) => cell(row[name])).join(' | ')} |`);
	const footer =
		rows.length > shown.length
			? `\n\nShows ${shown.length} of ${rows.length} rows. Add a LIMIT, or set export for the full result.`
			: `\n\n${rows.length} ${plural(rows.length)}.`;
	return `${[header, rule, ...body].join('\n')}${footer}`;
}

/** One table cell: NULL for a missing value, and pipes and newlines made safe. */
function cell(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Count the CSV data rows, without the header line. */
async function countRows(env: ExecutionEnv, path: string): Promise<number> {
	const result = await env.exec(`wc -l < ${quote(path)}`);
	if (!result.ok) return 0;
	const lines = Number.parseInt(result.value.stdout.trim(), 10);
	return Number.isFinite(lines) ? Math.max(lines - 1, 0) : 0;
}

async function resolvePath(env: ExecutionEnv, path: string): Promise<string> {
	const resolved = await env.absolutePath(path);
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

async function ensureParent(env: ExecutionEnv, path: string): Promise<void> {
	const made = await env.createDir(posix.dirname(path), { recursive: true });
	if (!made.ok) throw made.error;
}

async function writeScript(env: ExecutionEnv, sql: string): Promise<string> {
	const temp = await env.createTempFile({ suffix: '.sql' });
	if (!temp.ok) throw temp.error;
	const written = await env.writeFile(temp.value, sql);
	if (!written.ok) {
		await env.remove(temp.value, { force: true });
		throw written.error;
	}
	return temp.value;
}

/** Single-quote a resolved path for the shell, and refuse a quote in it. */
function quote(path: string): string {
	if (path.includes("'")) throw new Error(`A path must not contain a single quote: ${path}`);
	return `'${path}'`;
}

function plural(count: number): string {
	return count === 1 ? 'row' : 'rows';
}

function failed(database: string, stderr: string): SqlResult {
	const message = stderr.trim() === '' ? 'The query failed.' : stderr.trim();
	return report(`SQL error on ${database}:\n${message}`, { database, rows: 0 });
}

function report(text: string, details: SqlDetails): SqlResult {
	return { content: [{ type: 'text', text }], details };
}
