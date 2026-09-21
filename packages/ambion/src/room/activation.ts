/** The authority one recorded activation grants to its seat. */

import { decodeActivationId } from '../activation-id.ts';
import type { ActivationSpec } from '../protocol.ts';
import { recipientsOf } from './exchange.ts';
import type { RoomState } from './fold.ts';
import { removedAfter } from './lease.ts';
import { activationGrant, closeFor, wellFormed } from './rules.verified.ts';

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
		parsed.source === 'closed' ? closeFor(state.closes, parsed.position, parsed.seat) : undefined;
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
		purpose.person,
		new Set(state.people.keys()),
	);
	return { id, ...grant, purpose: { ...purpose, people } };
}
