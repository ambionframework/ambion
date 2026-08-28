/**
 * How a room reads. Every function here is pure: it takes what the session
 * already knows and returns text. Keeping it out of `session.ts` keeps the
 * room's mechanics and the room's prose from growing into each other.
 */
import type { Message, PresenceStatus, SeatInfo, Seq } from './types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** What an agent needs to know about one person, at one activation. */
export interface PersonView {
	name: string;
	identity: string;
	presence: PresenceStatus;
	/** When their presence last changed, ISO. Absent before their first visit. */
	changedAt?: string;
	/** Where they stopped reading, and how much has landed since. */
	since: Seq | undefined;
	unseen: number;
}

/** A gap a person can read, not a duration a machine can parse. */
function ago(at: string, now: number): string {
	const elapsed = now - Date.parse(at);
	if (!Number.isFinite(elapsed) || elapsed < MINUTE) return 'just now';
	if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute');
	if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour');
	return plural(Math.floor(elapsed / DAY), 'day');
}

function plural(n: number, unit: string): string {
	return `${count(n, unit)} ago`;
}

/** One line of the record. A presence message has no text, so it reads as an aside. */
export function renderLine(message: Message): string {
	if (message.kind === 'said') {
		return `[${message.from}${message.to ? ` → ${message.to}` : ''}] ${message.text}`;
	}
	return `· ${message.from} ${verb(message.kind)}`;
}

function verb(kind: Exclude<Message['kind'], 'said'>): string {
	if (kind === 'arrived') return 'arrived';
	if (kind === 'left') return 'left';
	if (kind === 'away') return 'stopped reading';
	return 'started reading again';
}

/**
 * The record, with each line's age, and a divider where each person in the
 * room stopped reading. The divider is what lets an agent tell somebody the
 * one thing they missed without re-reading the whole room to them.
 */
export function renderRecord(
	record: readonly Message[],
	people: PersonView[],
	now: number,
): string {
	if (record.length === 0) return '(the record is empty)';
	const dividers = unseenDividers(people);
	const lines: string[] = [];
	for (const message of record) {
		lines.push(`${renderLine(message)}  (${ago(message.at, now)})`);
		for (const name of dividers.get(message.seq) ?? []) {
			lines.push(`── ${name} has not seen anything below this line ──`);
		}
	}
	return lines.join('\n');
}

/** Seq to the people whose divider sits right after it. */
function unseenDividers(people: PersonView[]): Map<Seq, string[]> {
	const dividers = new Map<Seq, string[]>();
	for (const person of people) {
		if (person.presence === 'absent' || person.since === undefined || person.unseen === 0) continue;
		const at = dividers.get(person.since) ?? [];
		at.push(person.name);
		dividers.set(person.since, at);
	}
	return dividers;
}

const ATTENTION_NOTE: Record<string, string> = {
	named: 'named only',
	presence: 'watches arrivals',
};

export function renderAgents(seats: SeatInfo[]): string {
	const agents = seats.filter((seat) => seat.kind === 'agent');
	return agents
		.map((seat) => {
			const note = ATTENTION_NOTE[seat.attention];
			return `- ${seat.name} (${seat.status}${note ? `, ${note}` : ''}): ${seat.identity}`;
		})
		.join('\n');
}

/** Who the room knows, how they are reading, and what they have not read. */
export function renderPeople(people: PersonView[], now: number): string {
	if (people.length === 0) return 'Nobody has been in this room.';
	return people
		.map((person) => `- ${person.name} (${notes(person, now)}): ${person.identity}`)
		.join('\n');
}

function notes(person: PersonView, now: number): string {
	const parts: string[] = [person.presence];
	if (person.changedAt) parts.push(`since ${ago(person.changedAt, now)}`);
	if (person.unseen > 0) parts.push(`has not seen the last ${count(person.unseen, 'message')}`);
	return parts.join(', ');
}

function count(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** The stamp at the top of every context: a room that never sleeps needs a clock. */
export function renderClock(now: number): string {
	return `The time is ${new Date(now).toISOString()}.`;
}
