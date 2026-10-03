/**
 * Live evidence for `compose` (CP6 of `planning/next.md`, items 1, 6 and 7 of
 * the acceptance in `docs/compose.md`). Each case runs on the executor kind
 * of the run. A run costs money, so each room holds one seat and each prompt
 * is short.
 *
 * When `AMBION_LIVE_REPORT` names a file, each case appends one JSON line
 * for each run. `scripts/compose-evidence.mjs` turns the lines into the
 * tables of the compose evidence in `planning/next.md`.
 */

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, SaidMessage, TracedStep } from '@ambionframework/ambion';
import { afterEach, expect, it } from 'vitest';
import {
	agent,
	invariants,
	LIVE_KIND,
	LIVE_THINKING,
	live,
	MODEL,
	open,
	person,
	saidBy,
} from '../../../ambion/test/live/support.ts';
import { enter, roomName } from '../../../ambion/test/support/room.ts';
import { quickjsEvaluator } from '../../../compose/src/runtime.ts';
import { memoryBackend } from '../../../just-bash/src/index.ts';
import { loadSkills, openWorkspace, type Workspace } from '../../src/index.ts';
import { sqliteBackend } from '../../src/sqlite-entry.ts';

/** The twelve runs of the lab. Each file holds its own text, so each snapshot has its own digest. */
const RUNS = Array.from({ length: 12 }, (_, i) => {
	const id = String(i + 1).padStart(2, '0');
	return {
		path: `/shared/r${id}.md`,
		text: `run ${id}\n`,
		label: i % 3 === 0 ? 'drift' : 'ok',
	};
});
const DRIFTED = RUNS.filter((run) => run.label === 'drift');
const digestOf = (text: string) => createHash('sha256').update(text).digest('hex');

const CHAIN_TASK =
	'Snapshot the files of every run with the label drift. Say how many runs it was and cite the snapshot refs.';

const FAN_TASK =
	'For each run with the label drift, read its log and find the peak_temp line. ' +
	'Snapshot the logs of the drifted runs whose peak is over 900. ' +
	'Say how many there were and cite the snapshot refs.';

/** The peak that decides a snapshot. */
const PEAK_LIMIT = 900;

/** One log of about 3 KB. Exactly one line holds `peak_temp`, at the given position. */
function logOf(id: string, peak: number, at: number): string {
	const lines = Array.from({ length: 60 }, (_, i) => {
		const stage = ['ramp', 'hold', 'soak', 'cool'][(i * 7 + peak) % 4];
		const reading = 200 + ((i * 37 + peak * 3) % 600);
		return `2026-05-01T10:${String(i).padStart(2, '0')}:00Z run=${id} stage=${stage} temp=${reading} humidity=${30 + (i % 20)} status=ok`;
	});
	lines[at] = `2026-05-01T10:${String(at).padStart(2, '0')}:30Z run=${id} peak_temp=${peak}`;
	return `${lines.join('\n')}\n`;
}

/** Forty runs. Sixteen drift. Four of them peak over 900. Some runs that do not drift peak over 900 too. */
const FAN_RUNS = Array.from({ length: 40 }, (_, i) => {
	const id = String(i + 1).padStart(2, '0');
	const drift = i % 5 < 2;
	const peak = i % 4 === 1 ? 910 + i : 400 + ((i * 53) % 480);
	return {
		path: `/logs/r${id}.log`,
		text: logOf(id, peak, (i * 11) % 60),
		label: drift ? 'drift' : 'ok',
		peak,
	};
});
const FAN_HOT = FAN_RUNS.filter((run) => run.label === 'drift' && run.peak > PEAK_LIMIT);

const MACRO = 'lab-drift/snapshot-drift';

const SNAPSHOT_DRIFT = `/*---
description: Snapshot the files of every run with a label. Returns the count and the refs.
uses: [sql, snapshot]
args:
  type: object
  properties: { label: { type: string, minLength: 1 } }
  required: [label]
  additionalProperties: false
---*/
const runs = await tools.sql({ sql: 'SELECT path FROM runs WHERE label = ? ORDER BY path', params: [args.label], rows: 500 });
const { refs } = await tools.snapshot({ paths: runs.rows.map((row) => row.path) });
return { runs: runs.count, refs };
`;

const DRIFT_SKILLS = {
	'lab-drift/SKILL.md': `---
name: lab-drift
description: Snapshot the files of the drifting runs of the lab.
---
1. Run the macro \`${MACRO}\` with \`{ "label": "drift" }\`.
2. Say the count, and cite the refs.
`,
	'lab-drift/macros/snapshot-drift.js': SNAPSHOT_DRIFT,
};

