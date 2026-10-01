/**
 * Exchange handles and the callers that wait on them. A handle waits for
 * the close of its exchange and for the summary. Both run one loop over one
 * registry, and the room wakes the registry after each publication and at
 * the end of the run.
 */

import { AmbionError } from '../errors.ts';
import { closedExchange, discussionMessages, summaryCompletion } from '../room/exchange.ts';
import type { ClosedExchange, ExchangeRef, Message, Seq, SummaryMessage } from '../types.ts';
import { copyMessage } from '../types.ts';
import type { RoomHostState } from './core.ts';

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

/** Reacquire an exchange by the source sequence of its opening question. */
export function exchange(host: RoomHostState, from: Seq): ExchangeHandle | undefined {
	const state = host.state();
	const close = state.closes.find((candidate) => candidate.from === from);
	const found = close ?? (state.exchange?.from === from ? state.exchange : undefined);
	if (found === undefined) return undefined;
	// A person's question or a post opens an exchange.
	const opens = state.messages.some(
		(candidate) =>
			candidate.seq === from && (candidate.kind === 'said' || candidate.kind === 'posted'),
	);
	return opens ? handleFor(host, found, false) : undefined;
}

function handleFor(host: RoomHostState, found: ExchangeRef, opened: boolean): ExchangeHandle {
	const at = host.state().messages.find((message) => message.seq === found.from)?.at ?? found.at;
	return {
		...(found.person === undefined ? {} : { person: found.person }),
		from: found.from,
		at,
		opened,
		waitForClose: () => exchangeMessages(host, found.from),
		waitForSummary: () => responseFor(host, found.from),
	};
}

/** The handle for the exchange a committed delivery belongs to. */
export function handleForMessage(host: RoomHostState, message: Message): ExchangeHandle {
	if (message.kind !== 'said' && message.kind !== 'posted')
		throw new Error('A delivery did not commit a spoken message or a post.');
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

function closedFor(host: RoomHostState, from: Seq): ClosedExchange | undefined {
	const state = host.state();
	const close = state.closes.find((candidate) => candidate.from === from);
	if (close === undefined) return undefined;
	return closedExchange(close, state.messages);
}

/**
 * Look for a fact on the state until it is there. Each wake looks again, and
 * a room that answers nothing more ends the wait with the `stopped` message.
 */
async function until<T>(
	host: RoomHostState,
	find: () => T | undefined,
	stopped: string,
): Promise<T> {
	await host.ready;
	for (;;) {
		const found = find();
		if (found !== undefined) return found;
		if (host.gone()) throw new AmbionError('room_stopped', stopped);
		await new Promise<void>((resolve) => {
			host.waiters.add(resolve);
		});
	}
}

function waitForClose(host: RoomHostState, from: Seq): Promise<ClosedExchange> {
	return until(host, () => closedFor(host, from), `Exchange '${from}' was stopped or interrupted.`);
}

async function exchangeMessages(host: RoomHostState, from: Seq): Promise<Message[]> {
	const close = await waitForClose(host, from);
	return discussionMessages(host.state().messages, close.from, close.through);
}

async function responseFor(host: RoomHostState, from: Seq): Promise<SummaryMessage | undefined> {
	const close = await waitForClose(host, from);
	const { result } = await until(
		host,
		() => {
			const result = responseResult(host, close);
			return result === 'pending' ? undefined : { result };
		},
		`Exchange '${from}' summary work was stopped or interrupted.`,
	);
	if (result === 'silent') return undefined;
	if (result === 'failed') throw new Error(`Exchange '${from}' summary work was interrupted.`);
	return copyMessage(result);
}

function responseResult(
	host: RoomHostState,
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
	return completion.kind === 'published' ? completion.summary : completion.kind;
}

/** Wake every caller that waits. Each looks at the state again. */
export function notifyExchangeWaiters(host: RoomHostState): void {
	const waiters = [...host.waiters];
	host.waiters.clear();
	for (const resolve of waiters) resolve();
}
