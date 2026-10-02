import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * The vocabulary check. The glossary in `docs/room.md` gives each word one
 * meaning. Each entry here refuses one old name in the paths where a rename
 * removed it. The check reads the tracked files, so ignored files stay out.
 * `CHANGELOG.md` and `planning/` keep the old names as history.
 *
 * A new entry lands with the rename that removes the word.
 *
 * The `turn` entry refuses the phrases that used `turn` for an activation.
 * A vendor turn, such as a Codex `turn.started` event, stays legal. The
 * `after` delay is now `delaySeconds`, and a regex cannot tell the old delay
 * from the `after` position, so it has no entry.
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
const entry = (id, pattern, paths, options = {}) => ({
	id,
	pattern,
	paths,
	exclude: options.exclude,
	allow: options.allow ?? [],
});

// Old names that a rename removed. A name has a word boundary and no false
// positive in the current tree. One entry holds one concept.
const OLD_NAMES = [
	['person', /\b(?:defineHuman|HumanDefinition|HumanParticipant)\b/],
	[
		'executor',
		/\b(?:AgentExecutor(?:BaseOptions)?|ExecutorSession|scriptedExecutor|create(?:Pi|Claude|Codex)Executor|(?:Pi|Claude|Codex)ExecutorOptions)\b/,
	],
	['activation event', /\b(?:ExecutionEvent|tool_execution_(?:start|end))\b/],
	['summarize purpose', /\bisClosing\b|\bpurpose\b[^'\n]{0,8}'summary'/],
	['cancel', /\broom\.abort\(/],
	['summarize commit', /\b(?:closingCommit|membershipTool|interface Closing)\b/],
	['said message', /\b(?:SpokenMessage|isSpoken)\b/],
	['speaking default', /\bDEFAULT_GUIDANCE\b/],
	['exchange', /\b(?:ExchangeView|ClosedExchange(?:View)?|readView)\b/],
	['read position', /\bwatermark\b/],
	['scheduled say', /\b(?:PendingSay|pendingFor|renderPending)\b/],
	['port error', /\bdelivery_error\b/],
	['send state', /\bDeliveryState\b/],
	[
		'journal entries',
		/\b(?:applyEvent|ProposedEvent|acceptedEvent|journal\/events(?:\.ts|\.js)?)\b/,
	],
	['journal entry type', /\bJournalEntry\b/],
	['execution options', /\b(?:ClaudeRuntime|CodexRuntime)\b/],
	['executor kind', /\b(?:seatFamilies|scriptedFamilies)\b/],
	['workspace endpoint', /\bWorkspacePorts?\b|workstation\/src\/ports\.ts/],
	['shell error', /\bExecutionError(?:Code)?\b/],
	['credential lifetime', /\b(?:tokenTtl|keyTtl)\b/],
	['process cancel', /\b(?:StopCause|process-stop)\b/],
	['process record', /\b(?:ProcessStatus|ProcessRecord|ProcessView)\b/],
	['due activation', /\b(?:PendingActivation|PendingWake|draftsClose|draftsOf)\b/],
	['trace policy', /\bthinking:\s*'summary'/],
	['simulation', /\bRunExchange\b/],
	['traced step', /\bTraceRecord\b/],
	['trace policy default', /\bDEFAULT_TRACE\b/],
	['bound tool', /\bRoomTool(?:Result)?\b/],
	['tool concurrency', /\bToolExecutionMode\b/],
	['seat context', /\bAgentExecutionContext\b/],
];

const entries = [
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
	entry('Spoken', /\w+Spoken\b|\bSpoken\w+/, SOURCE),
	entry('Info', /\bexport\s+(?:type|interface)\s+\w+Info\b/, /^packages\/ambion\/src\/.*\.ts$/),
	entry('entry body type', /\binterface Fence\b/, /^packages\/ambion\/.*\.ts$/),
	entry('Harness', /\b\w*(?:Harness|HARNESS|harness[A-Z_])\w*/, CODE, {
		exclude: /^packages\/pi\//,
		allow: [
			/^(?:AgentHarness|AgentHarnessTool|AgentHarnessToolInvocation|HarnessEvent|HarnessEventType|OpenHarness|openHarness|HarnessInput|HarnessTool)$/,
		],
	}),
	entry('harness matrix', /\bmatrix\.harness\b|^\s*harness: \[/, CODE),
	...OLD_NAMES.map(([concept, pattern]) => entry(`old names of the ${concept}`, pattern, TEXT)),
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
	test(`vocabulary: ${item.id}`, () => {
		const hits = hitsOf(item);
		assert.ok(
			hits.length === 0,
			`${item.id}: an old name is back. docs/room.md holds the glossary.\n${hits.join('\n')}`,
		);
	});
}