const directories: string[] = [];
const stores: Workspace[] = [];
afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.dispose()));
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A workspace with a memory shell and a real SQLite file. Two tables and twelve files hold the lab. */
async function lab(): Promise<Workspace> {
	const dir = await mkdtemp(join(tmpdir(), 'ambion-live-compose-'));
	directories.push(dir);
	const store = openWorkspace({
		name: roomName('live-compose'),
		backend: { bash: memoryBackend(), sql: sqliteBackend(join(dir, 'lab.db')) },
	});
	stores.push(store);
	await store.use({ name: 'seed' }, async (env) => {
		const made = await env.createDir('/shared', undefined);
		if (!made.ok) throw made.error;
		for (const run of RUNS) {
			const written = await env.writeFile(run.path, run.text);
			if (!written.ok) throw written.error;
		}
	});
	const values = RUNS.map((run) => `('${run.label}','${run.path}')`).join(',');
	const seeded = await store.sql?.use({ name: 'seed' }, (env) =>
		env.run(
			'CREATE TABLE runs(label TEXT, path TEXT);' +
				` INSERT INTO runs VALUES ${values};` +
				' CREATE TABLE gate(name TEXT, verdict TEXT, reason TEXT);' +
				" INSERT INTO gate VALUES ('release','reject','kiln-7 failed the cure test')",
			{ maxRows: 1 },
		),
	);
	if (seeded?.ok !== true)
		throw new Error(`The lab data was not seeded: ${JSON.stringify(seeded)}`);
	return store;
}

/** The lab of the fan-out case: forty runs, each with a log file of about 3 KB. */
async function fanLab(): Promise<Workspace> {
	const dir = await mkdtemp(join(tmpdir(), 'ambion-live-compose-'));
	directories.push(dir);
	const store = openWorkspace({
		name: roomName('live-compose-fan'),
		backend: { bash: memoryBackend(), sql: sqliteBackend(join(dir, 'lab.db')) },
	});
	stores.push(store);
	await store.use({ name: 'seed' }, async (env) => {
		const made = await env.createDir('/logs', undefined);
		if (!made.ok) throw made.error;
		for (const run of FAN_RUNS) {
			const written = await env.writeFile(run.path, run.text);
			if (!written.ok) throw written.error;
		}
	});
	const values = FAN_RUNS.map((run) => `('${run.label}','${run.path}')`).join(',');
	const seeded = await store.sql?.use({ name: 'seed' }, (env) =>
		env.run(`CREATE TABLE runs(label TEXT, path TEXT); INSERT INTO runs VALUES ${values}`, {
			maxRows: 1,
		}),
	);
	if (seeded?.ok !== true)
		throw new Error(`The lab data was not seeded: ${JSON.stringify(seeded)}`);
	return store;
}

/** What one run of one seat gave: the calls it made, what it spent, and what it said. */
interface Run {
	/** The text of each say of the seat. */
	readonly text: string;
	/** Each say of the seat as JSON, so the answer holds its refs too. */
	readonly answer: string;
	/** The tools that the seat called directly, in order. */
	readonly tools: string[];
	/** The tools that compose calls made, in order. */
	readonly nested: string[];
	readonly input: number;
	readonly output: number;
	/** Milliseconds from the `compose` call to its result, when the seat made one. */
	readonly wallMs: number | undefined;
	readonly composeInputs: unknown[];
}

const composed = { compose: { evaluator: quickjsEvaluator() } };

function seat(
	name: string,
	store: Workspace,
	extra: Omit<Parameters<typeof agent>[1], 'identity' | 'bundles'>,
) {
	return agent(name, { identity: 'Runs the lab.', bundles: [store.tools()], ...extra });
}

/** The steps of one seat, summarized. The compose time is the `at` of the call and of its result. */
function callsOf(records: readonly TracedStep[], name: string) {
	const steps = records.filter((record) => record.seat === name).map((record) => record.step);
	const calls = steps.flatMap((step) => (step.type === 'tool_call' ? [step] : []));
	const compose = calls.find((step) => step.name === 'compose' && step.parent === undefined);
	const result = steps.find(
		(step) => step.type === 'tool_result' && compose !== undefined && step.call === compose.call,
	);
	const wallMs =
		compose === undefined || result === undefined
			? undefined
			: Date.parse(result.at) - Date.parse(compose.at);
	return {
		tools: calls.filter((step) => step.parent === undefined).map((step) => step.name),
		nested: calls.filter((step) => step.parent !== undefined).map((step) => step.name),
		composeInputs: calls.filter((step) => step.name === 'compose').map((step) => step.input),
		wallMs,
	};
}

