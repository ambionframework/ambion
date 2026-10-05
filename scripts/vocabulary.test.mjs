import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * The vocabulary check. The glossary in `docs/room.md` gives each word one
 * meaning. Each entry refuses one word in the paths where the glossary uses
 * another word for that concept. The check reads the tracked files, so
 * ignored files stay out. `CHANGELOG.md` and `planning/` are exempt.
 *
 * The `turn` entry refuses the phrases that use `turn` for an activation.
 * A vendor turn, such as a Codex `turn.started` event, is correct.
 */

const root = join(import.meta.dirname, '..');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
	.split('\0')
	.filter((path) => path !== '' && existsSync(join(root, path)));

const EXEMPT = /^(CHANGELOG\.md|planning\/|scripts\/vocabulary\.test\.mjs$|pnpm-lock\.yaml$)/;
const TEXT = /\.(ts|tsx|mjs|cjs|js|json|jsonc|md|yml|yaml|sh|svg|dfy|snap|css|html)$/;
const CODE = /\.(ts|tsx|mjs|cjs|js|yml|yaml|sh)$/;
const SOURCE = /^(packages|examples)\/[^/]+\/src\/.*\.(ts|tsx)$/;
const PROSE = /^(docs\/.*\.md|README\.md|packages\/[^/]+\/README\.md)$/;

/** A pattern that matches one refused word in the files that `paths` accepts. */
const entry = (id, pattern, paths, options = {}) => ({
	id,
	pattern,
	paths,
	exclude: options.exclude,
	allow: options.allow ?? [],
});

const entries = [
	// History belongs to git. Text and tests describe the current state.
	entry(
		'history',
		/\b(?:formerly|renamed (?:from|to)|was renamed|used to be|previously (?:called|named)|old names?|deprecated alias|backwards? compat(?:ibility)?)\b/i,
		TEXT,
	),
	entry('member', /\bmember(?:ship)?s?\b/i, PROSE),
	entry(
		'seating',
		/\bmember(?:ship)?s?\b/i,
		/^packages\/(?:assistant\/src\/|ambion\/src\/execution\/)/,
		// The contract says "member" for a field of an interface.
		{ exclude: /^packages\/ambion\/src\/execution\/contract\.ts$/ },
	),
	entry('cut', /\bcancelled\b/, /^packages\/ambion\/src\/execution\//),
	entry(
		'exchange person',
		/\bowns the (?:current )?exchange\b/,
		/^(?:docs\/.*\.md|README\.md|packages\/[^/]+\/README\.md|(?:packages|examples)\/[^/]+\/src\/.*\.(?:ts|tsx))$/,
	),
	entry('context', /\bTurnContext\b|\bturn context\b/i, SOURCE),
	entry('family', /(?<!font-)\bfamil(?:y|ies)\b/i, PROSE),
	entry(
		'turn',
		/\b(?:your turn|mid-turn|this turn|taking a turn|take your turn)\b/i,
		/^(?:packages|examples)\/[^/]+\/(?:src|test\/live)\/.*\.(?:ts|tsx|mjs)$/,
	),
	entry(
		'driver',
		/\bthe core\b/i,
		/^(?:packages\/ambion\/src\/execution\/.*|docs\/executors\.md)$/,
	),
	entry('Spoken', /\w+Spoken\b|\bspoken\w*/i, SOURCE),
	entry('Info', /\bexport\s+(?:type|interface)\s+\w+Info\b/, /^packages\/ambion\/src\/.*\.ts$/),
	entry('Harness', /\b\w*(?:Harness|HARNESS|harness[A-Z_])\w*/, CODE, {
		exclude: /^packages\/pi\//,
		allow: [
			/^(?:AgentHarness|AgentHarnessTool|AgentHarnessToolInvocation|HarnessEvent|HarnessEventType|OpenHarness|openHarness|HarnessInput|HarnessTool)$/,
		],
	}),
	entry('harness matrix', /\bmatrix\.harness\b|^\s*harness: \[/, CODE),
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
		if (!paths.test(path) || EXEMPT.test(path) || exclude?.test(path)) continue;
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
	test(`vocabulary: ${item.id}`, () => {
		const hits = hitsOf(item);
		assert.ok(
			hits.length === 0,
			`${item.id}: a refused word. docs/room.md holds the glossary.\n${hits.join('\n')}`,
		);
	});
}
