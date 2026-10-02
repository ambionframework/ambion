/**
 * Exchange handles and the callers that wait on them. A handle waits for
 * the close of its exchange and for the summary. Both run one loop over one
 * registry, and the room wakes the registry after each publication and at
 * the end of the run.
 */

import { AmbionError } from '../errors.ts';
import { closedExchange, discussionMessages, summaryCompletion } from '../room/exchange.ts';
import type { ExchangeRange, ExchangeRef, Message, Seq, SummaryMessage } from '../types.ts';
import { copyMessage } from '../types.ts';
import type { ExchangeHandle, RoomRunState } from './core.ts';

/** Reacquire an exchange by the source sequence of its opening question. */
export function exchange(run: RoomRunState, from: Seq): ExchangeHandle | undefined {
	const state = run.state();
	const close = state.closes.find((candidate) => candidate.from === from);
	const found = close ?? (state.exchange?.from === from ? state.exchange : undefined);
	if (found === undefined) return undefined;
	// A person's question or a post opens an exchange.
	const opens = state.messages.some(
		(candidate) =>
			candidate.seq === from && (candidate.kind === 'said' || candidate.kind === 'posted'),
	);
	return opens ? handleFor(run, found, false) : undefined;
}

function handleFor(run: RoomRunState, found: ExchangeRef, opened: boolean): ExchangeHandle {
	const at = run.state().messages.find((message) => message.seq === found.from)?.at ?? found.at;
	return {
		...(found.person === undefined ? {} : { person: found.person }),
		from: found.from,
		at,
		opened,
		waitForClose: () => exchangeMessages(run, found.from),
		waitForSummary: () => responseFor(run, found.from),
	};
}

/** The handle for the exchange a committed delivery belongs to. */
export function handleForMessage(run: RoomRunState, message: Message): ExchangeHandle {
	if (message.kind !== 'said' && message.kind !== 'posted')
		throw new Error('A delivery did not commit a said message or a post.');
	const state = run.state();
	const close = state.closes.find(
		(candidate) => message.seq >= candidate.from && message.seq <= candidate.through,
	);
	const found =
		close ??
		(state.exchange !== undefined && message.seq >= state.exchange.from
			? state.exchange
			: undefined);
	if (found === undefined) throw new Error('A delivery does not belong to an exchange.');
	return handleFor(run, found, message.seq === found.from);
}

function closedFor(run: RoomRunState, from: Seq): ExchangeRange | undefined {
	const state = run.state();
	const close = state.closes.find((candidate) => candidate.from === from);
	if (close === undefined) return undefined;
	return closedExchange(close, state.messages);
}

/**
 * Look for a fact on the state until it is there. Each wake looks again, and
 * a room that answers nothing more ends the wait with the `stopped` message.
 */
async function until<T>(run: RoomRunState, find: () => T | undefined, stopped: string): Promise<T> {
	await run.ready;
	for (;;) {
		const found = find();
		if (found !== undefined) return found;
		if (run.gone()) throw new AmbionError('room_stopped', stopped);
		await new Promise<void>((resolve) => {
			run.waiters.add(resolve);
		});
	}
}

function waitForClose(run: RoomRunState, from: Seq): Promise<ExchangeRange> {
	return until(run, () => closedFor(run, from), `Exchange '${from}' was stopped or interrupted.`);
}

async function exchangeMessages(run: RoomRunState, from: Seq): Promise<Message[]> {
	const close = await waitForClose(run, from);
	return discussionMessages(run.state().messages, close.from, close.through);
}

async function responseFor(run: RoomRunState, from: Seq): Promise<SummaryMessage | undefined> {
	const close = await waitForClose(run, from);
	const { result } = await until(
		run,
		() => {
			const result = responseResult(run, close);
			return result === 'pending' ? undefined : { result };
		},
		`Exchange '${from}' summary work was stopped or interrupted.`,
	);
	if (result === 'silent') return undefined;
	if (result === 'failed') throw new Error(`Exchange '${from}' summary work was interrupted.`);
	return copyMessage(result);
}

function responseResult(
	run: RoomRunState,
	close: ExchangeRange,
): SummaryMessage | 'pending' | 'silent' | 'failed' {
	const state = run.state();
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
export function notifyExchangeWaiters(run: RoomRunState): void {
	const waiters = [...run.waiters];
	run.waiters.clear();
	for (const resolve of waiters) resolve();
}