/**
 * Ask one seat in a fresh room. Input tokens count the prompt, the cache
 * read, and the cache write. Output tokens count the reply. Both come from
 * the usage that each activation records.
 */
async function ask(
	definition: AgentDefinition,
	text: string,
	record: (run: Run) => void,
): Promise<Run> {
	const { session, events, records } = await open('compose', { agents: [definition] });
	try {
		const visit = await enter(session, person);
		const exchange = await visit.send({ text });
		try {
			await exchange.waitForSummary();
		} finally {
			// A run that times out still spent, so it is recorded before the error goes up.
			record(await spentBy(session, definition.name, records));
		}
		await invariants(session, events);
		return await spentBy(session, definition.name, records);
	} finally {
		await session.stop();
	}
}

async function spentBy(
	session: Awaited<ReturnType<typeof open>>['session'],
	name: string,
	records: readonly TracedStep[],
): Promise<Run> {
	const { exchanges, messages } = await session.read();
	let input = 0;
	let output = 0;
	for (const activation of exchanges.flatMap((one) => one.activations)) {
		const usage = activation.usage;
		if (usage === undefined) continue;
		input += usage.input + usage.cacheRead + usage.cacheWrite;
		output += usage.output;
	}
	const said = saidBy(messages, name);
	return {
		text: said.map((message: SaidMessage) => message.text).join('\n'),
		answer: said.map((message: SaidMessage) => JSON.stringify(message)).join('\n'),
		input,
		output,
		...callsOf(records, name),
	};
}

const holdsDigests = (answer: string, runs: typeof RUNS) => {
	for (const run of runs) expect(answer).toContain(digestOf(run.text));
};

interface Entry {
	readonly label: string;
	readonly run: Run;
	readonly note?: string;
}

/**
 * Run one case. Each recorded run becomes one JSON line in the file that
 * `AMBION_LIVE_REPORT` names, with the outcome of the case. A failed case
 * writes its lines too, because the spend happened.
 */
