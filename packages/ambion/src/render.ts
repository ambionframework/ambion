/**
 * How a room reads. Every function here is pure: it takes what the session
 * already knows and returns text. Keeping it out of `session.ts` keeps the
 * room's mechanics and the room's prose from growing into each other.
 */
import type { AgentSeatInfo, Attention } from './types.ts';
import {
	isSpoken,
	isSummary,
	type Message,
	type PresenceStatus,
	type SeatInfo,
	type Seq,
	type SummaryMessage,
} from './types.ts';

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
	/** The name of the aide they brought, when they brought one. */
	aide?: string;
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

/**
 * One line of the record. A presence message has no text, so it reads as an
 * aside; a summary reads like anything else addressed to one person, because
 * that is what it is.
 */
export function renderLine(message: Message): string {
	if (isSpoken(message) || isSummary(message)) {
		return `[${message.from}${message.to ? ` → ${message.to}` : ''}] ${message.text}`;
	}
	return `· ${message.from} ${message.kind}`;
}

/** One rendered row: a message on its own, or the run one summary stands for. */
type Row = { line: Message } | { fold: Message[]; by: SummaryMessage };

/**
 * The summary that stands for each seq one covers. A summary is never folded
 * into another one: the message that stands for a range must survive whatever
 * covers it.
 *
 * Ranges can nest, because a race widens the range a refused draft covers. A
 * message then takes the nearest summary that stands for it — the first one
 * committed after it — so a fold never claims a summary that is not its own.
 */
function foldedBy(record: readonly Message[]): Map<Seq, SummaryMessage> {
	const summaries = record.filter(isSummary);
	const by = new Map<Seq, SummaryMessage>();
	if (summaries.length === 0) return by;
	for (const message of record) {
		if (isSummary(message)) continue;
		const stands = summaries.find(
			({ covers }) => message.seq >= covers.from && message.seq <= covers.through,
		);
		if (stands) by.set(message.seq, stands);
	}
	return by;
}

/** The record as rows, with each summarised run collapsed into one. */
function rows(record: readonly Message[]): Row[] {
	const by = foldedBy(record);
	const out: Row[] = [];
	for (const message of record) {
		const stands = by.get(message.seq);
		if (!stands) {
			out.push({ line: message });
			continue;
		}
		const last = out.at(-1);
		if (last && 'fold' in last && last.by === stands) last.fold.push(message);
		else out.push({ fold: [message], by: stands });
	}
	return out;
}

/**
 * The record, with each line's age, and a divider where each person in the
 * room stopped reading. The divider is what lets an agent tell somebody the
 * one thing they missed without re-reading the whole room to them.
 *
 * A range an aide has summarised renders as its count and the person it was
 * written for, and the summary that stands for it renders below. The record
 * keeps every message; what a seat reads is a rendering of it, built fresh at
 * each activation.
 */
export function renderRecord(
	record: readonly Message[],
	people: PersonView[],
	now: number,
): string {
	if (record.length === 0) return '(the record is empty)';
	const dividers = unseenDividers(people);
	const lines: string[] = [];
	for (const row of rows(record)) {
		lines.push(renderRow(row, now), ...divide(row, dividers));
	}
	return lines.join('\n');
}

function renderRow(row: Row, now: number): string {
	if ('fold' in row) {
		return `── ${count(row.fold.length, 'message')}, summarised for ${row.by.to} below ──`;
	}
	return `${renderLine(row.line)}  (${ago(row.line.at, now)})`;
}

/** A person's divider lands where they stopped reading, folded or not. */
function divide(row: Row, dividers: Map<Seq, string[]>): string[] {
	const seqs = 'fold' in row ? row.fold.map((message) => message.seq) : [row.line.seq];
	return seqs.flatMap((seq) =>
		(dividers.get(seq) ?? []).map((name) => `── ${name} has not seen anything below this line ──`),
	);
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

/** What each point of the attention scale is called in a roster. */
const ATTENTION_NOTE: Record<Attention, string> = {
	none: 'wakes for nothing said',
	named: 'named only',
	broadcast: '',
	presence: 'watches arrivals',
};

export function renderAgents(seats: SeatInfo[]): string {
	const agents = seats.filter((seat) => seat.kind === 'agent');
	return agents
		.map((seat) => `- ${seat.name} (${seatNotes(seat).join(', ')}): ${seat.identity}`)
		.join('\n');
}

/** How a seat is reading, the way `notes` says how a person is reading. */
function seatNotes(seat: AgentSeatInfo): string[] {
	const parts: string[] = [seat.status];
	const note = ATTENTION_NOTE[seat.attention];
	if (note) parts.push(note);
	if (seat.owner) parts.push(`writes for ${seat.owner}`);
	return parts;
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
	if (person.aide) parts.push(`brings ${person.aide}`);
	return parts.join(', ');
}

function count(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** The stamp at the top of every context: a room that never sleeps needs a clock. */
export function renderClock(now: number): string {
	return `The time is ${new Date(now).toISOString()}.`;
}
