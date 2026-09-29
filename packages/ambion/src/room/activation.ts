/** The authority one recorded activation grants to its seat. */

import { decodeActivationId } from '../activation-id.ts';
import type { ActivationSpec, Stale } from '../protocol.ts';
import { recipientsOf } from './exchange.ts';
import type { RoomState } from './fold.ts';
import { type LeaseHold, removedAfter } from './lease.ts';
import { activationGrant, type CloseFact, closeFor, isLive, wellFormed } from './rules.verified.ts';

/** Why an id has no authority: the record grants it nothing. */
export const NO_GRANT = 'the activation has no room grant';

/**
 * The authority of one activation to act for its seat now: a live lease,
 * and the grant that the record gives the id. The grant holds only for a
 * seat on the roster. A seat without the authority is `stale`, so it stops
 * at once.
 */
export function seatAuthority(
	state: RoomState,
	id: string,
	now: number,
): { spec: ActivationSpec; lease: LeaseHold } | Stale {
	const lease = state.leases.get(id);
	if (lease === undefined || !isLive(lease, now)) return { stale: 'the lease ended' };
	const spec = activationSpec(id, state);
	return spec === undefined ? { stale: NO_GRANT } : { spec, lease };
}

/**
 * Compile a stored activation id into one room authority. The verified
 * `activationGrant` decides; this reads the fold for it. The decoder's
 * pattern establishes the rule's precondition, and the guard states it.
 */
export function activationSpec(id: string, state: RoomState): ActivationSpec | undefined {
	const parsed = decodeActivationId(id);
	if (parsed === undefined || !wellFormed(parsed)) return undefined;
	const recorded =
		parsed.source === 'message' &&
		state.messages.some((message) => message.seq === parsed.position);
	const close =
		parsed.source === 'closed'
			? closeFor(owingSummaries(state), parsed.position, parsed.seat)
			: undefined;
	const grant = activationGrant(
		parsed,
		state.cancelledAt,
		state.roster.some((seat) => seat.name === parsed.seat),
		removedAfter(state.messages, parsed.seat, parsed.position),
		recorded,
		close,
	);
	if (grant === undefined) return undefined;
	const { purpose } = grant;
	if (purpose.kind === 'respond') return { id, ...grant, purpose };
	const people = recipientsOf(
		state.messages,
		purpose.exchange,
		purpose.through,
		new Set(state.people.keys()),
	);
	return { id, ...grant, purpose: { ...purpose, people } };
}

/** The closes that owe a summary: each names its writer and its person. */
function owingSummaries(state: RoomState): CloseFact[] {
	return state.closes.flatMap((close) => (close.summary === undefined ? [] : [close]));
}
