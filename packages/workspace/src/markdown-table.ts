/**
 * The GitHub Markdown table that the SQL tools and `ps` show. The module
 * imports nothing, so each entry that renders rows carries this code alone.
 */

/** A table of `rows` under a header of `columns`, one line for each row. */
export function markdownTable(
	columns: readonly string[],
	rows: readonly Readonly<Record<string, unknown>>[],
): string {
	const header = `| ${columns.map(cell).join(' | ')} |`;
	const rule = `| ${columns.map(() => '---').join(' | ')} |`;
	const body = rows.map((row) => `| ${columns.map((name) => cell(row[name])).join(' | ')} |`);
	return [header, rule, ...body].join('\n');
}

/** One table cell: NULL for a missing value, a byte count for a blob, and pipes and newlines made safe. */
function cell(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	if (value instanceof Uint8Array) return `(${value.length} bytes)`;
	return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
