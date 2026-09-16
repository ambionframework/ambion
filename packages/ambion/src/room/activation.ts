/** The authority one recorded activation grants to its seat. */

import { decodeActivationId } from '../activation-id.ts';
import { assistantSeat } from '../assistant.ts';
import type { Seq } from '../types.ts';
import type { ActivationSpec } from '../wire.ts';
import type { RoomState } from './fold.ts';

/** Compile a stored activation id into one room authority. */
export function activationSpec(id: string, state: RoomState): ActivationSpec | undefined {
	const parsed = decodeActivationId(id);
	if (parsed === undefined) return undefined;
	const seated = state.roster.find((candidate) => candidate.name === parsed.seat);
	if (seated === undefined) return undefined;
	const identity = { id, seat: parsed.seat, attempt: parsed.attempt };
	if (parsed.source === 'message') {
		if (parsed.seat === assistantSeat(state.composition, state.roster)) return undefined;
		if (!state.messages.some((message) => message.seq === parsed.position)) return undefined;
		return {
			...identity,
			purpose: { kind: 'respond', message: parsed.position },
		};
	}
	return parsed.source === 'opened'
		? opened(identity, parsed.position, state)
		: closed(identity, parsed.position, state);
}

function opened(
	identity: { id: string; seat: string; attempt: number },
	position: Seq,
	state: RoomState,
): ActivationSpec | undefined {
	const question = state.messages.find((message) => message.seq === position);
	if (
		question?.kind !== 'said' ||
		(state.exchange?.from !== position && !state.closes.some((close) => close.from === position))
	)
		return undefined;
	if (assistantSeat(state.composition, state.roster) !== identity.seat) return undefined;
	return {
		...identity,
		purpose: {
			kind: 'select',
			exchange: question.seq,
			person: question.from,
			limit: state.reserve.length,
		},
	};
}

function closed(
	identity: { id: string; seat: string; attempt: number },
	position: Seq,
	state: RoomState,
): ActivationSpec | undefined {
	const close = state.closes.find(
		(candidate) => candidate.through === position && candidate.wakes?.[0] === identity.seat,
	);
	if (close === undefined) return undefined;
	if (assistantSeat(state.composition, state.roster) !== identity.seat) return undefined;
	return {
		...identity,
		purpose: {
			kind: 'summarize',
			exchange: close.from,
			person: close.owner,
			through: close.through,
		},
	};
}
