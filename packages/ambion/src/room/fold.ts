/**
 * Every fact the log holds about the room, as a fold over its entries.
 *
 * The roster, the reserve, the people, the open exchange and the closes are
 * each one function over the entries. A room that replays the log folds
 * the same state the room that wrote it held, which is what lets a stopped
 * room say who was in it, and a run start from what its last run held.
 */

import type { LogEntry } from '../log/log.ts';
import type { Attention, Exchange, Message, Seq } from '../types.ts';
import type { CloseRow, CompositionRow, SeatRow } from '../wire.ts';
import { openExchange } from './exchange.ts';
import { foldPeople, type PersonState } from './presence.ts';

/** One agent on the roster: its name, how the room knows it, what wakes it, and whether it is the assistant. */
interface RosterSeat {
	name: string;
	identity: string;
	attention: Attention;
	assistant: boolean;
}

export interface RoomState {
	readonly composition: CompositionRow | undefined;
	readonly roster: RosterSeat[];
	readonly reserve: SeatRow[];
	readonly people: Map<string, PersonState>;
	readonly exchange: Exchange | undefined;
	readonly closes: CloseRow[];
	readonly messages: readonly Message[];
	readonly lastSeq: Seq;
}

/** The entries, sorted by kind. The latest composition stands. */
function sorted(entries: readonly LogEntry[]) {
	const messages: Message[] = [];
	const closes: CloseRow[] = [];
	let composition: CompositionRow | undefined;
	for (const entry of entries) {
		if (entry.type === 'message') messages.push(entry.message);
		else if (entry.type === 'close') closes.push(entry.close);
		else composition = entry.composition;
	}
	return { messages, closes, composition };
}

export function foldRoom(entries: readonly LogEntry[]): RoomState {
	const { messages, closes, composition } = sorted(entries);
	const people = foldPeople(messages);
	const roster = foldRoster(composition, messages);
	const isPerson = (name: string) => people.has(name);
	return {
		composition,
		roster,
		reserve:
			composition?.available.filter((seat) => !roster.some((s) => s.name === seat.name)) ?? [],
		people,
		exchange: openExchange(messages, closes, isPerson),
		closes,
		messages,
		lastSeq: messages.at(-1)?.seq ?? 0,
	};
}

/** The latest composition, then every seating and unseating after it, in order. */
function foldRoster(
	composition: CompositionRow | undefined,
	messages: readonly Message[],
): RosterSeat[] {
	if (composition === undefined) return [];
	const roster: RosterSeat[] = [
		...composition.agents.map((seat) => ({ ...seat, assistant: false })),
		{ ...composition.assistant, assistant: true },
	];
	for (const message of messages) {
		if (message.seq > composition.after) reseat(roster, message);
	}
	return roster;
}

/** One seating or unseating applied to the roster. Any other message changes nothing. */
function reseat(roster: RosterSeat[], message: Message): void {
	if (message.kind !== 'seated' && message.kind !== 'unseated') return;
	const at = roster.findIndex((seat) => seat.name === message.from);
	if (at >= 0) roster.splice(at, 1);
	if (message.kind === 'seated') {
		roster.push({
			name: message.from,
			identity: message.identity ?? '',
			attention: message.attention ?? 'broadcast',
			assistant: false,
		});
	}
}
