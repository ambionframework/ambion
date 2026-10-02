import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const template = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hasFlock = spawnSync('flock', ['--version']).status === 0;
const CLAIMS = new Set(['acting', 'reached', 'holding', 'stopping', 'safe', 'gave_up']);
const KINDS = new Set(['target', 'observe', 'drive', 'state']);
const NAME = /^[a-z][a-z0-9-]*$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A fast plant and loop: the time constant is 1 s, and the loop settles in about 1 s. */
async function setup(context, overrides = {}) {
	const root = await mkdtemp(join(tmpdir(), 'ambion-actuator-'));
	context.after(() => rm(root, { recursive: true, force: true }));
	const config = {
		name: 'bath',
		unit: 'C',
		target: 37,
		tolerance: 0.3,
		settleSeconds: 0.3,
		holdSeconds: 3,
		periodMs: 10,
		logIntervalMs: 50,
		device: 'sim',
		lock: join(root, 'bath.lock'),
		output: { name: 'power', unit: '%', min: 0, max: 100, safe: 0 },
		law: { kp: 20, ki: 60 },
		...overrides,
		sim: { ambient: 20, tau: 1, gain: 0.6, state: join(root, 'plant.json'), ...overrides.sim },
	};
	await writeFile(join(root, 'config.json'), JSON.stringify(config));
	const env = {
		...process.env,
		ACTUATOR_CONFIG: join(root, 'config.json'),
		ACTUATOR_EVENTS: join(root, 'events.jsonl'),
	};
	return { root, config, env };
}

function launch(env, file = 'controller.mjs') {
	// A fork holds no file modes, so the agent runs `bash start`, as this test does.
	const command = file === 'start' ? 'bash' : process.execPath;
	const args = file === 'start' ? [join(template, 'start')] : [file];
	const child = spawn(command, args, { cwd: template, env, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout.on('data', (part) => (output += part));
	child.stderr.on('data', (part) => (output += part));
	const ended = new Promise((done) =>
		child.once('exit', (code, signal) => done({ code, signal, output, at: Date.now() })),
	);
	return { child, ended };
}

async function events(env) {
	const text = await readFile(env.ACTUATOR_EVENTS, 'utf8').catch(() => '');
	// The controller can be in the middle of a line. Only a line with its newline is whole.
	return text
		.split('\n')
		.slice(0, -1)
		.map((line) => JSON.parse(line));
}

async function until(env, predicate, ms = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if ((await events(env)).some(predicate)) return;
		await sleep(20);
	}
	assert.fail('The expected event did not arrive.');
}

async function plant(setupResult) {
	return JSON.parse(await readFile(setupResult.config.sim.state, 'utf8'));
}

function checkLine(line) {
	assert.equal(line.v, 1);
	assert.match(line.at, AT);
	assert.ok(KINDS.has(line.kind), `unknown kind ${line.kind}`);
	if (line.kind === 'state')
		return assert.ok(CLAIMS.has(line.value), `unknown claim ${line.value}`);
	assert.match(line.name, NAME);
	assert.equal(typeof line.value, 'number');
	assert.equal(typeof line.unit, 'string');
}

const claimsOf = (lines) => lines.filter((line) => line.kind === 'state').map((line) => line.value);

test('the loop reaches the target, holds it, and exits 0 in a safe state at the deadline', async (context) => {
	// A loaded host can stop the loop for more than a second. A stop at full power overshoots
	// the target, and the loop needs about a second more to come back. Six seconds hold both.
	const setupResult = await setup(context, { holdSeconds: 6 });
	const run = launch(setupResult.env);
	const end = await run.ended;
	assert.equal(end.code, 0, end.output);
	const lines = await events(setupResult.env);
	for (const line of lines) checkLine(line);
	// A late sample on a loaded host can move the value out of the band for a moment. The loop
	// then claims `acting` with a note, and holds again. The contract is the first hold and a safe end.
	const claims = claimsOf(lines);
	assert.deepEqual(claims.slice(0, 3), ['acting', 'reached', 'holding']);
	assert.equal(claims.at(-1), 'safe');
	assert.deepEqual(
		lines
			.filter((line) => line.kind === 'state')
			.slice(3, -1)
			.filter((line) => line.value === 'acting')
			.map((line) => line.note),
		claims
			.slice(3, -1)
			.filter((claim) => claim === 'acting')
			.map(() => 'the value left the tolerance'),
	);
	assert.ok(
		claims.slice(3, -1).every((claim) => ['acting', 'reached', 'holding'].includes(claim)),
		`unexpected claims ${claims.join(', ')}`,
	);
	assert.equal(lines.at(-1).note, 'deadline');
	const last = lines.filter((line) => line.kind === 'observe').at(-1);
	assert.ok(Math.abs(last.value - 37) <= 0.3, `the last value is ${last.value}`);
	assert.equal((await plant(setupResult)).output, 0);
});

test('SIGTERM makes the device safe inside the grace and exits 0', async (context) => {
	const setupResult = await setup(context, { holdSeconds: 30 });
	const run = launch(setupResult.env);
	await until(setupResult.env, (line) => line.value === 'holding');
	assert.ok((await plant(setupResult)).output > 0);
	const sent = Date.now();
	run.child.kill('SIGTERM');
	const end = await run.ended;
	assert.equal(end.code, 0, end.output);
	assert.ok(end.at - sent < 1000, `the stop took ${end.at - sent} ms`);
	assert.deepEqual(claimsOf(await events(setupResult.env)).slice(-2), ['stopping', 'safe']);
	assert.equal((await plant(setupResult)).output, 0);
});

test('SIGKILL leaves the device driven, and finally makes it safe twice over', async (context) => {
	const setupResult = await setup(context, { holdSeconds: 30 });
	const run = launch(setupResult.env);
	await until(setupResult.env, (line) => line.value === 'holding');
	run.child.kill('SIGKILL');
	const end = await run.ended;
	assert.equal(end.signal, 'SIGKILL');
	assert.ok((await plant(setupResult)).output > 0, 'the kill left the output on');
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const backstop = await launch(setupResult.env, 'finally.mjs').ended;
		assert.equal(backstop.code, 0, backstop.output);
		assert.equal((await plant(setupResult)).output, 0);
	}
});

test('a failed read makes the device safe and exits 1, so the agent runs finally', async (context) => {
	const setupResult = await setup(context, { holdSeconds: 30, sim: { failAfterReads: 40 } });
	const end = await launch(setupResult.env).ended;
	assert.equal(end.code, 1, end.output);
	assert.match(end.output, /The simulated instrument failed/);
	const lines = await events(setupResult.env);
	assert.equal(lines.at(-1).value, 'safe');
	assert.match(lines.at(-1).note, /^error: /);
	assert.equal((await plant(setupResult)).output, 0);
});

test(
	'start holds the lock, and a second start gives up with exit 0',
	{ skip: !hasFlock },
	async (context) => {
		const first = await setup(context, { holdSeconds: 30 });
		const run = launch(first.env, 'start');
		await until(first.env, (line) => line.value === 'acting');
		const second = { ...first.env, ACTUATOR_EVENTS: join(first.root, 'second.jsonl') };
		const busy = await launch(second, 'start').ended;
		assert.equal(busy.code, 0, busy.output);
		assert.deepEqual(claimsOf(await events(second)), ['gave_up']);
		run.child.kill('SIGTERM');
		const end = await run.ended;
		assert.equal(end.code, 0, end.output);
		assert.deepEqual(claimsOf(await events(first.env)).slice(-2), ['stopping', 'safe']);
	},
);