async function evidence(
	name: string,
	body: (record: (label: string, run: Run, note?: string) => void) => Promise<void>,
): Promise<void> {
	const entries: Entry[] = [];
	let outcome = 'passed';
	try {
		await body((label, run, note) => void entries.push({ label, run, ...(note ? { note } : {}) }));
	} catch (error) {
		outcome = `failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
		throw error;
	} finally {
		for (const { label, run, note } of entries) {
			const line = {
				kind: LIVE_KIND,
				model: MODEL,
				thinking: LIVE_THINKING,
				case: label === '' ? name : `${name} ${label}`,
				tools: run.tools,
				nested: run.nested,
				inputTokens: run.input,
				outputTokens: run.output,
				wallMs: run.wallMs ?? null,
				outcome,
				...(note === undefined ? {} : { note }),
			};
			process.stdout.write(`live · compose · ${JSON.stringify(line)}\n`);
			const file = process.env.AMBION_LIVE_REPORT;
			if (file) appendFileSync(file, `${JSON.stringify(line)}\n`);
		}
	}
}

live('compose', () => {
	it('chain: the result of sql feeds snapshot, and the seat calls compose', async () => {
		await evidence('chain', async (record) => {
			const store = await lab();
			const run = await ask(
				seat('chain', store, {
					instructions: 'Answer with one say.',
					...composed,
				}),
				CHAIN_TASK,
				(spent) => record('', spent),
			);
			expect(run.tools).toContain('compose');
			// Nested calls carry `parent`, so these are the calls the code made.
			expect(run.nested).toContain('sql');
			expect(run.nested).toContain('snapshot');
			// The JSON of a say holds seq numbers and ids, so the count is read from the text.
			expect(run.text).toMatch(new RegExp(`\\b${DRIFTED.length}\\b|four`, 'i'));
			holdsDigests(run.answer, DRIFTED);
		});
	});

	it('read before deciding: the seat reads a gate row, and its verdict decides what it does', async () => {
		await evidence('read before deciding', async (record) => {
			const store = await lab();
			const run = await ask(
				seat('gate', store, {
					instructions: 'Answer with one say.',
					...composed,
				}),
				'Read the row of the table gate named release. If its verdict is approve, snapshot ' +
					`${RUNS[0]?.path}. If it is reject, snapshot nothing and say its reason.`,
				// The guidance steers the seat to a direct call here, but code that branches
				// on the row is a valid compose call too. The choice is not deterministic.
				// The case records the choice (`tools`) and asserts the outcome only.
				(spent) =>
					record(
						'',
						spent,
						spent.tools.includes('compose') ? 'chose compose' : 'chose direct calls',
					),
			);
			const called = [...run.tools, ...run.nested];
			expect(called).toContain('sql');
			expect(called).not.toContain('snapshot');
			expect(run.answer).toContain('kiln-7');
		});
	});

	it('parallel processes: three processes of 3 seconds end in about 3 seconds', async () => {
		await evidence('parallel processes', async (record) => {
			const store = openWorkspace({
				name: roomName('live-compose-wait'),
				backend: { bash: memoryBackend() },
			});
			stores.push(store);
			const run = await ask(
				seat('runner', store, {
					instructions: 'Answer with one say.',
					...composed,
				}),
				'In one compose call, start three bash processes together with wait 0: ' +
					'"sleep 3 && echo one-ok", "sleep 3 && echo two-ok", and "sleep 3 && echo three-ok". ' +
					'Wait for each, and say the output of each.',
				(spent) => record('', spent),
			);
			expect(run.tools).toContain('compose');
			expect(run.nested.filter((tool) => tool === 'bash').length).toBeGreaterThanOrEqual(3);
			expect(run.nested).toContain('wait');
			for (const word of ['one-ok', 'two-ok', 'three-ok']) expect(run.answer).toContain(word);
			expect(run.wallMs).toBeDefined();
			// Run in turn, the processes take 9 seconds. The slowest one takes 3.
			expect(run.wallMs ?? Number.POSITIVE_INFINITY).toBeLessThan(6_000);
		});
	});

	it('token comparison: the same chain task with compose and without it', async () => {
		await evidence('token comparison', async (record) => {
			const withCompose = await ask(
				seat('with', await lab(), { instructions: 'Answer with one say.', ...composed }),
				CHAIN_TASK,
				(spent) => record('with compose', spent),
			);
			const without = await ask(
				seat('without', await lab(), { instructions: 'Answer with one say.' }),
				CHAIN_TASK,
				(spent) => record('without compose', spent),
			);
			// The case asserts the answers. The token numbers are recorded as evidence only.
			holdsDigests(withCompose.answer, DRIFTED);
			holdsDigests(without.answer, DRIFTED);
			expect(without.tools).not.toContain('compose');
		});
	});

	it('macro: the seat runs the macro of its skill by name and writes no code', async () => {
		await evidence('macro', async (record) => {
			const store = await lab();
			const skills = await loadSkills(DRIFT_SKILLS);
			const run = await ask(
				agent('macro', {
					identity: 'Runs the lab.',
					instructions: 'Answer with one say. Use your skills.',
					bundles: [store.tools({ skills })],
					...composed,
				}),
				CHAIN_TASK,
				(spent) => record('', spent),
			);
			expect(run.tools).toContain('compose');
			const inputs = run.composeInputs as { macro?: string; code?: string }[];
			expect(inputs.some((one) => one.macro === MACRO)).toBe(true);
			expect(inputs.every((one) => one.code === undefined)).toBe(true);
			holdsDigests(run.answer, DRIFTED);
		});
	});

	// Two seats run in turn, and the seat without compose can make many calls.
	it('fan-out: many logs are read and only the digests of a few matter', async () => {
		await evidence('fan-out', async (record) => {
			const wayOf = (spent: Run) => {
				if (spent.tools.includes('compose')) return 'compose';
				return [...spent.tools, ...spent.nested].includes('bash') ? 'bash' : 'direct calls';
			};
			const withCompose = await ask(
				seat('with', await fanLab(), { instructions: 'Answer with one say.', ...composed }),
				FAN_TASK,
				(spent) => record('with compose', spent, wayOf(spent)),
			);
			const without = await ask(
				seat('without', await fanLab(), { instructions: 'Answer with one say.' }),
				FAN_TASK,
				(spent) => record('without compose', spent, wayOf(spent)),
			);
			// The case does not assert the way of the seat. The way is the evidence.
			for (const run of [withCompose, without]) {
				expect(run.text).toMatch(new RegExp(`\\b${FAN_HOT.length}\\b|four`, 'i'));
				holdsDigests(run.answer, FAN_HOT);
			}
		});
	}, 360_000);
});
