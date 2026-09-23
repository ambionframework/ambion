/**
 * A resumed room keeps an unexpired lease for the runner that still lives.
 * A runner that died with its old host waits for expiry before a new attempt.
 * Both cases use the public seat calls over memory and SQLite journals.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	type AgentPort,
	hostingOf,
	type RoomProtocol,
	runningRoom,
	type Transport,
	type Wake,
} from '../src/hosting.ts';
import {
	createRuntime,
	defineHuman,
	isSpoken,
	type Room,
	type Runtime,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { type FakeClock, fakeClock } from '../src/testing.ts';
import { roomName, scriptedAgent, storedOf } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';
import { type OpenedStorage, type Storage, storages } from './support/storage.ts';
import { stopAtEnd } from './support/stop.ts';

const runner = scriptedAgent('runner', 'Runs on a separate host.');
const person = defineHuman({ name: 'priya', identity: 'Project manager.' });
const execution = piExecution({ stream: scripted(() => quiet()) });

interface RecordingTransport {
	readonly transport: Transport;
	readonly wakes: Wake[];
	calls: RoomProtocol | undefined;
}

/** Keep a detached seat endpoint that a test can call like a remote runner. */
function recordingTransport(): RecordingTransport {
	const wakes: Wake[] = [];
	let calls: RoomProtocol | undefined;
	return {
		wakes,
		get calls() {
			return calls;
		},
		transport: {
			connect(room, _context) {
				calls = room;
				const port: AgentPort = {
					wake: async (wake) => void wakes.push(wake),
					steer: async () => {},
					cut: async () => {},
				};
				return port;
			},
		},
	};
}

/** A host over the storage whose leases expire after a second and retry at once. */
const runtimeOver = (opened: OpenedStorage, clock: FakeClock, recording: RecordingTransport) =>
	createRuntime({
		storage: opened.storage,
		clock,
		transport: recording.transport,
		limits: { lease: { ttl: 1_000, deadline: 10_000 }, activation: { backoff: () => 0 } },
	});

interface InterruptedRoom {
	readonly opened: OpenedStorage;
	readonly clock: FakeClock;
	readonly first: Runtime;
	readonly firstCalls: RoomProtocol;
	readonly name: string;
	readonly activation: string;
	readonly exchangeFrom: number;
	readonly questionReadThrough: number;
}

/** Start one question and claim its first activation, leaving that lease live. */
async function interrupted(storage: Storage): Promise<InterruptedRoom> {
	const opened = await storage.open();
	onTestFinished(() => opened.dispose());
	const clock = fakeClock();
	const recording = recordingTransport();
	const first = runtimeOver(opened, clock, recording);
	const name = roomName(`inherited-${storage.name}`);
	const session = await startRoom({
		name,
		agents: [runner],
		seats: { [runner.name]: 'broadcast' },
		runtime: first,
		execution,
	});
	const visit = await session.visit(person);
	await session.reconcile();
	const exchange = await visit.send({ text: 'What is the answer?' });
	await session.reconcile();
	const calls = recording.calls;
	if (calls === undefined) throw new Error('The room did not open a seat endpoint.');
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

/**
 * Evict the first host, check that its calls are stale, and resume the room
 * on a second host that wakes nothing at once.
 */
async function resumed(state: InterruptedRoom) {
	hostingOf(state.first).evict(state.name);
	await assertOldHostStale(state);
	const recording = recordingTransport();
	const second = runtimeOver(state.opened, state.clock, recording);
	const room = stopAtEnd(
		await resumeRoom(state.name, { runtime: second, agents: [runner], execution }),
	);
	expect(recording.wakes).toEqual([]);
	const calls = runningRoom(second, state.name);
	if (calls === undefined) throw new Error('The resumed room did not register.');
	return { room, wakes: recording.wakes, calls };
}

/** The lease changes of the interrupted activation, in journal order. */
const leasesOf = async (state: InterruptedRoom) =>
	(await storedOf(state.opened.journals, state.name)).filter(
		(entry) => entry.kind === 'lease' && (entry.body as { id?: string }).id === state.activation,
	);

/** The spoken text of the exchange once it closes on the resumed room. */
async function spoken(room: Room, from: number) {
	await room.reconcile();
	const exchange = room.exchange(from);
	if (exchange === undefined) throw new Error('The resumed exchange is missing.');
	return (await exchange.waitForClose()).filter(isSpoken).map((m) => m.text);
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
	calls: RoomProtocol,
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
		const { room, calls } = await resumed(state);
		expect((await leasesOf(state)).at(-1)?.body).toMatchObject({ phase: 'running' });
		await answer(calls, state.activation, state.questionReadThrough, 'Remote answer.');
		expect(await spoken(room, state.exchangeFrom)).toEqual([
			'What is the answer?',
			'Remote answer.',
		]);
		const leases = await leasesOf(state);
		expect(leases.at(-1)?.body).toMatchObject({ phase: 'ended', reason: 'released' });
		expect(leases.some((entry) => (entry.body as { reason?: string }).reason === 'expired')).toBe(
			false,
		);
	});

	it('waits for a lost local lease to expire, rejects its old attempt, and completes the question', async () => {
		const state = await interrupted(storage);
		const { room, calls, wakes } = await resumed(state);
		await state.clock.advance(999);
		expect(wakes).toEqual([]);
		await state.clock.advance(1);
		const retry = wakes.at(-1);
		if (retry === undefined) throw new Error('The expired lease did not wake a retry.');
		expect(retry.activation).toMatch(/:2$/);

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
		expect(await spoken(room, state.exchangeFrom)).toEqual([
			'What is the answer?',
			'Retry answer.',
		]);
	});
});
