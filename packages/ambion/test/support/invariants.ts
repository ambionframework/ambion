/**
 * What holds whatever a run did. A room can go many ways; the record it
 * leaves has one shape, and every scenario ends by checking it.
 */
import { expect } from 'vitest';
import { isSummary, type SessionEvent, type SessionView } from '../../src/index.ts';

export interface InvariantOptions {
	/** How many `error` events the run may hold. A live model may refuse one call. */
	allowErrors?: number;
}

export const errorsIn = (events: SessionEvent[]) =>
	events.flatMap((e) => (e.type === 'error' ? [`${e.agent}: ${e.error.message}`] : []));

const count = (events: SessionEvent[], type: SessionEvent['type']) =>
	events.filter((e) => e.type === type).length;

export async function invariants(
	session: SessionView,
	events: SessionEvent[],
	options: InvariantOptions = {},
): Promise<void> {
	const messages = await session.messages();
	// Seqs are contiguous from 1.
	expect(messages.map((m) => m.seq)).toEqual(messages.map((_, i) => i + 1));
	// One message, one event, in record order — from the first message this run saw.
	const emitted = events.flatMap((e) => (e.type === 'message' ? [e.message.seq] : []));
	const since = emitted[0] ?? Number.POSITIVE_INFINITY;
	expect(emitted).toEqual(messages.filter((m) => m.seq >= since).map((m) => m.seq));
	// Every author is a name the room seated, admitted, or was composed with.
	const names = new Set(session.seats().map((seat) => seat.name));
	for (const message of messages) {
		if (message.kind === 'arrived' || message.kind === 'seated') names.add(message.from);
	}
	for (const message of messages) {
		expect(names).toContain(message.from);
		if ('by' in message && message.by !== undefined) expect(names).toContain(message.by);
	}
	// Every key names one message.
	const keys = messages.flatMap((m) => (m.key === undefined ? [] : [m.key]));
	expect(new Set(keys).size).toBe(keys.length);
	for (const summary of messages.filter(isSummary)) {
		expect(summary.covers.through).toBe(summary.seq - 1);
		expect(summary.covers.from).toBeLessThanOrEqual(summary.covers.through);
	}
	expect(errorsIn(events).length).toBeLessThanOrEqual(options.allowErrors ?? 0);
	expect(count(events, 'activation_start')).toBe(count(events, 'activation_end'));
	expect(count(events, 'exchange_opened')).toBe(count(events, 'exchange_closed'));
}
