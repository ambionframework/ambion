/** Coherent, detached room reads built from one folded projection. */

import { copyMessage, type Exchange, type Message, type RoomRead, type Seq } from '../types.ts';
import { exchangeViews } from './exchange.ts';
import type { RoomState } from './fold.ts';
import { liveWork } from './reconcile.ts';
import { participantsOf } from './view.ts';

export type MessageSelection = false | { after?: Seq };

/** Capture a caller's selection before an asynchronous read begins. */
export function captureMessageSelection(
	selection: MessageSelection | undefined,
): MessageSelection | undefined {
	const captured =
		selection === false || selection === undefined ? selection : { after: selection.after };
	validateSelection(captured);
	return captured;
}

/** Build a room read without executing, reconciling, or changing the journal. */
export function toRoomRead(
	name: string,
	state: RoomState,
	now: number,
	through: Seq,
	messages: MessageSelection | undefined,
): RoomRead {
	validateSelection(messages);
	if (state.composition === undefined)
		return {
			name,
			initialized: false,
			messages: [],
			scheduled: [],
			participants: [],
			exchanges: [],
			exchange: undefined,
			through,
		};

	const exchanges = exchangeViews(
		state.closes,
		state.messages,
		state.exchange,
		state.leases,
		state.cancelledAt,
		new Set(state.people.keys()),
	);
	const current = exchanges.find(
		(exchange): exchange is Extract<Exchange, { readonly status: 'open' }> =>
			exchange.status === 'open',
	);
	return {
		name,
		initialized: true,
		...(state.composition.goal === undefined ? {} : { goal: state.composition.goal }),
		messages: selectMessages(state.messages, messages),
		scheduled: structuredClone(state.scheduled),
		participants: participantsOf({ state, live: liveWork(state, now).seats }),
		exchanges,
		exchange: current,
		through,
	};
}

/** Validate and select before cloning so status reads do not copy history. */
function selectMessages(
	all: readonly Message[],
	selection: MessageSelection | undefined,
): readonly Message[] {
	if (selection === false) return [];
	const after = selection?.after;
	const selected = after === undefined ? all : all.filter((message) => message.seq > after);
	return selected.map(copyMessage);
}

function validateSelection(selection: MessageSelection | undefined): void {
	const after = selection === false ? undefined : selection?.after;
	if (after !== undefined && (!Number.isSafeInteger(after) || after < 0))
		throw new RangeError('Message cursor must be a non-negative safe integer.');
}

/**
 * The closed exchanges that wait on one person: the last spoken message asks
 * them and they have said nothing since. The read holds the answer, so this
 * waits for nothing and starts nothing.
 */
export function pendingFor(
	read: RoomRead,
	person: string,
): Extract<Exchange, { readonly status: 'closed' }>[] {
	return read.exchanges.filter(
		(exchange): exchange is Extract<Exchange, { readonly status: 'closed' }> =>
			exchange.status === 'closed' &&
			exchange.outcome.kind === 'awaiting' &&
			exchange.outcome.person === person,
	);
}
