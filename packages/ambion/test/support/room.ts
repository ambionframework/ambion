import type { JournalEntry, JournalOpener } from '@ambionframework/journal';
import { pi } from '../../../pi/src/index.ts';
import { hostingOf } from '../../src/hosting.ts';
import {
	defineAgent,
	defineHuman,
	type Message,
	type ParticipantInfo,
	type Room,
	type RoomNotification,
	type Runtime,
} from '../../src/index.ts';
import type { RoomState } from '../../src/room/fold.ts';
import { liveWork } from '../../src/room/reconcile.ts';

/** A trivial assistant: every room seats one, and nothing that uses it tests what it writes. */
export const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message a person reads.',
	executor: pi({ instructions: 'stay quiet', model: 'scripted/assistant' }),
});

export const andrei = defineHuman({ name: 'andrei', identity: 'Founder. Owns the room.' });

let unique = 0;

/** A room name no other test in the process has used. */
export const roomName = (prefix: string) => `${prefix}-${++unique}`;

/**
 * A visitor whose arrival has already been heard. Arriving is a message, so
 * it activates the room; draining it first keeps each test's script counting
 * the activations the test is actually about.
 */
export async function enter(session: Room, who = andrei) {
	const visit = await session.visit(who);
	await waitForRoom(session, 'settled');
	return visit;
}

export const collect = (session: Pick<Room, 'subscribe'>) => {
	const events: RoomNotification[] = [];
	session.subscribe((event) => events.push(event));
	return events;
};

/** Read the current exchange through the snapshot API for lifecycle tests. */
export async function currentExchange(room: Room) {
	return stateOf(room).exchange;
}

/** Test-only access to the folded state at a notification subscription boundary. */
export function stateOf(room: Room): RoomState {
	return (room as Room & { state(): RoomState }).state();
}

/** Test-only view of a durable close, kept private to support range assertions. */
export function closedExchange(room: Room, from: number) {
	return stateOf(room).closes.find((close) => close.from === from);
}

/** Running leases are activations inherited before this run could emit a start. */
export function runningLeases(room: Room): number {
	return [...stateOf(room).leases.values()].filter((lease) => lease.phase === 'running').length;
}

/** Wait for the folded room to reach the completion boundary under test. */
export async function waitForRoom(
	room: Room,
	scope: 'settled' | 'quiet' = 'quiet',
	timeoutMs = 150_000,
): Promise<void> {
	const internal = room as Room & {
		state(): RoomState;
		runtime: Runtime;
	};
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await room.reconcile();
		await tick();
		await room.read({ messages: false });
		const work = liveWork(internal.state(), internal.runtime.clock.now());
		if (scope === 'settled' ? !work.exchange : work.rest) return;
	}
	throw new Error(`The room did not reach ${scope}.`);
}

export async function messagesOf(
	room: Pick<Room, 'read'>,
	options: { since?: number } = {},
): Promise<Message[]> {
	return [...(await room.read({ messages: options })).messages];
}

export async function participantsOf(room: Pick<Room, 'read'>): Promise<ParticipantInfo[]> {
	return [...(await room.read({ messages: false })).participants];
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The room dies without a word: no lease is released, no `left` is written,
 * and the alarm never fires. The record keeps everything, and a resume
 * over it is the test of the design.
 */
export function crash(runtime: Runtime, session: Room): void {
	hostingOf(runtime).evict(session.name);
}

/** Every native entry the room wrote, in its storage order. */
export async function storedOf(
	journals: JournalOpener,
	name: string,
): Promise<readonly JournalEntry[]> {
	const storage = await journals.open(name);
	return (await storage.read(0)).entries.map((entry) => entry.entry as JournalEntry);
}

/**
 * The assistant's activation is over, whatever it decided. A summary commits
 * inside the tool call, so the activation runs on for a moment after the
 * message lands.
 */
export function assistantEnded(session: Room): Promise<void> {
	return new Promise((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== 'activation_end' || event.agent !== 'assistant') return;
			off();
			resolve();
		});
	});
}

/**
 * The place of the last message before `seq`: what a summary stands through.
 * One counter gives out every place, so the message before a summary is not
 * at `seq - 1`; the room's own entries about the draft sit between them.
 */
export const messageBefore = (messages: readonly Message[], seq: number): number | undefined =>
	messages.filter((message) => message.seq < seq).at(-1)?.seq;
