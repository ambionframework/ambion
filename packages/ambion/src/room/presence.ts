/**
 * Who is in the room, and where each of them stopped reading.
 *
 * Presence is a fold over the record: a person is present from their last
 * `arrived` until their next `left`. A crash writes no `left`, so the person
 * stays present until the host says they left. The one thing the record
 * does not hold is the handle a host delivers through, and that stays in
 * the running room.
 */
import type { HumanDefinition, Message, PresenceStatus, Seq } from '../types.ts';

/** One person in the room, for as long as they are in it. */
export interface VisitRuntime {
	human: HumanDefinition;
	gone: boolean;
	/** A departure in progress, shared by every caller of this handle. */
	departure?: Promise<void>;
	/** Stable idempotency key for a departure whose acknowledgement was lost. */
	departureKey?: string;
}

/** One person the record knows, as the record last saw them. */
export interface PersonState {
	name: string;
	identity: string;
	presence: PresenceStatus;
	/** The seq of their last `left`, or undefined before their first. */
	lastDeparture: Seq | undefined;
	/** When their presence last changed, ISO. */
	changedAt: string | undefined;
	/** How they read, as their latest arrival said it. */
	preferences: string | undefined;
}

/** One arrival or departure applied to the people. Any other message changes nothing. */
function meet(people: Map<string, PersonState>, message: Message): void {
	if (message.kind === 'arrived') {
		const known = people.get(message.subject);
		people.set(message.subject, {
			name: message.subject,
			identity: message.identity ?? known?.identity ?? '',
			presence: 'present',
			lastDeparture: known?.lastDeparture,
			changedAt: message.at,
			preferences: message.preferences ?? known?.preferences,
		});
	} else if (message.kind === 'left') {
		const known = people.get(message.subject);
		if (known) {
			people.set(message.subject, {
				...known,
				presence: 'absent',
				lastDeparture: message.seq,
				changedAt: message.at,
			});
		}
	}
}

/** Every person the record knows, in the order the record met them. */
export function foldPeople(messages: readonly Message[]): Map<string, PersonState> {
	const people = new Map<string, PersonState>();
	for (const message of messages) meet(people, message);
	return people;
}

/**
 * The people after one more message. It returns the same map when the message
 * changes nobody, and a new map otherwise, unless the caller owns the map.
 */
export function advancePeople(
	people: Map<string, PersonState>,
	message: Message,
	own: boolean,
): Map<string, PersonState> {
	if (message.kind !== 'arrived' && message.kind !== 'left') return people;
	const next = own ? people : new Map(people);
	meet(next, message);
	return next;
}
