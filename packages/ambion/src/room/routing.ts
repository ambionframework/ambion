/**
 * Who wakes for a message: the room's whole routing policy, in one file and
 * pure over what it is handed.
 *
 * `routes` is rules 1, 4 and 6 of the core ([`docs/agent.md`](../../../../docs/agent.md)).
 * The verified `woken` decides who wakes, and the verified `wakes` is the one
 * comparison it reads off the attention scale. The room writes the answer on
 * the message, so a message and its routing are one write, and every reader
 * of the record reads who it woke.
 *
 * A seat at work is not woken. It is steered once the write is confirmed
 * (rule 2), and the steer is not on the message.
 */

import type { Body } from '../journal/journal.ts';
import type { Message } from '../types.ts';
import { activationSpec } from './activation.ts';
import type { RoomState } from './fold.ts';
import { reachOf, rosterFor, targetOf, woken } from './rules.roster.verified.ts';

type RoutedMessage = Message | Body<Message>;

function spoken(message: RoutedMessage): message is Extract<RoutedMessage, { kind: 'said' }> {
	return message.kind === 'said';
}

/**
 * Who wakes for a message — the same answer for what a person said, what a
 * person did, and what a colleague said. An idle seat wakes when the
 * attention it was seated at reaches the message.
 *
 * `live` names the seats the room is already waiting on, so nothing here
 * wakes a seat twice.
 */
export function routes(
	message: RoutedMessage,
	state: RoomState,
	live: ReadonlyMap<string, string[]>,
): string[] {
	// The room changes before the message does: a seating's newcomer is on
	// the roster the routing reads, so the seating wakes it.
	const seated = message.kind === 'seated';
	const roster = rosterFor(
		state.roster,
		seated,
		seated ? message.subject : '',
		seated ? message.attention : undefined,
	);
	const target = targetOf(
		message.kind,
		spoken(message) ? message.to : undefined,
		seated ? message.subject : undefined,
	);
	const reach = reachOf(message.kind, spoken(message) && message.to !== undefined);
	const busy = roster
		.map((seat) => seat.name)
		.filter((name) => holdsOrdinary(state, live.get(name)));
	return [...new Set(woken(roster, message.from, target, reach, busy))];
}

/** Closing work does not block a new ordinary activation for the same seat. */
function holdsOrdinary(state: RoomState, ids: readonly string[] | undefined): boolean {
	return ids?.some((id) => activationSpec(id, state)?.purpose.kind === 'respond') ?? false;
}
