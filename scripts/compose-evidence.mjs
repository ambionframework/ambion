#!/usr/bin/env node
/**
 * Turn the JSON lines of the compose live test into the evidence tables.
 *
 *   node scripts/compose-evidence.mjs <lines.jsonl> [output.md]
 *
 * The live test appends one line for each run to the file that
 * `AMBION_LIVE_REPORT` names. A line holds `composeChars`, the length of the
 * description of the `compose` tool, and the table shows it in characters.
 * The output holds one table for each executor kind, under a heading of the
 * level that `planning/next.md` uses for a run.
 * A kind with no line is marked skipped. A later line for the same kind and
 * case replaces an earlier one. With no output file, the script writes to
 * stdout.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const KINDS = ['pi', 'claude', 'codex'];

const seconds = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : '-');

/** The names in order, with a run of one name written once with its count. */
const runsOf = (names) => {
	const runs = [];
	for (const name of names) {
		const last = runs.at(-1);
		if (last?.name === name) last.count += 1;
		else runs.push({ name, count: 1 });
	}
	return runs.map(({ name, count }) => (count === 1 ? name : `${name} ×${count}`)).join(', ');
};

const toolsOf = (line) => {
	const direct = runsOf(line.tools) || '-';
	return line.nested.length === 0 ? direct : `${direct} (nested: ${runsOf(line.nested)})`;
};

const row = (line) =>
	`| ${[
		line.thinking ? `${line.model} (${line.thinking})` : line.model,
		line.case,
		toolsOf(line),
		line.inputTokens,
		line.outputTokens,
		seconds(line.wallMs),
		typeof line.composeChars === 'number' ? line.composeChars : '-',
		line.note ? `${line.outcome} (${line.note})` : line.outcome,
	]
		// A pipe inside a cell ends the cell, so each pipe is escaped.
		.map((cell) => String(cell).replaceAll('|', '\\|'))
		.join(' | ')} |`;

/** The Markdown of the evidence file for the lines of a report. */
export function evidenceOf(text) {
	const lines = text
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line));
	const latest = new Map(lines.map((line) => [`${line.kind}\0${line.case}`, line]));
	const sections = KINDS.map((kind) => {
		const rows = [...latest.values()].filter((line) => line.kind === kind);
		if (rows.length === 0)
			return `#### ${kind}\n\nSkipped. The run had no key for this executor kind.\n`;
		return [
			`#### ${kind}`,
			'',
			'| Model | Case | Tools | Input tokens | Output tokens | Wall time | Compose description | Outcome |',
			'| ----- | ---- | ----- | ------------ | ------------- | --------- | ------------------- | ------- |',
			...rows.map(row),
			'',
		].join('\n');
	});
	return sections.join('\n');
}

if (process.argv[1] === import.meta.filename) {
	const [source, target] = process.argv.slice(2);
	if (source === undefined) {
		process.stderr.write('Usage: node scripts/compose-evidence.mjs <lines.jsonl> [output.md]\n');
		process.exit(1);
	}
	const text = evidenceOf(readFileSync(source, 'utf8'));
	if (target === undefined) process.stdout.write(text);
	else writeFileSync(target, text);
}
