/**
 * Who wakes for a message: the room's whole routing policy, in one file and
 * pure over what it is handed.
 *
 * `routes` is rules 1, 4 and 6 of the core ([`docs/agent.md`](../../../../docs/agent.md)),
 * and `wakes` is the one comparison they read off the attention scale. The
 * room writes the answer on the message, so a message and its routing are
 * one write, and every reader of the record reads who it woke.
 *
 * A seat at work is not woken. It is steered once the write is confirmed
 * (rule 2), and the steer is not on the message.
 */

import type { Body } from '../journal/journal.ts';
import type { Attention, Message } from '../types.ts';
import { activationSpec } from './activation.ts';
import type { RoomState } from './fold.ts';

/** The attention scale, narrowest first. A seat hears what it is wide enough for. */
const WIDTH: Record<Attention, number> = { none: 0, named: 1, broadcast: 2, presence: 3 };

/**
 * How wide a seat's attention has to be for this message to reach it: a
 * directed say reaches the one it names, anything else said reaches the room,
 * and a person arriving or leaving reaches the widest end.
 *
 * A summary reaches no seat at all. It is written for one person, over a
 * range the room has already closed, so it is news to nobody in the room.
 * The scale says so, because what a message reaches is the message's own
 * business and never its author's.
 */
type RoutedMessage = Message | Body<Message>;

function spoken(message: RoutedMessage): message is Extract<RoutedMessage, { kind: 'said' }> {
	return message.kind === 'said';
}

function reachOf(message: RoutedMessage): Attention {
	if (message.kind === 'summary') return 'none';
	if (!spoken(message)) return 'presence';
	return message.to === undefined ? 'broadcast' : 'named';
}

/**
 * One rule, read off the scale, in three lines. A seat the message names wakes,
 * however narrowly it is seated: a directed say names the one it addresses, and
 * a seating names the seat it seats. Everybody else wakes when their attention
 * is at least as wide as the message's reach — and a directed say reaches
 * nobody else at all. Rule 1 routes, rule 6 decides who sits out, and a
 * presence message is routed like any other.
 */
export function wakes(
	seat: { name: string; attention: Attention },
	target: string | undefined,
	message: RoutedMessage,
): boolean {
	if (seat.name === target) return true;
	const reach = reachOf(message);
	// A message that reaches nothing reaches nobody but the seat it names.
	if (reach === 'none') return false;
	if (WIDTH[seat.attention] < WIDTH[reach]) return false;
	return reach !== 'named';
}

/** The seat a message names: a directed say names who it addresses, a seating names who it seats. */
function targetOf(message: RoutedMessage): string | undefined {
	if (spoken(message)) return message.to;
	return message.kind === 'seated' ? message.subject : undefined;
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
	const author = message.from;
	const target = targetOf(message);
	// The room changes before the message does: a seating's newcomer is on
	// the roster the routing reads, so the seating wakes it.
	const roster =
		message.kind === 'seated'
			? [...state.roster, { name: message.subject, attention: message.attention ?? 'broadcast' }]
			: state.roster;
	const woken = roster
		.filter((seat) => seat.name !== author && !holdsOrdinary(state, live.get(seat.name)))
		.filter((seat) => wakes(seat, target, message))
		.map((seat) => seat.name);
	return [...new Set(woken)];
}

/** Closing work does not block a new ordinary activation for the same seat. */
function holdsOrdinary(state: RoomState, ids: readonly string[] | undefined): boolean {
	return ids?.some((id) => activationSpec(id, state)?.purpose.kind === 'respond') ?? false;
}
