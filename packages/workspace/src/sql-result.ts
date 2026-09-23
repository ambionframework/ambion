/**
 * The result of a SQL run: a preview, a row count, and an optional CSV file.
 *
 * `sqlResult` reads the rows of a last statement once. It keeps the first
 * `maxRows` rows and counts every row. With `export`, it streams every row
 * as CSV through `WorkspaceFiles`, in chunks, so no backend holds the full
 * result in memory. A backend calls it with its own row iterator; a backend
 * with a native export can write through `WorkspaceFiles` itself.
 *
 * The CSV follows RFC 4180: a header, one record per row, and a quoted
 * value for a comma, a double quote, or a line break. A NULL reads as `\N`,
 * so a NULL stays apart from an empty string, and a blob reads as hex.
 *
 * This module imports no database driver.
 */

import type { Context } from '@earendil-works/pi-agent-core';
import type { SqlOutcome, SqlRow, SqlRunOptions, SqlValue, WorkspaceFiles } from './sql-backend.ts';

/** The CSV text for a NULL value. */
export const NULL_SENTINEL = '\\N';

/** How many characters of CSV one chunk holds before `WorkspaceFiles` gets it. */
const CHUNK_CHARS = 64 * 1024;

/** One CSV field: `\N` for NULL, hex for a blob, and RFC 4180 quoting for the rest. */
function csvField(value: SqlValue | undefined): string {
	if (value === null || value === undefined) return NULL_SENTINEL;
	if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
	return csvText(String(value));
}

function csvText(text: string): string {
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The CSV header of `columns`. */
export function csvHeader(columns: readonly string[]): string {
	return columns.map(csvText).join(',');
}

/** The CSV record of one row, in the order of `columns`. */
export function csvRecord(columns: readonly string[], row: SqlRow): string {
	return columns.map((name) => csvField(row[name])).join(',');
}

/** The CSV text of `rows`, a header first, in chunks of about `CHUNK_CHARS`. */
function* csvChunks(columns: readonly string[], rows: Iterable<SqlRow>): Generator<string> {
	let chunk = `${csvHeader(columns)}\n`;
	for (const row of rows) {
		chunk += `${csvRecord(columns, row)}\n`;
		if (chunk.length >= CHUNK_CHARS) {
			yield chunk;
			chunk = '';
		}
	}
	if (chunk !== '') yield chunk;
}

/**
 * Read `rows` once, and give the outcome of a run whose last statement has
 * `columns`. A last statement with no columns gives no rows and writes an
 * empty export.
 */
export async function sqlResult(
	columns: readonly string[],
	rows: Iterable<SqlRow>,
	options: SqlRunOptions,
	files: WorkspaceFiles,
	context: Context,
): Promise<SqlOutcome> {
	const preview: SqlRow[] = [];
	let rowCount = 0;
	const take = (row: SqlRow): void => {
		const signal = context.abortSignal;
		if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
		if (preview.length < options.maxRows) preview.push(row);
		rowCount += 1;
	};
	if (options.export === undefined) {
		for (const row of rows) take(row);
		return { ok: true, columns, rows: preview, rowCount };
	}
	function* counted(): Generator<SqlRow> {
		for (const row of rows) {
			take(row);
			yield row;
		}
	}
	const chunks = columns.length === 0 ? [] : csvChunks(columns, counted());
	const path = await files.writeFile(options.export, chunks, context);
	return { ok: true, columns, rows: preview, rowCount, export: path };
}
