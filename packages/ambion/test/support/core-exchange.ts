/**
 * Set-up that the exchange, summary, cancellation and stop tests share.
 * This file imports the test runner, so no child process may import it.
 */
import { onTestFinished } from 'vitest';
import { pi } from '../../../pi/src/index.ts';
import { type RoomProtocol, runningRoom, type Transport, type Wake } from '../../src/hosting.ts';
import { defineAgent, defineHuman, type Runtime } from '../../src/index.ts';
import type { OpenedStorage, Storage } from './storage.ts';

export const person = defineHuman({ name: 'priya', identity: 'Project manager.' });

export const worker = defineAgent({
	name: 'worker',
	identity: 'Works on the question.',
	executor: pi({ instructions: 'answer the question', model: 'scripted/worker' }),
});

/**
 * Open a storage and dispose of it when the test ends. Cleanup runs in the
 * reverse order of registration, so every room the test registers after
 * this call stops before the storage closes.
 */
export async function openStorage(storage: Storage): Promise<OpenedStorage> {
	const opened = await storage.open();
	onTestFinished(() => opened.dispose());
	return opened;
}

/** A transport that records each wake and runs nothing, so no seat claims its work. */
export function recordingTransport(wakes: Wake[] = []): Transport {
	return {
		connect: () => ({
			wake: async (wake) => {
				wakes.push(wake);
			},
			steer: async () => {},
			cut: async () => {},
		}),
	};
}

/** The protocol of a running room, as a seat process reaches it. */
export function protocolOf(runtime: Runtime, name: string): RoomProtocol {
	const peer = runningRoom(runtime, name);
	if (peer === undefined) throw new Error('The room is absent.');
	return peer;
}

/** One pass of the event loop. */
export const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Report later whether the promise has settled, with a value or an error. */
export function settledFlag(promise: Promise<unknown>): () => boolean {
	let settled = false;
	const mark = () => {
		settled = true;
	};
	void promise.then(mark, mark);
	return () => settled;
}

/** A clock that moves only when the test moves it, and never fires an alarm. */
export function manualClock(start = Date.parse('2026-01-01T09:00:00.000Z')) {
	let now = start;
	return {
		clock: { now: () => now, alarm: () => () => {} },
		advance(ms: number) {
			now += ms;
		},
	};
}
