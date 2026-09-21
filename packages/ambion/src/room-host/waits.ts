/**
 * Exchange handles and the callers that wait on them. A handle waits for
 * the close of its exchange and for the summary. The room wakes the waiters
 * after every change to the durable state.
 */

import { AmbionError } from '../errors.ts';
import { closedExchange, discussionMessages, summaryCompletion } from '../room/exchange.ts';
import type { ClosedExchange, ExchangeRef, Message, Seq, SummaryMessage } from '../types.ts';
import { copyMessage } from '../types.ts';
import type { RoomBase } from './core.ts';

export interface ExchangeHandle extends ExchangeRef {
	/**
	 * True when the delivery that returned this handle asked the question
	 * that opened the exchange. False when it joined one already open, or
	 * when the handle came from `room.exchange(from)` instead of a delivery.
	 */
	readonly opened: boolean;
	/**
	 * Resolve with the fixed non-summary conversation after the durable close.
	 * Reject if the room stops before the exchange closes.
	 */
	waitForClose(): Promise<Message[]>;
	/** Resolve with the durable summary, or `undefined` when no summary is needed; reject when required work fails. */
	waitForSummary(): Promise<SummaryMessage | undefined>;
}

/** What the waiters need of the room: the two registries of callers. */
export interface WaitsHost extends RoomBase {
	readonly closeWaiters: Map<
		Seq,
		Array<{
			resolve: (close: ClosedExchange) => void;
			reject: (error: Error) => void;
		}>
	>;
	readonly responseWaiters: Set<() => void>;
}

/** Reacquire an exchange by the source sequence of its opening question. */
export function exchange(host: WaitsHost, from: Seq): ExchangeHandle | undefined {
	const state = host.state();
	const close = state.closes.find((candidate) => candidate.from === from);
	const found = close ?? (state.exchange?.from === from ? state.exchange : undefined);
	if (found === undefined) return undefined;
	const message = state.messages.find(
		(candidate): candidate is Extract<Message, { kind: 'said' }> =>
			candidate.seq === from && candidate.kind === 'said',
	);
	return message === undefined ? undefined : handleFor(host, found, false);
}

function handleFor(host: WaitsHost, found: ExchangeRef, opened: boolean): ExchangeHandle {
	const at = host.state().messages.find((message) => message.seq === found.from)?.at ?? found.at;
	return {
		owner: found.owner,
		from: found.from,
		at,
		opened,
		waitForClose: () => exchangeMessages(host, found.from),
		waitForSummary: () => responseFor(host, found.from),
	};
}

/** The handle for the exchange a committed delivery belongs to. */
export function handleForMessage(host: WaitsHost, message: Message): ExchangeHandle {
	if (message.kind !== 'said') throw new Error('A delivery did not commit a spoken message.');
	const state = host.state();
	const close = state.closes.find(
		(candidate) => message.seq >= candidate.from && message.seq <= candidate.through,
	);
	const found =
		close ??
		(state.exchange !== undefined && message.seq >= state.exchange.from
			? state.exchange
			: undefined);
	if (found === undefined) throw new Error('A delivery does not belong to an exchange.');
	return handleFor(host, found, message.seq === found.from);
}

function closedFor(host: WaitsHost, from: Seq): ClosedExchange | undefined {
	const state = host.state();
	const close = state.closes.find((candidate) => candidate.from === from);
	if (close === undefined) return undefined;
	return closedExchange(close, state.messages);
}

async function waitForClose(host: WaitsHost, from: Seq): Promise<ClosedExchange> {
	await host.ready;
	const closed = closedFor(host, from);
	if (closed !== undefined) return closed;
	if (host.gone())
		throw new AmbionError('room_stopped', `Exchange '${from}' was stopped or interrupted.`);
	return new Promise((resolve, reject) => {
		const waiters = host.closeWaiters.get(from) ?? [];
		waiters.push({ resolve, reject });
		host.closeWaiters.set(from, waiters);
	});
}

async function exchangeMessages(host: WaitsHost, from: Seq): Promise<Message[]> {
	const close = await waitForClose(host, from);
	return discussionMessages(host.state().messages, close.from, close.through);
}

async function responseFor(host: WaitsHost, from: Seq): Promise<SummaryMessage | undefined> {
	const close = await waitForClose(host, from);
	for (;;) {
		const result = responseResult(host, close);
		if (result === 'silent') return undefined;
		if (result !== 'pending' && result !== 'failed') return copyMessage(result);
		if (result === 'failed') throw new Error(`Exchange '${from}' summary work was interrupted.`);
		if (host.gone())
			throw new AmbionError(
				'room_stopped',
				`Exchange '${from}' summary work was stopped or interrupted.`,
			);
		await new Promise<void>((resolve) => {
			host.responseWaiters.add(resolve);
		});
	}
}

function responseResult(
	host: WaitsHost,
	close: ClosedExchange,
): SummaryMessage | 'pending' | 'silent' | 'failed' {
	const state = host.state();
	const recordedClose = state.closes.find((candidate) => candidate.from === close.from);
	if (recordedClose === undefined) return 'silent';
	const completion = summaryCompletion(
		recordedClose,
		state.messages,
		state.leases,
		state.cancelledAt,
	);
	return completion.status === 'published' ? completion.summary : completion.status;
}

export function notifyExchangeWaiters(host: WaitsHost): void {
	for (const [from, waiters] of host.closeWaiters) {
		const closed = closedFor(host, from);
		if (closed === undefined) continue;
		host.closeWaiters.delete(from);
		for (const waiter of waiters) waiter.resolve(closed);
	}
	const responseWaiters = [...host.responseWaiters];
	host.responseWaiters.clear();
	for (const resolve of responseWaiters) resolve();
}

export function rejectExchangeWaiters(host: WaitsHost, error: Error): void {
	for (const [from, waiters] of host.closeWaiters) {
		host.closeWaiters.delete(from);
		for (const waiter of waiters) waiter.reject(error);
	}
	const responseWaiters = [...host.responseWaiters];
	host.responseWaiters.clear();
	for (const resolve of responseWaiters) resolve();
}
