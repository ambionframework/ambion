/**
 * Who is in the room, and where each of them stopped reading.
 *
 * Presence is a fold over the record: a person is present from their last
 * `arrived` until their next `left`. A crash writes no `left`, so the person
 * stays present until the host says they left. The one thing the record
 * does not hold is the handle a host delivers through, and that stays in
 * the running room.
 */
import type { HumanDefinition, Message, PresenceMessage, PresenceStatus, Seq } from '../types.ts';

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

/** An arrival or a departure: the two messages that change the people. */
type Meeting = PresenceMessage & { kind: 'arrived' | 'left' };

const isMeeting = (message: Message): message is Meeting =>
	message.kind === 'arrived' || message.kind === 'left';

/** One arrival or departure applied to the people. */
function meet(people: Map<string, PersonState>, message: Meeting): void {
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
	} else {
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

/**
 * The people after one more message. It returns the same map when the message
 * changes nobody, and a new map otherwise, unless the caller owns the map.
 */
export function advancePeople(
	people: Map<string, PersonState>,
	message: Message,
	own: boolean,
): Map<string, PersonState> {
	if (!isMeeting(message)) return people;
	const next = own ? people : new Map(people);
	meet(next, message);
	return next;
}
