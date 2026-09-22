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
 * and shows a Markdown table. It writes nothing to disk. The export path writes
 * the full result as CSV to a temporary file, then moves it to the export path.
 * A failed query leaves the export path unchanged. Each path runs the query
 * once, so the preview and the stored result agree.
 *
 * The export path reads the temporary CSV file once and scans it for RFC 4180
 * records. A newline outside a quoted value ends a record. A newline inside a
 * value stays in the value, and a doubled quote is an escaped quote. This one
 * scan gives the row count and the preview records, so a backend needs only
 * the `sqlite3` command.
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
	Context,
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

/** The largest `-json` output, in characters, the default path parses before it asks for a LIMIT. */
const MAX_JSON_CHARS = 1_000_000;

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
		execute: (_toolCallId, params, _onUpdate, toolContext, _invocation, context) =>
			run(toolContext.env, params, context),
	};
}

/**
 * Run one command and return its combined output and exit code. `exec` returns
 * metadata and delivers the output through `onUpdate`, so this collects the
 * final view. No capture limit reaches `exec`, so the whole output comes back
 * for the JSON parse.
 */
async function shell(
	env: ExecutionEnv,
	command: string,
	options: ShellExecOptions,
	context: Context,
): Promise<{ output: string; exitCode: number }> {
	let output = '';
	const result = await env.exec(
		command,
		{
			...options,
			onUpdate: (update) => {
				if (update.kind === 'replace') output = update.output.text;
			},
		},
		context,
	);
	if (!result.ok) throw result.error;
	return { output, exitCode: result.value.exitCode };
}

async function run(env: ExecutionEnv, params: SqlParams, context: Context): Promise<SqlResult> {
	const database = await resolvePath(env, params.database ?? SHARED_DATABASE, context);
	await ensureParent(env, database, context);
	const scriptPath = await writeScript(env, params.sql, context);
	const options: ShellExecOptions = params.timeout === undefined ? {} : { timeout: params.timeout };
	const maxRows = params.maxRows ?? PREVIEW_ROWS;
	try {
		if (params.export === undefined)
			return await preview(env, database, scriptPath, maxRows, options, context);
		const exportPath = await resolvePath(env, params.export, context);
		await ensureParent(env, exportPath, context);
		return await exportCsv(env, database, scriptPath, exportPath, maxRows, options, context);
	} finally {
		await env.remove(scriptPath, { force: true }, context);
	}
}

/** Run the query, parse the JSON result, and show a Markdown table. */
async function preview(
	env: ExecutionEnv,
	database: string,
	scriptPath: string,
	maxRows: number,
	options: ShellExecOptions,
	context: Context,
): Promise<SqlResult> {
	const result = await runSqlite(env, ['-json'], database, scriptPath, undefined, options, context);
	if (result.exitCode !== 0) return failed(database, result.output);
	if (result.output.length > MAX_JSON_CHARS) {
		const text =
			'The result is large. Add a LIMIT for a preview, or set export to write the full result as CSV.';
		return report(text, { database, rows: 0, truncated: true });
	}
	const rows = parseRows(result.output);
	if (rows === undefined) return report(result.output.trim(), { database, rows: 0 });
	if (rows.length === 0) return report(`Ran on ${database}. No rows.`, { database, rows: 0 });
	return report(table(rows, maxRows), { database, rows: rows.length });
}

/**
 * Run the query, write the full result as CSV to a temporary file, then move
 * it to the export path. The export path changes only after the query passes,
 * so a failed query leaves an existing file unchanged.
 *
 * The tool reads the temporary file once and scans it into RFC 4180 records.
 * The row count is the number of records minus the header. The preview holds
 * the first `maxRows + 1` records, header included, so a quoted newline never
 * splits a preview row.
 */
