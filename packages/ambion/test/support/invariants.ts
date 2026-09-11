/**
 * What holds whatever a run did. A room can go many ways; the record it
 * leaves has one shape, and every scenario ends by checking it.
 */
import { expect } from 'vitest';
import {
	isSummary,
	type LeaseChange,
	type SessionEvent,
	type SessionOpener,
	type SessionView,
} from '../../src/index.ts';
import { standing } from './history.ts';
import { rowsOf } from './room.ts';

export interface InvariantOptions {
	/** How many `error` events the run may hold. A live model may refuse one call. */
	allowErrors?: number;
	/** Where the room's log opens: with it, every seat's message is checked against its lease. */
	sessions?: SessionOpener;
	/** How many activations a resumed room inherited live: their ends land in this run, their starts did not. */
	inherited?: number;
	/** Whether a resumed room inherited an open exchange: its close lands in this run, its open did not. */
	inheritedExchange?: boolean;
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
		if (message.kind === 'arrived' || message.kind === 'seated' || message.kind === 'unseated') {
			names.add(message.from);
		}
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
	expect(count(events, 'activation_start') + (options.inherited ?? 0)).toBe(
		count(events, 'activation_end'),
	);
	expect(count(events, 'exchange_opened') + (options.inheritedExchange ? 1 : 0)).toBe(
		count(events, 'exchange_closed'),
	);
	if (options.sessions) await leased(session, options.sessions);
}

/** Every message a seat wrote carries an activation id whose lease was running when it landed. */
async function leased(session: SessionView, sessions: SessionOpener): Promise<void> {
	// among the rows that stand: a row a superseded run wrote past the fence is void
	const rows = standing(await rowsOf(sessions, session.name));
	const running = new Set<string>();
	for (const row of rows) {
		if (row.type === 'ambion/lease') {
			const lease = row.data as LeaseChange;
			if (lease.phase === 'running') running.add(lease.id);
			else running.delete(lease.id);
		}
		if (row.type !== 'ambion/message') continue;
		const message = row.data as { activationId?: string; from: string };
		if (message.activationId === undefined) continue;
		expect(running, `${message.from}'s message under ${message.activationId}`).toContain(
			message.activationId,
		);
	}
}
