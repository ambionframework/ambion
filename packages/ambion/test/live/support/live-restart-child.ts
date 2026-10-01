/** Start or resume the real-model SQLite restart fixture. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteJournals } from '@ambionframework/journal';
import type { Execution, RoomProtocol } from '../../../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSaid,
	type Room,
	type RoomNotification,
	resumeRoom,
	startRoom,
} from '../../../src/index.ts';
import { around } from '../../support/ports.ts';
import { messagesOf, participantsOf } from '../../support/room.ts';
import { nodeSql } from '../../support/storage.ts';
import { executionFor, executorFor } from './harness.ts';

const [phase, directory] = process.argv.slice(2);
if (directory === undefined || (phase !== 'start' && phase !== 'resume')) {
	throw new Error('Usage: live-restart-child.ts <start|resume> <directory>');
}

const name = 'live-restart';
const checkpointPath = join(directory, 'checkpoint.json');
const request = { key: 'live-restart-question', text: 'State the key fact for this restart.' };
const person = defineHuman({ name: 'andrei', identity: 'Founder. Asks the question.' });
const fast = defineAgent({
	name: 'fast',
	identity: 'Answers the key fact in one short sentence.',
	executor: executorFor({
		instructions:
			'Answer exactly once in one short sentence. Include the words FAST_CONFIRMED. ' +
			'Do not send another answer after that.',
	}),
});
const slow = defineAgent({
	name: 'slow',
	identity: 'Answers the key fact after a restart.',
	executor: executorFor({
		instructions:
			'Answer exactly once in one short sentence. Include the words SLOW_RECOVERED. ' +
			'Do not send another answer after that.',
	}),
});

const database = new DatabaseSync(join(directory, 'room.db'));
const storage = sqliteJournals(nodeSql(database));
const keepAlive = setInterval(() => {}, 1_000);
const fastSeq = Promise.withResolvers<number>();
const fastReleased = Promise.withResolvers<void>();
const heldSlowLease = Promise.withResolvers<number>();

/** The execution of the first run: the claim of the slow seat waits, and its answer never returns. */
function startExecution(execution: Execution): Execution {
	return around(execution, {
		room(room, request) {
			if (phase !== 'start' || request.seat !== slow.name) return room;
			const gated: RoomProtocol = {
				view: (activation, message) => room.view(activation, message),
				commit: (commit) => room.commit(commit),
				lease: async (lease) => {
					if (lease.operation === 'claim') await fastReleased.promise;
					const response = await room.lease(lease);
					if (lease.operation === 'claim' && 'ok' in response) {
						heldSlowLease.resolve(response.ok.expiresAt);
						// Keep the claim response in flight. The lease is durable and
						// live, while the activation has not read its view yet.
						await new Promise<never>(() => {});
					}
					return response;
				},
			};
			return gated;
		},
	});
}

function diagnostics(room: Room): void {
	room.subscribe((event: RoomNotification) => {
		if (event.type === 'error')
			process.stderr.write(`restart error seat=${event.seat}: ${event.error.message}\n`);
		if (event.type === 'abandoned')
			process.stderr.write(`restart abandoned seat=${event.seat} activation=${event.activation}\n`);
	});
}

async function start(): Promise<void> {
	const runtime = createRuntime({
		storage,
		execution: startExecution(executionFor()),
		limits: { lease: { ttl: 5_000, deadline: 120_000 }, activation: { backoff: () => 0 } },
	});
	const room = await startRoom({ name, agents: [fast, slow], runtime });
	diagnostics(room);
	room.subscribe((event) => {
		if (event.type === 'message' && isSaid(event.message) && event.message.from === fast.name) {
			fastSeq.resolve(event.message.seq);
		}
		if (event.type === 'activation_end' && event.seat === fast.name) fastReleased.resolve();
	});
	const visit = await room.visit(person);
	const exchange = await visit.send(request);
	const [slowExpiresAt] = await Promise.all([
		heldSlowLease.promise,
		fastSeq.promise,
		fastReleased.promise,
	]);
	const slowStatus = (await participantsOf(room)).find((seat) => seat.name === slow.name);
	assert.equal(slowStatus?.kind, 'agent');
	assert.equal(slowStatus.status, 'active');
	await writeFile(
		checkpointPath,
		JSON.stringify({
			from: exchange.from,
			fastSeq: await fastSeq.promise,
			pending: true,
			slowLease: 'active',
			slowExpiresAt,
		}),
	);
	process.stdout.write(
		`ready ${JSON.stringify({
			from: exchange.from,
			fastSeq: await fastSeq.promise,
			pending: true,
			slowLease: 'active',
			slowExpiresAt,
		})}\n`,
	);
	await new Promise<void>(() => {});
}

async function resume(): Promise<void> {
	const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
		from: number;
		fastSeq: number;
		slowExpiresAt: number;
	};
	const runtime = createRuntime({
		storage,
		execution: executionFor(),
		limits: { lease: { ttl: 5_000, deadline: 120_000 }, activation: { backoff: () => 0 } },
	});
	const room = await resumeRoom(name, { runtime, agents: [fast, slow] });
	diagnostics(room);
	try {
		const visit = await room.visit(person);
		const exchange = room.exchange(checkpoint.from);
		assert(exchange);
		const retry = await visit.send(request);
		assert.equal(retry.from, checkpoint.from);
		const discussion = await exchange.waitForClose();
		const messages = await messagesOf(room);
		const questions = messages.filter((message) => isSaid(message) && message.key === request.key);
		const fastAnswers = discussion.filter(isSaid).filter((message) => message.from === fast.name);
		const slowAnswers = discussion.filter(isSaid).filter((message) => message.from === slow.name);
		const arrivals = messages.filter((message) => message.kind === 'arrived');
		assert.equal(questions.length, 1);
		assert.equal(fastAnswers.length, 1);
		assert.equal(slowAnswers.length, 1);
		assert.equal(arrivals.length, 1);
		assert(fastAnswers[0]?.text.includes('FAST_CONFIRMED'));
		assert(slowAnswers[0]?.text.includes('SLOW_RECOVERED'));
		assert.equal(fastAnswers[0]?.seq, checkpoint.fastSeq);
		process.stdout.write(
			`recovered ${JSON.stringify({
				from: exchange.from,
				fastSeq: fastAnswers[0]?.seq,
				questionCount: questions.length,
				fastCount: fastAnswers.length,
				slowCount: slowAnswers.length,
				arrivals: arrivals.length,
			})}\n`,
		);
	} finally {
		await room.stop();
	}
}

try {
	await (phase === 'start' ? start() : resume());
} finally {
	clearInterval(keepAlive);
	database.close();
}
