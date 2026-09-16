/**
 * What holds whatever a run did. A room can go many ways; the record it
 * leaves has one shape, and every scenario ends by checking it.
 */

import type { JournalOpener } from '@ambionframework/journal';
import { expect } from 'vitest';
import { decodeActivationId } from '../../src/activation-id.ts';
import { isPresence, isSummary, type Room, type RoomNotification } from '../../src/index.ts';
import type { LeaseChange } from '../../src/transport.ts';
import { standing } from './history.ts';
import { storedOf } from './room.ts';

export interface InvariantOptions {
	/** How many `error` events the run may hold. A live model may refuse one call. */
	allowErrors?: number;
	/** Where the room's journal opens: with it, every seat's message is checked against its lease. */
	journals?: JournalOpener;
	/** How many activations a resumed room inherited live: their ends land in this run, their starts did not. */
	inherited?: number;
	/** Whether a resumed room inherited an open exchange: its close lands in this run, its open did not. */
	inheritedExchange?: boolean;
}

export const errorsIn = (events: RoomNotification[]) =>
	events.flatMap((e) => (e.type === 'error' ? [`${e.agent}: ${e.error.message}`] : []));

const count = (events: RoomNotification[], type: RoomNotification['type']) =>
	events.filter((e) => e.type === type).length;

export async function invariants(
	session: Room,
	events: RoomNotification[],
	options: InvariantOptions = {},
): Promise<void> {
	const messages = await session.messages();
	// Every place on the record is its own, and the record is in order. One
	// counter gives out every place, so the record is not contiguous: an entry
	// beside it takes a place from the same counter.
	const places = messages.map((m) => m.seq);
	expect(places).toEqual([...places].sort((a, b) => a - b));
	expect(new Set(places).size).toBe(places.length);
	// One message, one event, in record order — from the first message this run saw.
	const emitted = events.flatMap((e) => (e.type === 'message' ? [e.message.seq] : []));
	const since = emitted[0] ?? Number.POSITIVE_INFINITY;
	expect(emitted).toEqual(messages.filter((m) => m.seq >= since).map((m) => m.seq));
	// Every author is a name the room admitted, or was composed with.
	const names = new Set(session.participants().map((seat) => seat.name));
	for (const message of messages) {
		if (isPresence(message)) names.add(message.subject);
	}
	for (const message of messages) {
		// A seating the host decided has no author, and names nobody.
		if (message.from !== undefined) expect(names).toContain(message.from);
	}
	// Every key names one message.
	const keys = messages.flatMap((m) => (m.key === undefined ? [] : [m.key]));
	expect(new Set(keys).size).toBe(keys.length);
	await summariesMatchCloses(messages, events, options.journals, session.name);
	expect(errorsIn(events).length).toBeLessThanOrEqual(options.allowErrors ?? 0);
	expect(count(events, 'activation_start') + (options.inherited ?? 0)).toBe(
		count(events, 'activation_end'),
	);
	expect(count(events, 'exchange_opened') + (options.inheritedExchange ? 1 : 0)).toBe(
		count(events, 'exchange_closed'),
	);
	if (options.journals) await leased(session, options.journals);
}

async function summariesMatchCloses(
	messages: Awaited<ReturnType<Room['messages']>>,
	events: RoomNotification[],
	journals: JournalOpener | undefined,
	name: string,
): Promise<void> {
	const closes = await recordedCloses(events, journals, name);
	const results = new Set<number>();
	for (const summary of messages.filter(isSummary)) {
		// A summary reaches back over a fixed range that ends before it. Later
		// messages can stand between that range and its publication.
		expect(summary.covers.through).toBeLessThan(summary.seq);
		expect(summary.covers.from).toBeLessThanOrEqual(summary.covers.through);
		expect(results.has(summary.covers.from)).toBe(false);
		results.add(summary.covers.from);
		const close = closes.find((candidate) => candidate.from === summary.covers.from);
		if (close === undefined) {
			if (journals !== undefined) throw new Error('The summary has no recorded close.');
			continue;
		}
		expect(summary.covers.through).toBe(close.through);
		expect(summary.to).toBe(close.owner);
		const activation =
			summary.activationId === undefined ? undefined : decodeActivationId(summary.activationId);
		expect(activation?.source).toBe('closed');
		expect(activation?.position).toBe(close.through);
		if (close.wakes?.[0] !== undefined) {
			expect(summary.from).toBe(close.wakes[0]);
			expect(activation?.seat).toBe(close.wakes[0]);
		}
	}
}

type RecordedClose = { owner: string; from: number; through: number; wakes?: string[] };

async function recordedCloses(
	events: RoomNotification[],
	journals: JournalOpener | undefined,
	name: string,
): Promise<RecordedClose[]> {
	if (journals !== undefined) {
		return standing(await storedOf(journals, name))
			.filter((entry) => entry.kind === 'close')
			.map((entry) => entry.body as RecordedClose);
	}
	return events.flatMap((event) => (event.type === 'exchange_closed' ? [event.exchange] : []));
}

/** Every message a seat wrote carries an activation id whose lease was running when it landed. */
async function leased(session: Room, journals: JournalOpener): Promise<void> {
	// among the entries that stand: one a superseded run wrote past the fence is void
	const stored = standing(await storedOf(journals, session.name));
	const running = new Set<string>();
	for (const entry of stored) {
		if (entry.kind === 'lease') {
			const lease = entry.body as LeaseChange;
			if (lease.phase === 'running') running.add(lease.id);
			else running.delete(lease.id);
		}
		if (entry.kind !== 'message') continue;
		const message = entry.body as { activationId?: string; from: string };
		if (message.activationId === undefined) continue;
		expect(running, `${message.from}'s message under ${message.activationId}`).toContain(
			message.activationId,
		);
	}
}
