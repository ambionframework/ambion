/**
 * The import of a SQL run: one CSV file from the workspace, staged as a
 * table for one run.
 *
 * `sqlImport` reads the file through `WorkspaceFiles`, as the calling
 * agent, and gives its rows to a table that the backend makes. The agent's
 * statements then copy what they need into the shared tables. SQL decides
 * the types, the columns, and what happens to a duplicate. The import only
 * parses.
 *
 * The CSV is the one that an export writes: RFC 4180, a header first, and
 * `\N` for a NULL. A quoted value holds a comma, a double quote, or a line
 * break. A line ends with LF, CRLF, or CR, and a byte order mark at the
 * start is skipped. Every other value stays text, so the statements CAST
 * it. A malformed file gives an `ok: false` outcome that names the record,
 * and the backend drops what it staged.
 *
 * The file enters memory whole, so `MAX_IMPORT_BYTES` bounds it. The rows
 * go to the table in batches of `ROWS_PER_BATCH`, and the import yields to
 * the event loop after each batch, so an abort and a time limit can fire.
 *
 * This module imports no database driver.
 */

import type { Context } from '@earendil-works/pi-agent-core';
import type { SqlImported, SqlImportTable, WorkspaceFiles } from './sql-backend.ts';
import { NULL_SENTINEL } from './sql-result.ts';

/** The table that holds the rows of an import, for one run. */
export const IMPORT_TABLE = 'import.rows';

/** The most bytes one import reads. */
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

/** How many rows go to the table in one batch, before the import yields. */
const ROWS_PER_BATCH = 256;

/** A file that the import refuses, reported as an `ok: false` outcome. */
class CsvRefusal extends Error {}

/** Let timers and other work run, so an abort or a time limit can fire. */
const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Reject when the caller aborted, or a time limit fired. */
function throwIfAborted(context: Context): void {
	const signal = context.abortSignal;
	if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
}

/** Reads the records of one CSV text, in order. */
class CsvReader {
	private at: number;

	constructor(private readonly text: string) {
		this.at = text.startsWith('﻿') ? 1 : 0;
	}

	/** The next record, or undefined at the end of the text. */
	next(): string[] | undefined {
		if (this.at >= this.text.length) return undefined;
		const fields = [this.field()];
		while (this.text[this.at] === ',') {
			this.at += 1;
			fields.push(this.field());
		}
		this.endLine();
		return fields;
	}

	private field(): string {
		return this.text[this.at] === '"' ? this.quoted() : this.bare();
	}

	/** A value with no quotes: the text up to the next comma or line break. */
	private bare(): string {
		const end = /[,\r\n]/g;
		end.lastIndex = this.at;
		const found = end.exec(this.text);
		const stop = found === null ? this.text.length : found.index;
		const value = this.text.slice(this.at, stop);
		this.at = stop;
		return value;
	}

	/** A quoted value. Two double quotes inside it are one double quote. */
	private quoted(): string {
		let value = '';
		let from = this.at + 1;
		for (;;) {
			const close = this.text.indexOf('"', from);
			if (close < 0) throw new CsvRefusal('The file ends inside a quoted value.');
			value += this.text.slice(from, close);
			if (this.text[close + 1] !== '"') {
				this.at = close + 1;
				return value;
			}
			value += '"';
			from = close + 2;
		}
	}

	/** Step over one line break. Anything else after a value is an error. */
	private endLine(): void {
		if (this.at >= this.text.length) return;
		if (this.text[this.at] === '\r') this.at += 1;
		if (this.text[this.at] === '\n') this.at += 1;
		else if (this.text[this.at - 1] !== '\r') {
			throw new CsvRefusal('A quoted value must end at a comma or at a line break.');
		}
	}
}

/** The columns of the header. Each needs a name, and no two names match without regard to case. */
function headerOf(reader: CsvReader): string[] {
	const header = reader.next();
	if (header === undefined) throw new CsvRefusal('The file is empty. It needs a header.');
	const seen = new Set<string>();
	header.forEach((name, index) => {
		if (name === '') throw new CsvRefusal(`Column ${index + 1} of the header has no name.`);
		const key = name.toLowerCase();
		if (seen.has(key)) throw new CsvRefusal(`The header names the column '${name}' twice.`);
		seen.add(key);
	});
	return header;
}

/** `n` and `noun`, with an s for any count but one. */
function counted(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** One record as a row: `\N` is NULL. A record with the wrong field count is an error. */
function rowOf(record: string[], width: number, number: number): (string | null)[] {
	if (record.length !== width) {
		throw new CsvRefusal(
			`Row ${number} has ${counted(record.length, 'value')}, and the header has ${counted(width, 'column')}.`,
		);
	}
	return record.map((value) => (value === NULL_SENTINEL ? null : value));
}

/** Give every record after the header to `table`, in batches. Gives the row count. */
async function stageRows(
	reader: CsvReader,
	width: number,
	table: SqlImportTable,
	context: Context,
): Promise<number> {
	let count = 0;
	let batch: (string | null)[][] = [];
	for (let record = reader.next(); record !== undefined; record = reader.next()) {
		count += 1;
		batch.push(rowOf(record, width, count));
		if (batch.length === ROWS_PER_BATCH) {
			await table.insert(batch);
			batch = [];
			await yieldTurn();
			throwIfAborted(context);
		}
	}
	if (batch.length > 0) await table.insert(batch);
	return count;
}

/**
 * Read the CSV file at `path` through `files`, and stage its rows in
 * `table`. A file that `files` cannot read, and a malformed file, give an
 * `ok: false` outcome. An error of `table`, a fault of `files`, and an
 * abort, reject.
 */
export async function sqlImport(
	path: string,
	files: WorkspaceFiles,
	table: SqlImportTable,
	context: Context,
): Promise<({ ok: true } & SqlImported) | { ok: false; message: string }> {
	const read = await files.readFile(path, MAX_IMPORT_BYTES, context);
	if (!read.ok) return read;
	throwIfAborted(context);
	try {
		const reader = new CsvReader(read.text);
		const columns = headerOf(reader);
		await table.create(columns);
		const rows = await stageRows(reader, columns.length, table, context);
		return { ok: true, path: read.path, rows };
	} catch (error) {
		if (!(error instanceof CsvRefusal)) throw error;
		return { ok: false, message: `The import of ${read.path} failed. ${error.message}` };
	}
}
