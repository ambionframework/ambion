/**
 * What every mechanism of the room host shares: the view of the room each
 * one reads, and the way a decision becomes an entry on the journal.
 *
 * `RoomHost` in `room.ts` holds all state. A mechanism module exports
 * functions that take a view of the room, the same way `answers.ts` does.
 */

import { AmbionError } from '../errors.ts';
import type { RoomRuntime } from '../host/runtime.ts';
import type { Composition } from '../journal/events.ts';
import type { Kind, RoomJournal } from '../journal/journal.ts';
import type { RoomState } from '../room/fold.ts';
import type { Refusal, RoomDecision } from '../room/transition.ts';
import type { Message, RoomNotification, SpokenMessage, Without } from '../types.ts';
import { copyMessage } from '../types.ts';
import type { CompositionDraft } from './room.ts';

/** What every mechanism needs of the room. */
export interface RoomBase {
	readonly name: string;
	readonly runtime: RoomRuntime;
	readonly journal: RoomJournal;
	/** The replay, the composition on the journal, and the first reconcile. Every operation waits here. */
	readonly ready: Promise<void>;
	now(): number;
	/** Every fact about the room, folded over the journal as it stands. */
	state(): RoomState;
	/** The room answers nothing more: the host stopped it, or it was dropped. */
	gone(): boolean;
	emit(event: RoomNotification): void;
	reconcile(): Promise<void>;
}

export type SubmissionResult<K extends Kind> =
	Exclude<RoomDecision<K>, { event: unknown }> | undefined;

/** The refusal a decision made, as the error the host catches. */
export const refusalError = (refusal: Refusal): AmbionError =>
	'reason' in refusal
		? new AmbionError(refusal.category, refusal.reason)
		: new AmbionError('stale', 'The record moved.');

/** The room's one typed adapter from a decision to the generic journal queue. */
export function submit<K extends Kind>(
	journal: RoomJournal,
	kind: K,
	decision: () => RoomDecision<K>,
	key?: string,
) {
	return journal.append(kind, {
		...(key === undefined ? {} : { key }),
		decide: () => {
			const result = decision();
			if ('event' in result)
				return result.event === undefined ? { result: undefined } : { body: result.event.body };
			return { result };
		},
	});
}

/** Convert a refused internal decision to the existing room API error. */
export function requireSubmission<K extends Kind>(
	result: { entry: unknown } | { result: SubmissionResult<K> },
): void {
	if ('result' in result && result.result !== undefined && 'refusal' in result.result)
		throw refusalError(result.result.refusal);
}

export function acceptedEvent<K extends Kind>(decision: RoomDecision<K>) {
	if ('refusal' in decision) throw refusalError(decision.refusal);
	return 'event' in decision ? decision.event : undefined;
}

/** Refs match in order. An absent list and an empty list are the same. */
export const sameRefs = (
	a: readonly string[] | undefined,
	b: readonly string[] | undefined,
): boolean => {
	const left = a ?? [];
	const right = b ?? [];
	return left.length === right.length && left.every((ref, index) => ref === right[index]);
};

/** A recorded `said` carries the recipient, the text, the refs, and the `after` that a same-key retry sent. */
export const saidContentMatches = (
	message: Pick<SpokenMessage, 'to' | 'text' | 'refs' | 'after'>,
	said: { to?: string; text: string; refs?: readonly string[]; after?: number },
): boolean =>
	message.to === said.to &&
	message.text === said.text &&
	message.after === said.after &&
	sameRefs(message.refs, said.refs);

export function messageKeyConflict(key: string, message: Message): string {
	return `The key '${key}' already names a different room operation at message seq ${message.seq}.`;
}

/** Copy mutable notification values for one listener. */
export function notificationFor(event: RoomNotification): RoomNotification {
	switch (event.type) {
		case 'message':
			return { ...event, message: copyMessage(event.message) };
		case 'conflict':
			return { ...event, missed: event.missed.map(copyMessage) };
		case 'exchange_opened':
			return { ...event, exchange: { ...event.exchange } };
		case 'exchange_closed':
			return { ...event, exchange: { ...event.exchange } };
		case 'error':
			// Execution diagnostics retain their original Error object and cause.
			return { ...event };
		default:
			return { ...event };
	}
}

/** The cast as the journal holds it: every seat by name, identity, and attention. */
export function compositionOf(cast: CompositionDraft, at: string): Without<Composition, 'seq'> {
	return {
		...(cast.goal === undefined ? {} : { goal: cast.goal }),
		version: 2,
		...(cast.summary === undefined ? {} : { summary: cast.summary }),
		agents: cast.definitions
			.filter((agent) => cast.seats.has(agent.name))
			.map((agent) => {
				const seat = cast.seats.get(agent.name);
				return {
					name: agent.name,
					identity: agent.identity,
					attention: seat?.attention ?? 'broadcast',
					...(seat?.fixed === undefined ? {} : { fixed: seat.fixed }),
				};
			}),
		available: cast.definitions
			.filter((agent) => !cast.seats.has(agent.name))
			.map((agent) => ({
				name: agent.name,
				identity: agent.identity,
				attention: 'broadcast' as const,
			})),
		at,
	};
}
