/** The authority one recorded activation grants to its seat. */

import { decodeActivationId } from '../activation-id.ts';
import type { ActivationSpec } from '../protocol.ts';
import type { Seq } from '../types.ts';
import type { RoomState } from './fold.ts';
import { beforeCancellation } from './rules.verified.ts';

/** Compile a stored activation id into one room authority. */
export function activationSpec(id: string, state: RoomState): ActivationSpec | undefined {
	const parsed = decodeActivationId(id);
	if (parsed === undefined) return undefined;
	if (state.cancelledAt !== undefined && beforeCancellation(parsed.position, state.cancelledAt))
		return undefined;
	if (!state.roster.some((candidate) => candidate.name === parsed.seat)) return undefined;
	// A lease is tied to the message or close that caused it.  Once that seat
	// leaves, an old activation stays stale even if the name is seated again.
	if (
		state.messages.some(
			(message) =>
				message.kind === 'unseated' &&
				message.subject === parsed.seat &&
				message.seq > parsed.position,
		)
	)
		return undefined;
	const identity = { id, seat: parsed.seat, attempt: parsed.attempt };
	if (parsed.source === 'message') {
		return state.messages.some((message) => message.seq === parsed.position)
			? { ...identity, purpose: { kind: 'respond', message: parsed.position } }
			: undefined;
	}
	return closed(identity, parsed.position, state);
}

function closed(
	identity: { id: string; seat: string; attempt: number },
	position: Seq,
	state: RoomState,
): ActivationSpec | undefined {
	const close = state.closes.find(
		(candidate) => candidate.through === position && candidate.summary === identity.seat,
	);
	if (close === undefined) return undefined;
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
