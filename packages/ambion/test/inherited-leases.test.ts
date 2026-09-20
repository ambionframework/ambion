/**
 * A resumed room keeps an unexpired lease for the runner that still lives.
 * A runner that died with its old host waits for expiry before a new attempt.
 * Both cases use the public seat calls over memory and SQLite journals.
 */
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	pi,
	type Room,
	type Runtime,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import {
	hostingOf,
	runningRoom,
	type SeatPort,
	type SeatRoom,
	type Transport,
	type Wake,
} from '../src/transport.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { roomName, storedOf } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';
import { type OpenedStorage, type Storage, storages } from './support/storage.ts';

const runner = defineAgent({
	name: 'runner',
	identity: 'Runs on a separate host.',
	executor: pi({ instructions: 'Answer once.', model: 'scripted/runner' }),
});
const person = defineHuman({ name: 'priya', identity: 'Project manager.' });

interface RecordingTransport {
	readonly transport: Transport;
	readonly wakes: Wake[];
	calls: SeatRoom | undefined;
}

/** Keep a detached seat endpoint that a test can call like a remote runner. */
function recordingTransport(): RecordingTransport {
	const wakes: Wake[] = [];
	let calls: SeatRoom | undefined;
	return {
		wakes,
		get calls() {
			return calls;
		},
		transport: {
			connect(room, _context) {
				calls = room;
				const port: SeatPort = {
					wake: async (wake) => void wakes.push(wake),
					steer: async () => {},
					cut: async () => {},
				};
				return port;
			},
		},
	};
}

function requiredCalls(recording: RecordingTransport): SeatRoom {
	if (recording.calls === undefined) throw new Error('The room did not open a seat endpoint.');
	return recording.calls;
}

interface InterruptedRoom {
	readonly opened: OpenedStorage;
	readonly clock: FakeClock;
	readonly first: Runtime;
	readonly firstCalls: SeatRoom;
	readonly name: string;
	readonly activation: string;
	readonly exchangeFrom: number;
	readonly questionReadThrough: number;
}

/** Start one question and claim its first activation, leaving that lease live. */
async function interrupted(storage: Storage): Promise<InterruptedRoom> {
	const opened = await storage.open();
	const clock = fakeClock();
	const recording = recordingTransport();
	const first = createRuntime({
		storage: opened.storage,
		clock,
		transport: recording.transport,
		wake: { expiry: 1_000, deadline: 10_000 },
		retry: { backoff: () => 0 },
	});
	const name = roomName(`inherited-${storage.name}`);
	const session = await startRoom({
		name,
		agents: [runner],
		seats: { [runner.name]: 'broadcast' },
		runtime: first,
		streamFn: scripted(() => quiet()),
	});
	const visit = await session.visit(person);
	await session.reconcile();
	const exchange = await visit.send({ text: 'What is the answer?' });
	await session.reconcile();
	const calls = requiredCalls(recording);
	const question = recording.wakes.at(-1);
	if (question === undefined) throw new Error('The question did not wake the runner.');
	const questionView = await calls.view(question.activation);
	if (!('stale' in questionView))
		throw new Error('The unclaimed question unexpectedly has a view.');
	const claimed = await calls.lease({ activation: question.activation, operation: 'claim' });
	expect(claimed).toHaveProperty('ok');
	const view = await calls.view(question.activation);
	if (!('view' in view)) throw new Error('The claimed question has no view.');
	return {
		opened,
		clock,
		first,
		firstCalls: calls,
		name,
		activation: question.activation,
		exchangeFrom: exchange.from,
		questionReadThrough: view.view.through,
	};
}

function resumedCalls(runtime: Runtime, name: string): SeatRoom {
	const calls = runningRoom(runtime, name);
	if (calls === undefined) throw new Error('The resumed room did not register.');
	return calls;
}

async function assertOldHostStale(state: InterruptedRoom): Promise<void> {
	await expect(
		state.firstCalls.lease({ activation: state.activation, operation: 'claim' }),
	).resolves.toHaveProperty('stale');
	await expect(
		state.firstCalls.lease({
			activation: state.activation,
			operation: 'renew',
			readThrough: state.questionReadThrough,
		}),
	).resolves.toHaveProperty('stale');
	await expect(
		state.firstCalls.commit({
			activation: state.activation,
			key: 'old-host-answer',
			readThrough: state.questionReadThrough,
			intent: { kind: 'said', text: 'Old host answer.' },
		}),
	).resolves.toHaveProperty('stale');
}

