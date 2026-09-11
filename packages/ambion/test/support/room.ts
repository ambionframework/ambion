import type { Session as PiSession } from '@earendil-works/pi-agent-core';
import {
	defineAgent,
	defineHuman,
	type Session,
	type SessionEvent,
	visitSession,
} from '../../src/index.ts';
import { type Runtime, type SessionOpener } from '../../src/host.ts';

/** A trivial assistant: every room seats one, and nothing that uses it tests what it writes. */
export const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message a person reads.',
	instructions: 'stay quiet',
	model: 'scripted/assistant',
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
export async function enter(session: Session, who = andrei) {
	const visit = await visitSession(session, who);
	await session.settled();
	return visit;
}

export const collect = (session: Pick<Session, 'subscribe'>) => {
	const events: SessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	return events;
};

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
export function crash(runtime: Runtime, session: Session): void {
	runtime.evict(session.name);
}

/** Every row the room wrote beside its messages, read off Pi's session directly. */
export async function rowsOf(
	sessions: SessionOpener,
	name: string,
): Promise<{ type: string; data: unknown }[]> {
	const piSession: PiSession = await sessions.open(name);
	const entries = await piSession.findEntries();
	entries.sort((a, b) => a.seq - b.seq);
	return entries.flatMap((entry) =>
		entry.type === 'custom' ? [{ type: entry.customType, data: entry.data }] : [],
	);
}

/**
 * The assistant's activation is over, whatever it decided. A summary commits
 * inside the tool call, so the activation runs on for a moment after the
 * message lands.
 */
export function assistantEnded(session: Session): Promise<void> {
	return new Promise((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== 'activation_end' || event.agent !== 'assistant') return;
			off();
			resolve();
		});
	});
}
