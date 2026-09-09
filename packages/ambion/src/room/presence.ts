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
}

/** One person the record knows, as the record last saw them. */
export interface PersonState {
	name: string;
	identity: string;
	presence: PresenceStatus;
	/** The seq of their last `left`, or undefined before their first. */
	since: Seq | undefined;
	/** When their presence last changed, ISO. */
	changedAt: string | undefined;
	/** How they read, as their latest arrival said it. */
	preferences: string | undefined;
}

/** Every person the record knows, in the order the record met them. */
export function foldPeople(messages: readonly Message[]): Map<string, PersonState> {
	const people = new Map<string, PersonState>();
	for (const message of messages) {
		if (message.kind === 'arrived') {
			const known = people.get(message.from);
			people.set(message.from, {
				name: message.from,
				identity: message.identity ?? known?.identity ?? '',
				presence: 'present',
				since: known?.since,
				changedAt: message.at,
				preferences: message.preferences ?? known?.preferences,
			});
		} else if (message.kind === 'left') {
			const known = people.get(message.from);
			if (known) {
				people.set(message.from, {
					...known,
					presence: 'absent',
					since: message.seq,
					changedAt: message.at,
				});
			}
		}
	}
	return people;
}