async function answer(
	calls: SeatRoom,
	activation: string,
	readThrough: number,
	text: string,
): Promise<void> {
	await expect(
		calls.lease({ activation, operation: 'renew', readThrough }),
	).resolves.toHaveProperty('ok');
	const view = await calls.view(activation);
	if (!('view' in view)) throw new Error('The inherited lease has no current view.');
	const result = await calls.commit({
		activation,
		key: `answer-${text}`,
		readThrough: view.view.through,
		intent: { kind: 'said', text },
	});
	expect(result).toHaveProperty('committed');
	await expect(
		calls.lease({
			activation,
			operation: 'release',
			reason: 'released',
			readThrough: view.view.through,
		}),
	).resolves.toHaveProperty('ok');
}

describe.each(storages)('inherited leases on $name', (storage) => {
	it('keeps a live remote lease and accepts its calls through the resumed host', async () => {
		const state = await interrupted(storage);
		let resumed: Room | undefined;
		try {
			hostingOf(state.first).evict(state.name);
			await assertOldHostStale(state);
			const recording = recordingTransport();
			const second = createRuntime({
				storage: state.opened.storage,
				clock: state.clock,
				transport: recording.transport,
				wake: { expiry: 1_000, deadline: 10_000 },
				retry: { backoff: () => 0 },
			});
			resumed = await resumeRoom(state.name, {
				runtime: second,
				agents: [runner],
				streamFn: scripted(() => quiet()),
			});
			const calls = resumedCalls(second, state.name);
			expect(recording.wakes).toEqual([]);
			const inherited = (await storedOf(state.opened.journals, state.name)).filter(
				(entry) =>
					entry.kind === 'lease' && (entry.body as { id?: string }).id === state.activation,
			);
			expect(inherited.at(-1)?.body).toMatchObject({ phase: 'running' });
			await answer(calls, state.activation, state.questionReadThrough, 'Remote answer.');
			await resumed.reconcile();

			const exchange = resumed.exchange(state.exchangeFrom);
			if (exchange === undefined) throw new Error('The resumed exchange is missing.');
			expect((await exchange.waitForClose()).filter(isSpoken).map((m) => m.text)).toEqual([
				'What is the answer?',
				'Remote answer.',
			]);
			const leases = (await storedOf(state.opened.journals, state.name)).filter(
				(entry) =>
					entry.kind === 'lease' && (entry.body as { id?: string }).id === state.activation,
			);
			expect(leases.at(-1)?.body).toMatchObject({ phase: 'ended', reason: 'released' });
			expect(leases.some((entry) => (entry.body as { reason?: string }).reason === 'expired')).toBe(
				false,
			);
		} finally {
			await resumed?.stop();
			await state.opened.dispose();
		}
	});

	it('waits for a lost local lease to expire, rejects its old attempt, and completes the question', async () => {
		const state = await interrupted(storage);
		let resumed: Room | undefined;
		try {
			hostingOf(state.first).evict(state.name);
			await assertOldHostStale(state);
			const recording = recordingTransport();
			const second = createRuntime({
				storage: state.opened.storage,
				clock: state.clock,
				transport: recording.transport,
				wake: { expiry: 1_000, deadline: 10_000 },
				retry: { backoff: () => 0 },
			});
			resumed = await resumeRoom(state.name, {
				runtime: second,
				agents: [runner],
				streamFn: scripted(() => quiet()),
			});
			expect(recording.wakes).toEqual([]);
			await state.clock.advance(999);
			expect(recording.wakes).toEqual([]);
			await state.clock.advance(1);
			const retry = recording.wakes.at(-1);
			if (retry === undefined) throw new Error('The expired lease did not wake a retry.');
			expect(retry.activation).toMatch(/:2$/);

			const calls = resumedCalls(second, state.name);
			await expect(
				calls.commit({
					activation: state.activation,
					key: 'old-answer',
					readThrough: state.questionReadThrough,
					intent: { kind: 'said', text: 'Too late.' },
				}),
			).resolves.toHaveProperty('stale');
			await expect(
				calls.lease({ activation: retry.activation, operation: 'claim' }),
			).resolves.toHaveProperty('ok');
			await answer(calls, retry.activation, state.questionReadThrough, 'Retry answer.');
			await resumed.reconcile();

			const exchange = resumed.exchange(state.exchangeFrom);
			if (exchange === undefined) throw new Error('The resumed exchange is missing.');
			expect((await exchange.waitForClose()).filter(isSpoken).map((m) => m.text)).toEqual([
				'What is the answer?',
				'Retry answer.',
			]);
		} finally {
			await resumed?.stop();
			await state.opened.dispose();
		}
	});
});
