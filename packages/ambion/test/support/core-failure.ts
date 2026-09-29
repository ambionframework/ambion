/**
 * Shared parts of the failure tests: a storage that closes when the test
 * ends, an execution with some calls of its ports replaced, a seeded random
 * source, and the reader of a child process that reports its writes.
 * The test runner imports this file, and no child process does.
 */
import { expect } from 'vitest';
import type {
	AgentPort,
	ConnectorRequest,
	Execution,
	RoomProtocol,
	Steer,
	Wake,
} from '../../src/hosting.ts';
import type { Room } from '../../src/index.ts';
import type { FakeClock } from '../../src/testing.ts';
import type { Cast } from './cast.ts';
import { type CrashPoint, idle, World, within } from './chaos.ts';
import { around } from './ports.ts';
import { messagesOf, roomName } from './room.ts';
import { openFor } from './stop.ts';
import type { Storage } from './storage.ts';

/** The calls a test replaces. Each replacement gets the port of the execution or the room. */
export interface Tap {
	wake?: (wake: Wake, port: AgentPort) => Promise<void>;
	steer?: (steer: Steer, port: AgentPort) => Promise<void>;
	room?: (room: RoomProtocol, request: ConnectorRequest) => Partial<RoomProtocol>;
}

/** `execution`, with the calls of `tap` replaced on each port that it connects. */
export function tapped(execution: Execution, tap: Tap): Execution {
	return around(execution, {
		room: (room, request) => ({
			view: (id, range) => room.view(id, range),
			commit: (commit) => room.commit(commit),
			lease: (lease) => room.lease(lease),
			...tap.room?.(room, request),
		}),
		port: (port) => ({
			cut: (activation) => port.cut(activation),
			wake: (wake) => (tap.wake ? tap.wake(wake, port) : port.wake(wake)),
			steer: (steer) => (tap.steer ? tap.steer(steer, port) : port.steer(steer)),
		}),
	});
}

/** Mark a rejection as observed, so a test can assert it later. */
export function observed<T>(promise: Promise<T>): Promise<T> {
	void promise.catch(() => {});
	return promise;
}

/** Let the queued callbacks run. */
export async function flush(): Promise<void> {
	for (let round = 0; round < 5; round += 1)
		await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A small, fast, seedable generator: the walk is the same for the same seed. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Time moves until the room is quiet with nothing owed: the lease that a
 * stopped or killed process held expires, and every retry's backoff passes.
 */
export async function quietNow(session: Room, clock: FakeClock): Promise<void> {
	for (let round = 0; round < 12; round += 1) {
		const settled = await Promise.race([
			messagesOf(session).then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
		]);
		if (settled && (await idle(session))) return;
		await clock.advance(2_000);
	}
	throw new Error('the room never went quiet');
}

/** Every `write N` line and the `done` line the child prints, as it prints them. */
export function childWrites(
	stdout: NodeJS.ReadableStream,
	report: (last: number | 'done') => void,
): void {
	let buffer = '';
	stdout.on('data', (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			const reported = /^write (\d+)$/.exec(line);
			if (reported) report(Number(reported[1]));
			else if (line === 'done') report('done');
		}
	});
}

/** Freeze a value deeply, so a later mutation fails where it happens. */
export function freeze(value: unknown): void {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
	if (value instanceof Map) for (const entry of value.values()) freeze(entry);
	else for (const entry of Object.values(value)) freeze(entry);
	Object.freeze(value);
}

/** The appends the scenario takes when nothing crashes: the crash points a sweep visits. */
export async function countWrites(storage: Storage, cast?: Cast): Promise<number> {
	const opened = await storage.open();
	const world = new World(roomName('count'), opened, undefined, cast);
	try {
		await world.run();
		await world.check();
		// the stop writes too, and no sweep run gets that far before its check
		const writes = world.writes;
		await world.room.stop();
		return writes;
	} finally {
		await opened.dispose();
	}
}

/** Run the scenario with one crash, resume it, and check that the record ends whole. */
export async function crashOnce(
	storage: Storage,
	prefix: string,
	crash: CrashPoint,
	cast?: Cast,
): Promise<void> {
	const opened = await openFor(storage);
	const world = new World(roomName(`${prefix}-${crash.mode}`), opened, crash, cast);
	try {
		await within(world.run(), 20_000, 'the scenario');
		expect(world.crashes).toBe(1);
		await world.check();
		await world.room.stop();
	} catch (error) {
		throw new Error(`crash ${crash.mode} write ${crash.at}:\n${await world.describe()}`, {
			cause: error,
		});
	}
}
