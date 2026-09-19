/** The authority one recorded activation grants to its seat. */

import { decodeActivationId } from '../activation-id.ts';
import type { ActivationSpec } from '../protocol.ts';
import type { RoomState } from './fold.ts';
import { removalsOf } from './lease.ts';
import { onRoster } from './rules.roster.verified.ts';
import { activationGrant, closeFor, removedAfter, wellFormed } from './rules.verified.ts';

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
		onRoster(state.roster, parsed.seat),
		removedAfter(removalsOf(state.messages, parsed.seat), parsed.position),
		recorded,
		close,
	);
	return grant === undefined ? undefined : { id, ...grant };
}
