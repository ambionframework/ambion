/**
 * What every mechanism of the room host shares: the state of the room each
 * one reads, and the way a decision becomes an entry on the journal.
 *
 * `RoomHost` in `room.ts` holds all state. A mechanism module exports
 * functions that take it as `RoomHostState`.
 */

import { AmbionError } from '../errors.ts';
import type { ExecutionConnector, RuntimeState } from '../host/runtime.ts';
import type { Composition } from '../journal/entries.ts';
import type { Kind, RoomJournal } from '../journal/journal.ts';
import type { AgentPort, RoomProtocol } from '../protocol.ts';
import type { RoomState } from '../room/fold.ts';
import type { VisitRuntime } from '../room/presence.ts';
import {
	type CommandFor,
	type DecidedKind,
	decide,
	type Refusal,
	type RoomDecision,
} from '../room/transition.ts';
import type { AgentDefinition, Message, RoomNotification, SaidMessage, Without } from '../types.ts';
import { copyMessage } from '../types.ts';
import type { DeliveryState } from './dispatch.ts';
import type { CompositionDraft } from './room.ts';
import type { ExchangeHandle } from './waits.ts';

/**
 * What the mechanism files read and write of the room. `RoomHost`
 * implements it, and every mechanism function takes it.
 */
export interface RoomHostState {
	readonly name: string;
	readonly runtime: RuntimeState;
	/** The configured execution owner for this room's seats. */
	readonly connector: ExecutionConnector;
	readonly journal: RoomJournal;
	/** The replay, the composition on the journal, and the first reconcile. Every operation waits here. */
	readonly ready: Promise<void>;
	/** Every definition this room can seat, by name. */
	readonly defs: ReadonlyMap<string, AgentDefinition>;
	/** The handles the host delivers through. Presence itself is a fold over the journal. */
	readonly visits: Map<string, VisitRuntime>;
	/** Each arrival that waits for a durable acknowledgement, by the name of the person. */
	readonly arrivals: Map<string, { identity: string; promise: Promise<VisitRuntime> }>;
	readonly ports: Map<string, AgentPort>;
	/** The three room calls exposed to an in-process seat. */
	readonly calls: RoomProtocol;
	/**
	 * Each caller that waits for a fact the state does not hold yet. A
	 * publication, the end of the run, and an eviction wake every one, and the
	 * wake empties the set.
	 */
	readonly waiters: Set<() => void>;
	/** When this room last sent each wake. A cache: a resumed room sends every pending wake again. */
	readonly sentAt: Map<string, number>;
	/** The delivery in flight for each due or live activation. A token fences a late reply. */
	readonly deliveryStates: Map<string, DeliveryState>;
	/** Every lease id this room has heard a change for. It says `activation_start` once. */
	readonly heardLeases: Set<string>;
	/** How many closes of the state this room has heard. It says `exchange_closed` once for each. */
	heardCloses: number;
	cancelAlarm: () => void;
	/** The reconcile in flight: the entries it writes, and whoever it wakes. A caller that asks waits for it. */
	reconciling: Promise<void>;
	/** Publications run in journal order after the confirmed entry has been folded. */
	publications: Promise<void>;
	/** A cancellation append in flight, with its key retained across uncertainty. */
	abortInFlight: Promise<void> | undefined;
	abortKey: string | undefined;
	now(): number;
	/** Every fact about the room, folded over the journal as it stands. */
	state(): RoomState;
	/** The room answers nothing more: the host stopped it, or it was dropped. */
	gone(): boolean;
	/** Dropped from memory: nothing lands, and nothing reaches a listener. */
	evicted(): boolean;
	assertRunning(): void;
	/** Free the name in the runtime, for this run alone. */
	release(): void;
	emit(event: RoomNotification): void;
	reconcile(): Promise<void>;
	sendWake(id: string, seat: string): void;
	/** Wake each caller that waits on an exchange. */
	notifyExchangeWaiters(): void;
	handleForMessage(message: Message): ExchangeHandle;
	leaveEverybody(): Promise<void>;
}

export type SubmissionResult<K extends Kind> =
	Exclude<RoomDecision<K>, { entry: unknown }> | undefined;

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
			if ('entry' in result)
				return result.entry === undefined ? { result: undefined } : { body: result.entry.body };
			return { result };
		},
	});
}

/**
 * One command, decided against the fold inside the journal's write queue and
 * appended when it proposes an entry. `key` makes the append idempotent.
 * `whileRunning` writes nothing once the room is gone; a stop leaves it off,
 * since the stop still writes its revocations and departures.
 */
export function decideAndAppend<K extends DecidedKind>(
	host: Pick<RoomHostState, 'journal' | 'state' | 'now' | 'gone'>,
	kind: K,
	command: CommandFor[K],
	options: { key?: string; whileRunning?: boolean } = {},
) {
	return submit(
		host.journal,
		kind,
		() =>
			options.whileRunning === true && host.gone()
				? { entry: undefined }
				: decide<K>(host.state(), command, host.now()),
		options.key,
	);
}

/** Convert a refused internal decision to the existing room API error. */
export function requireSubmission<K extends Kind>(
	result: { entry: unknown } | { result: SubmissionResult<K> },
): void {
	if ('result' in result && result.result !== undefined && 'refusal' in result.result)
		throw refusalError(result.result.refusal);
}

export function acceptedEntry<K extends Kind>(decision: RoomDecision<K>) {
	if ('refusal' in decision) throw refusalError(decision.refusal);
	return 'entry' in decision ? decision.entry : undefined;
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
	message: Pick<SaidMessage, 'to' | 'text' | 'refs' | 'after'>,
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