async function exportCsv(
	env: ExecutionEnv,
	database: string,
	scriptPath: string,
	exportPath: string,
	maxRows: number,
	options: ShellExecOptions,
	context: Context,
): Promise<SqlResult> {
	const temp = await env.createTempFile({ suffix: '.csv' }, context);
	if (!temp.ok) throw temp.error;
	const tempOut = temp.value;
	const flags = ['-csv', '-header', '-nullvalue', `'${NULL_SENTINEL}'`];
	try {
		const result = await runSqlite(env, flags, database, scriptPath, tempOut, options, context);
		if (result.exitCode !== 0) return failed(database, result.output);
		const text = await env.readTextFile(tempOut, context);
		const records = text.ok ? scanCsvRecords(text.value) : [];
		const rows = records.length === 0 ? 0 : records.length - 1;
		const previewRecords = records.slice(0, maxRows + 1);
		const moved = await env.renameFile(tempOut, exportPath, context);
		if (!moved.ok) throw moved.error;
		const block =
			previewRecords.length === 0 ? '(no rows)' : `\`\`\`csv\n${previewRecords.join('\n')}\n\`\`\``;
		const footer = `\n\nWrote ${rows} ${plural(rows)} to ${exportPath}. A NULL value reads as ${NULL_SENTINEL}.`;
		return report(`${block}${footer}`, { database, rows, export: exportPath });
	} finally {
		await env.remove(tempOut, { force: true }, context);
	}
}

/**
 * Split CSV text into records per RFC 4180. A newline outside a quoted value
 * ends a record. A newline inside a quoted value stays in the value. A
 * doubled quote inside a quoted value is one escaped quote, and stays
 * inside the value.
 */
function scanCsvRecords(text: string): string[] {
	const records: string[] = [];
	let start = 0;
	let inQuotes = false;
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (char === '"') {
			const step = quoteStep(text, index, inQuotes);
			inQuotes = step.inQuotes;
			index = step.index;
			continue;
		}
		if (char === '\n' && !inQuotes) {
			records.push(text.slice(start, index));
			start = index + 1;
		}
		index += 1;
	}
	if (start < text.length) records.push(text.slice(start));
	return records;
}

/**
 * Advance past one double quote in a CSV scan. A doubled quote inside a
 * quoted value is an escaped quote, and stays inside the value. A single
 * quote toggles whether the scan is inside a value.
 */
function quoteStep(
	text: string,
	index: number,
	inQuotes: boolean,
): { inQuotes: boolean; index: number } {
	if (inQuotes && text[index + 1] === '"') return { inQuotes, index: index + 2 };
	return { inQuotes: !inQuotes, index: index + 1 };
}

/** Build one `sqlite3` command that reads the script and, when asked, redirects to a file. */
async function runSqlite(
	env: ExecutionEnv,
	flags: string[],
	database: string,
	scriptPath: string,
	redirect: string | undefined,
	options: ShellExecOptions,
	context: Context,
): Promise<{ output: string; exitCode: number }> {
	const parts = ['sqlite3', ...flags, quote(database), '<', quote(scriptPath)];
	if (redirect !== undefined) parts.push('>', quote(redirect));
	return shell(env, parts.join(' '), options, context);
}

/**
 * Parse the last JSON array of row objects. `sqlite3 -json` writes one array
 * per query, and a newline separates one array from the next. A newline never
 * sits inside a value, because `-json` escapes it, so the last `\n[` starts the
 * last query's result.
 */
function parseRows(stdout: string): Record<string, unknown>[] | undefined {
	const text = stdout.trim();
	if (text === '') return [];
	const boundary = text.lastIndexOf('\n[');
	const last = boundary === -1 ? text : text.slice(boundary + 1);
	if (!last.startsWith('[')) return undefined;
	try {
		const value: unknown = JSON.parse(last);
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

async function resolvePath(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const resolved = await env.absolutePath(path, context);
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

async function ensureParent(env: ExecutionEnv, path: string, context: Context): Promise<void> {
	const made = await env.createDir(posix.dirname(path), { recursive: true }, context);
	if (!made.ok) throw made.error;
}

async function writeScript(env: ExecutionEnv, sql: string, context: Context): Promise<string> {
	const temp = await env.createTempFile({ suffix: '.sql' }, context);
	if (!temp.ok) throw temp.error;
	const written = await env.writeFile(temp.value, sql, context);
	if (!written.ok) {
		await env.remove(temp.value, { force: true }, context);
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
