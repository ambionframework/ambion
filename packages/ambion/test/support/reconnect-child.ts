/** A fresh Node process for each side of a SQLite recovery test. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteJournals } from '@ambionframework/journal';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	pi,
	readRoom,
	resumeRoom,
	startRoom,
} from '../../src/index.ts';
import { fakeClock } from './clock.ts';
import { messagesOf } from './room.ts';
import { quiet, scripted, speak } from './scripted.ts';
import { nodeSql } from './storage.ts';

const [phase, directory] = process.argv.slice(2);
if (directory === undefined || (phase !== 'start' && phase !== 'resume')) {
	throw new Error('Usage: reconnect-child.ts <start|resume> <directory>');
}
const database = new DatabaseSync(join(directory, 'room.db'));
const name = 'process-reconnect';
const human = defineHuman({ name: 'owner', identity: 'Owns the request.' });
const worker = defineAgent({
	name: 'worker',
	identity: 'Answers the request.',
	executor: pi({ instructions: 'Answer once.', model: 'scripted/worker' }),
});
const request = { text: 'Recover this request.', key: 'persisted-delivery' };
const checkpointPath = join(directory, 'client.json');
const started = Promise.withResolvers<void>();
const clock = fakeClock(phase === 'start' ? 1_000 : 2_000);
const runtime = createRuntime({
	storage: sqliteJournals(nodeSql(database)),
	clock,
	wake: { expiry: 100, deadline: 1_000 },
	retry: { backoff: () => 0 },
	stream: scripted(async (_context, _agent, call) => {
		if (phase === 'resume') return call === 1 ? speak('Recovered answer.') : quiet();
		started.resolve();
		return new Promise<ReturnType<typeof quiet>>(() => {});
	}),
});

async function start(): Promise<void> {
	const room = await startRoom({ name, runtime, agents: [worker] });
	const visit = await room.visit(human);
	// Persist the request before sending, so an uncertain acknowledgement can be retried.
	await writeFile(checkpointPath, JSON.stringify({ request }));
	const exchange = await visit.send(request);
	await started.promise;
	await writeFile(
		checkpointPath,
		JSON.stringify({ request, from: exchange.from, cursor: exchange.from }),
	);
	process.stdout.write('ready\n');
	// The parent kills this process while its lease is active. No stop or leave runs.
	await new Promise<void>(() => {});
}

async function resume(): Promise<void> {
	const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
		request: typeof request;
		from: number;
		cursor: number;
	};
	const before = await readRoom(name, { runtime });
	assert.equal(before.exchange?.from, checkpoint.from);
	assert.equal(
		before.messages.some((message) => message.kind === 'left'),
		false,
	);
	assert.ok(
		before.participants.some((person) => person.kind === 'human' && person.presence === 'present'),
	);

	const room = await resumeRoom(name, { runtime, agents: [worker] });
	try {
		const visit = await room.visit(human);
		const exchange = room.exchange(checkpoint.from);
		assert.ok(exchange);
		assert.equal((await visit.send(checkpoint.request)).from, exchange.from);
		const discussion = await exchange.waitForClose();
		assert.ok(
			discussion.some((message) => message.kind === 'said' && message.text === 'Recovered answer.'),
		);
		assert.equal(await exchange.waitForSummary(), undefined);
		const messages = await messagesOf(room);
		assert.equal(messages.filter((message) => message.kind === 'arrived').length, 1);
		assert.equal(
			messages.filter((message) => message.kind === 'said' && message.key === request.key).length,
			1,
		);
		const missed = await messagesOf(room, { since: checkpoint.cursor });
		assert.ok(missed.length > 0);
		assert.ok(missed.every((message) => message.seq > checkpoint.cursor));
		assert.ok(
			missed.some((message) => message.kind === 'said' && message.text === 'Recovered answer.'),
		);
		await visit.leave();
	} finally {
		await room.stop();
	}
	process.stdout.write('recovered\n');
}

// A service normally has a server socket. The fixture keeps its process alive explicitly.
const keepAlive = setInterval(() => {}, 1_000);
try {
	await (phase === 'start' ? start() : resume());
} finally {
	clearInterval(keepAlive);
	database.close();
}
