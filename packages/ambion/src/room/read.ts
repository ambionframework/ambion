/** Coherent, detached room reads built from one folded projection. */

import {
	copyMessage,
	type ExchangeView,
	type Message,
	type RoomSnapshot,
	type Seq,
} from '../types.ts';
import { exchangeViews } from './exchange.ts';
import type { RoomState } from './fold.ts';
import { liveWork } from './reconcile.ts';
import { messagesSince } from './rules.record.verified.ts';
import { participantsOf } from './view.ts';

export type MessageSelection = false | { since?: Seq };

/** Capture a caller's selection before an asynchronous read begins. */
export function captureMessageSelection(
	selection: MessageSelection | undefined,
): MessageSelection | undefined {
	const captured =
		selection === false || selection === undefined ? selection : { since: selection.since };
	validateSelection(captured);
	return captured;
}

/** Build a room read without executing, reconciling, or changing the journal. */
export function readView(
	name: string,
	state: RoomState,
	now: number,
	watermark: Seq,
	messages: MessageSelection | undefined,
): RoomSnapshot {
	validateSelection(messages);
	if (state.composition === undefined)
		return {
			name,
			initialized: false,
			messages: [],
			participants: [],
			exchanges: [],
			exchange: undefined,
			watermark,
		};

	const exchanges = exchangeViews(
		state.closes,
		state.messages,
		state.exchange,
		state.leases,
		state.cancelledAt,
	);
	const current = exchanges.find(
		(exchange): exchange is Extract<ExchangeView, { readonly status: 'open' }> =>
			exchange.status === 'open',
	);
	return {
		name,
		initialized: true,
		...(state.composition.goal === undefined ? {} : { goal: state.composition.goal }),
		messages: selectMessages(state.messages, messages),
		participants: participantsOf({ state, live: liveWork(state, now).seats }),
		exchanges,
		exchange: current,
		watermark,
	};
}

/** Validate and select before cloning so status reads do not copy history. */
function selectMessages(
	all: readonly Message[],
	selection: MessageSelection | undefined,
): readonly Message[] {
	if (selection === false) return [];
	const since = selection?.since;
	const selected = since === undefined ? all : messagesSince(all, since);
	return selected.map(copyMessage);
}

function validateSelection(selection: MessageSelection | undefined): void {
	const since = selection === false ? undefined : selection?.since;
	if (since !== undefined && (!Number.isSafeInteger(since) || since < 0))
		throw new RangeError('Message cursor must be a non-negative safe integer.');
}
