import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * The vocabulary check. `planning/terminology.md` lists the names that break
 * the controlled vocabulary. Each entry here refuses one old name in the
 * paths where the plan removed it. The check reads the tracked files, so
 * ignored files stay out. `CHANGELOG.md` keeps the old names as history, and
 * `planning/` names them on purpose.
 *
 * A new entry lands with the rename that removes the word. The entry names
 * the plan rows that own it.
 *
 * The `turn` entry refuses the phrases that used `turn` for an activation.
 * A vendor turn, such as a Codex `turn.started` event, stays legal. Row T8
 * renames the `after` delay, and a regex cannot tell it from the `after`
 * position, so T8 has no entry.
 */

const root = join(import.meta.dirname, '..');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
	.split('\0')
	.filter((path) => path !== '' && existsSync(join(root, path)));

const TEXT = /\.(ts|tsx|mjs|cjs|js|json|jsonc|md|yml|yaml|sh|svg|dfy|snap|css|html)$/;
const HISTORY = /^(CHANGELOG\.md|planning\/|scripts\/vocabulary\.test\.mjs$|pnpm-lock\.yaml$)/;
const CODE = /\.(ts|tsx|mjs|cjs|js|yml|yaml|sh)$/;
const SOURCE = /^(packages|examples)\/[^/]+\/src\/.*\.(ts|tsx)$/;
const PROSE = /^(docs\/.*\.md|README\.md|packages\/[^/]+\/README\.md)$/;

/** A pattern that matches one old name in the file of the paths that `paths` accepts. */
const entry = (id, rows, pattern, paths, options = {}) => ({
	id,
	rows,
	pattern,
	paths,
	exclude: options.exclude,
	allow: options.allow ?? [],
});

// Old names that the renames of the plan removed. A name has a word boundary
// and no false positive in the current tree. One entry holds one plan row.
const OLD_NAMES = [
	[
		'T1',
		/\b(?:AgentExecutor(?:BaseOptions)?|ExecutorSession|scriptedExecutor|create(?:Pi|Claude|Codex)Executor|(?:Pi|Claude|Codex)ExecutorOptions)\b/,
	],
	['T2', /\b(?:ExecutionEvent|tool_execution_(?:start|end))\b/],
	['T3', /\bisClosing\b|\bpurpose\b[^'\n]{0,8}'summary'/],
	['T4', /\broom\.abort\(/],
	['T5', /\b(?:SpokenMessage|isSpoken)\b/],
	['T6', /\bDEFAULT_GUIDANCE\b/],
	['T7', /\b(?:ExchangeView|ClosedExchange(?:View)?|readView)\b/],
	['T9', /\bwatermark\b/],
	['T10', /\b(?:PendingSay|pendingFor)\b/],
	['T11', /\b(?:applyEvent|ProposedEvent|acceptedEvent|journal\/events(?:\.ts|\.js)?)\b/],
	['T12', /\bJournalEntry\b/],
	['S1', /\b(?:ClaudeRuntime|CodexRuntime)\b/],
	['O5', /\b(?:seatFamilies|scriptedFamilies)\b/],
	['O2', /\bWorkspacePorts?\b/],
	['S7', /\b(?:tokenTtl|keyTtl)\b/],
	['S8', /\b(?:StopCause|process-stop)\b/],
	['S9', /\bProcessStatus\b/],
	['O3', /\b(?:PendingActivation|PendingWake|draftsClose|draftsOf)\b/],
	['O7', /\bthinking:\s*'summary'/],
	['O10', /\bRunExchange\b/],
	['O11', /\bTraceRecord\b/],
	['S11', /\bDEFAULT_TRACE\b/],
];

const entries = [
	entry('member', ['O8'], /\bmember(?:ship)?s?\b/i, PROSE),
	entry('family', ['O5'], /(?<!font-)\bfamil(?:y|ies)\b/i, PROSE),
	entry(
		'turn',
		['O9'],
		/\b(?:your turn|mid-turn|this turn|taking a turn|take your turn)\b/i,
		/^(?:packages|examples)\/[^/]+\/(?:src|test\/live)\/.*\.(?:ts|tsx|mjs)$/,
	),
	entry('Spoken', ['T5'], /\w+Spoken\b|\bSpoken\w+/, SOURCE),
	entry(
		'Info',
		['T14'],
		/\bexport\s+(?:type|interface)\s+\w+Info\b/,
		/^packages\/ambion\/src\/.*\.ts$/,
	),
	entry('Harness', ['O4a', 'O4b'], /\b\w*(?:Harness|HARNESS|harness[A-Z_])\w*/, CODE, {
		exclude: /^packages\/pi\//,
		allow: [
			/^(?:AgentHarness|AgentHarnessTool|AgentHarnessToolInvocation|HarnessEvent|HarnessEventType|OpenHarness|openHarness|HarnessInput|HarnessTool)$/,
		],
	}),
	entry('harness matrix', ['O4a'], /\bmatrix\.harness\b|^\s*harness: \[/, CODE),
	...OLD_NAMES.map(([row, pattern]) => entry(`old names of ${row}`, [row], pattern, TEXT)),
];

const lines = new Map();
const linesOf = (path) => {
	if (!lines.has(path)) lines.set(path, readFileSync(join(root, path), 'utf8').split('\n'));
	return lines.get(path);
};

/** Each hit as `file:line: text`. */
function hitsOf({ pattern, paths, exclude, allow }) {
	const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
	const hits = [];
	for (const path of tracked) {
		if (!paths.test(path) || HISTORY.test(path) || exclude?.test(path)) continue;
		linesOf(path).forEach((line, index) => {
			const found = [...line.matchAll(global)].filter(
				(match) => !allow.some((pattern) => pattern.test(match[0])),
			);
			if (found.length > 0) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 100)}`);
		});
	}
	return hits;
}

for (const item of entries) {
	test(`vocabulary: ${item.id} (${item.rows.join(', ')})`, () => {
		const hits = hitsOf(item);
		assert.ok(
			hits.length === 0,
			`${item.id} breaks ${item.rows.join(', ')} of planning/terminology.md:\n${hits.join('\n')}`,
		);
	});
}
