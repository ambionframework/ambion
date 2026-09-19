/**
 * Who is in the room, and where each of them stopped reading.
 *
 * Presence is a fold over the record: a person is present from their last
 * `arrived` until their next `left`. A crash writes no `left`, so the person
 * stays present until the host says they left. The one thing the record
 * does not hold is the handle a host delivers through, and that stays in
 * the running room.
 */
import {
	type HumanDefinition,
	isPresence,
	type Message,
	type PresenceStatus,
	type Seq,
} from '../types.ts';
import { foldPresence } from './rules.roster.verified.ts';

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
	since: Seq | undefined;
	/** When their presence last changed, ISO. */
	changedAt: string | undefined;
	/** How they read, as their latest arrival said it. */
	preferences: string | undefined;
}

/** Every person the record knows, in the order the record met them. */
export function foldPeople(messages: readonly Message[]): Map<string, PersonState> {
	// Only the projection is here. The verified `foldPresence` decides.
	return foldPresence(
		messages.filter(isPresence).map((message) => ({
			kind: message.kind,
			name: message.subject,
			seq: message.seq,
			at: message.at,
			identity: message.identity,
			preferences: message.preferences,
		})),
	);
}
