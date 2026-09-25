/**
 * The result of a SQL run: a preview, a row count, and an optional CSV file.
 *
 * `sqlResult` reads the rows of a last statement once. It keeps the first
 * `maxRows` rows and counts every row. It yields to the event loop every
 * `ROWS_PER_TURN` rows, so an abort, a time limit, and other rooms make
 * progress while a large result streams. A non-integer `maxRows` rounds
 * down, and a negative or non-finite one keeps no row. With `export`, it streams every row
 * as CSV through `WorkspaceFiles`, in chunks, so no backend holds the full
 * result in memory. A backend calls it with its own row iterator; a backend
 * with a native export can write through `WorkspaceFiles` itself.
 *
 * The CSV follows RFC 4180: a header, one record per row, and a quoted
 * value for a comma, a double quote, or a line break. A NULL reads as a
 * bare `\N`, so a NULL stays apart from an empty string. The text `\N` is
 * quoted, so it stays apart from a NULL. A blob reads as hex.
 *
 * This module imports no database driver.
 */

import type { Context } from '@earendil-works/pi-agent-core';
import type { SqlOutcome, SqlRow, SqlRunOptions, SqlValue, WorkspaceFiles } from './sql-backend.ts';

/** The CSV text for a NULL value. */
export const NULL_SENTINEL = '\\N';

/** How many characters of CSV one chunk holds before `WorkspaceFiles` gets it. */
const CHUNK_CHARS = 64 * 1024;

/** How many rows `sqlResult` reads before it yields to the event loop. */
const ROWS_PER_TURN = 256;

/** Let timers and other work run, so an abort or a time limit can fire. */
const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** One CSV field: `\N` for NULL, hex for a blob, and RFC 4180 quoting for the rest. */
function csvField(value: SqlValue | undefined): string {
	if (value === null || value === undefined) return NULL_SENTINEL;
	if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
	const text = String(value);
	return text === NULL_SENTINEL ? `"${text}"` : csvText(text);
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
async function* csvChunks(
	columns: readonly string[],
	rows: AsyncIterable<SqlRow>,
): AsyncGenerator<string> {
	let chunk = `${csvHeader(columns)}\n`;
	for await (const row of rows) {
		chunk += `${csvRecord(columns, row)}\n`;
		if (chunk.length >= CHUNK_CHARS) {
			yield chunk;
			chunk = '';
		}
	}
	if (chunk !== '') yield chunk;
}

/** Reject when the caller aborted, or a time limit fired. */
function throwIfAborted(context: Context): void {
	const signal = context.abortSignal;
	if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
}

/** The first `maxRows` rows, and the count of every row, as the rows stream past. */
class Tally {
	readonly preview: SqlRow[] = [];
	count = 0;

	constructor(private readonly maxRows: number) {}

	/** Count `row`, keep it in the preview while there is room, and give the new count. */
	add(row: SqlRow): number {
		if (this.preview.length < this.maxRows) this.preview.push(row);
		this.count += 1;
		return this.count;
	}
}

/** `rows` through `tally`, with an abort check at each row and a yield every `ROWS_PER_TURN`. */
async function* counted(
	rows: Iterable<SqlRow>,
	tally: Tally,
	context: Context,
): AsyncGenerator<SqlRow> {
	for (const row of rows) {
		throwIfAborted(context);
		if (tally.add(row) % ROWS_PER_TURN === 0) await yieldTurn();
		yield row;
	}
}

/** A `maxRows` as a count: rounded down, and 0 when negative or not finite. */
function previewSize(maxRows: number): number {
	return Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 0;
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
	const tally = new Tally(previewSize(options.maxRows));
	const stream = counted(rows, tally, context);
	if (options.export === undefined) {
		for await (const _ of stream) {
			// `counted` fills the tally as each row passes.
		}
		return { ok: true, columns, rows: tally.preview, rowCount: tally.count };
	}
	const chunks = columns.length === 0 ? [] : csvChunks(columns, stream);
	const path = await files.writeFile(options.export, chunks, context);
	return { ok: true, columns, rows: tally.preview, rowCount: tally.count, export: path };
}
