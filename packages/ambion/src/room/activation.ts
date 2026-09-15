/** The authority one recorded activation grants to its seat. */

import { assistantSeat } from '../assistant.ts';
import type { Seq } from '../types.ts';
import type { ActivationSpec } from '../wire.ts';
import type { RoomState } from './fold.ts';
import { parseId } from './lease.ts';

/** Compile the recorded cause and current composition into one activation authority. */
export function activationSpec(id: string, state: RoomState): ActivationSpec | undefined {
	const parsed = parseId(id);
	if (parsed === undefined) return undefined;
	const seated = state.roster.find((candidate) => candidate.name === parsed.seat);
	if (seated === undefined) return undefined;
	const identity = { id, seat: parsed.seat, attempt: parsed.attempt };
	if (parsed.cause === 'message') {
		if (parsed.seat === assistantSeat(state.composition, state.roster)) return undefined;
		if (!state.messages.some((message) => message.seq === parsed.position)) return undefined;
		return {
			...identity,
			cause: 'message',
			through: state.lastSeq,
			grant: { kind: 'say', tool: 'say' },
		};
	}
	return parsed.cause === 'opened'
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
		cause: 'opened',
		through: state.lastSeq,
		opening: { person: question.from, from: question.seq, limit: state.reserve.length },
		grant: { kind: 'seat', tool: 'seat' },
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
		cause: 'closed',
		through: close.through,
		closing: { person: close.owner, from: close.from, through: close.through },
		grant: { kind: 'summary', tool: 'summarise' },
	};
}
