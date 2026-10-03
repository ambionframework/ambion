#!/usr/bin/env node
/**
 * Turn the JSON lines of the compose live test into the evidence file.
 *
 *   node scripts/compose-evidence.mjs <lines.jsonl> [planning/compose-evidence.md]
 *
 * The live test appends one line for each run to the file that
 * `AMBION_LIVE_REPORT` names. The file holds one table for each executor
 * kind. A kind with no line is marked skipped. A later line for the same
 * kind and case replaces an earlier one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KINDS = ['pi', 'claude', 'codex'];

const seconds = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : '-');

const toolsOf = (line) => {
	const direct = line.tools.join(', ') || '-';
	return line.nested.length === 0 ? direct : `${direct} (nested: ${line.nested.join(', ')})`;
};

const row = (line) =>
	`| ${[
		line.model,
		line.case,
		toolsOf(line),
		line.inputTokens,
		line.outputTokens,
		seconds(line.wallMs),
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
			return `## ${kind}\n\nSkipped. The run had no key for this executor kind.\n`;
		return [
			`## ${kind}`,
			'',
			'| Model | Case | Tools | Input tokens | Output tokens | Wall time | Outcome |',
			'| ----- | ---- | ----- | ------------ | ------------- | --------- | ------- |',
			...rows.map(row),
			'',
		].join('\n');
	});
	return [
		'# Compose live evidence',
		'',
		'Each table holds the runs of `packages/workspace/test/live/compose.test.ts`.',
		'The tools column lists the direct calls of the seat. Nested calls follow.',
		'Input tokens count the prompt, the cache read, and the cache write.',
		'',
		...sections,
	].join('\n');
}

if (process.argv[1] === import.meta.filename) {
	const [source, target = join(import.meta.dirname, '..', 'planning', 'compose-evidence.md')] =
		process.argv.slice(2);
	if (source === undefined) {
		process.stderr.write('Usage: node scripts/compose-evidence.mjs <lines.jsonl> [output.md]\n');
		process.exit(1);
	}
	writeFileSync(target, evidenceOf(readFileSync(source, 'utf8')));
}
