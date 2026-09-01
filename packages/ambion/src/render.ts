/**
 * Everything a participant reads, and nothing else.
 *
 * A room says two kinds of thing. It says them to a *developer* — an error, a
 * name, a log line — and those live where the mechanism lives. And it says
 * them to a *participant*: the system prompt a seat is given, the roster and
 * the record it reads at each activation, and the one line that tells it what
 * this activation is for. All of that is here.
 *
 * Every function is pure. It takes a `RoomView` — a picture of the room, not
 * the room — and returns text, so what a participant reads can be built,
 * diffed and tested without starting anything. The room's mechanics hold no
 * sentences, and this file holds no state.
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
	/**
	 * The name of the assistant they brought. Absent after a restart, before
	 * they visit again in this run: the assistant is run state, like an exchange.
	 */
	assistant?: string;
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
 * A range an assistant has summarised renders as its count and the person it was
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

function renderAgents(seats: SeatInfo[]): string {
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
function renderPeople(people: PersonView[], now: number): string {
	if (people.length === 0) return 'Nobody has been in this room.';
	return people
		.map((person) => `- ${person.name} (${notes(person, now)}): ${person.identity}`)
		.join('\n');
}

function notes(person: PersonView, now: number): string {
	const parts: string[] = [person.presence];
	if (person.changedAt) parts.push(`since ${ago(person.changedAt, now)}`);
	if (person.unseen > 0) parts.push(`has not seen the last ${count(person.unseen, 'message')}`);
	if (person.assistant) parts.push(`brings ${person.assistant}`);
	return parts.join(', ');
}

function count(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** The stamp at the top of every context: a room that never sleeps needs a clock. */
function renderClock(now: number): string {
	return `The time is ${new Date(now).toISOString()}.`;
}

/**
 * What a refused author is told. The runtime states what it missed; the
 * sentences around that belong to the kind of writing it was doing.
 */
export function refusal(opening: string, missed: Message[], advice: string): string {
	return [opening, ...missed.map(renderLine), advice].join('\n');
}

// -- what a participant reads ------------------------------------------------

/**
 * What the prose is given of a room. It is a picture, not the room: every
 * function below reads it and returns text, so what a participant reads can be
 * built, diffed and tested without starting anything.
 */
export interface RoomView {
	readonly name: string;
	/** What the room is for, or nothing when it was started without one. */
	readonly goal: string | undefined;
	readonly seats: SeatInfo[];
	readonly people: PersonView[];
	readonly record: readonly Message[];
	/** A fold only renders once somebody has visited with their assistant, and so does the paragraph about one. */
	readonly hasAssistants: boolean;
}

/**
 * What the prose is given of the seat taking the activation. Both facts are asked
 * for outright rather than left optional: a room that stops holding one must
 * say so, instead of a missing field quietly turning an assistant into a seat.
 */
export interface SeatSpeaking {
	readonly def: { name: string; identity: string; instructions: string };
	/** The person this seat writes for, or nothing when it writes for nobody. */
	readonly owner: string | undefined;
	/** The range this activation is closing, or nothing when a message woke it. */
	readonly closing: { from: Seq; through: Seq } | undefined;
}

export function renderSystemPrompt(seat: SeatSpeaking, room: RoomView): string {
	const lines =
		seat.owner === undefined
			? [
					`You are '${seat.def.name}', an agent seated in the session '${room.name}' — a shared`,
					`room with a record. Every participant sees what is said; nobody sees your tool use.`,
					``,
				]
			: [...assistantHeader(seat.def.name, seat.owner, room.name), ``];
	if (room.goal) lines.push(`This session exists to: ${room.goal}`, ``);
	lines.push(...duties(seat, room), ``);
	lines.push(
		`Your identity, as the room knows it: ${seat.def.identity}`,
		``,
		`Your instructions:`,
		seat.def.instructions.trim(),
	);
	return lines.join('\n');
}

/** What this seat is for: an assistant writes one message, a seat speaks or does not. */
function duties(seat: SeatSpeaking, room: RoomView): string[] {
	if (seat.owner !== undefined) return ASSISTANT_PARAGRAPH;
	const lines = [
		`Speaking is the say tool. Silence is the default: if this does not concern you, end`,
		`your turn without saying anything, and no mark is left. Speak only when your reply`,
		`adds something the record does not already hold — new information, a decision moved`,
		`forward, or a genuinely different perspective. A point already made does not need a`,
		`second voice; restating it in your own words is repetition, not contribution — stay`,
		`silent instead. A directed say (to: a name) calls that agent in; use it deliberately —`,
		`attention costs money. When a colleague holds the answer, ask them directly with one`,
		`directed say — never announce to the room what you are about to do, and never pose a`,
		`question undirected that only one participant can answer: a say is a message, not a`,
		`thought. Messages arriving mid-turn are marked [new]; fold them into what you are`,
		`doing — and if a colleague has just made your point, let it stand. A say fails if`,
		`the room moved while you were speaking: the failure lists what you missed — read`,
		`it, and speak again only if your reply still adds something.`,
		``,
		...AUDIENCE_PARAGRAPH,
	];
	// A fold only renders in a room where somebody brought an assistant, so only
	// such a room tells its seats how to read one.
	if (room.hasAssistants) lines.push(``, ...SUMMARY_PARAGRAPH);
	return lines;
}

export function renderTurnContext(seat: SeatSpeaking, room: RoomView): string {
	const now = Date.now();
	const people = room.people;
	return [
		renderClock(now),
		``,
		`The agents. Each is seated at one point of a scale — the widest kind of message`,
		`that wakes it. Unmarked: anything said. "named only": a say addressed to it.`,
		`"watches arrivals": also somebody arriving or leaving. "wakes for nothing said":`,
		`nothing reaches it and you cannot address it. "writes for <name>" is that`,
		`person's assistant, which writes the one message they read when their exchange closes.`,
		`(active: taking a turn now; idle: at rest.)`,
		renderAgents(room.seats),
		``,
		`The people (present: in the room now; absent: not in the room):`,
		renderPeople(people, now),
		``,
		`The record of '${room.name}' so far:`,
		renderRecord(room.record, people, now),
		``,
		askOf(seat),
	].join('\n');
}

/** What this activation is for, in the last line the model reads. */
function askOf(seat: SeatSpeaking): string {
	const closing = seat.closing;
	if (seat.owner !== undefined) {
		// An assistant woken by anything but a close has nothing to do in the
		// activation, and no hands to do it with. See `handsFor`.
		return closing
			? `${seat.owner}'s exchange is over: messages ${closing.from} to ${closing.through}. ` +
					`Write the one message they read for it, or end your turn to leave the range whole.`
			: `Nothing is asked of you: read the room, and end your turn.`;
	}
	return `Take your turn, ${seat.def.name}: say something, or end your turn to stay silent.`;
}

/** What a seat does with a presence line that lands while it is working. */
const AUDIENCE_PARAGRAPH = [
	`Who is reading can change while you work. An arrival or a departure reaches you as a`,
	`[new] line mid-turn, and wakes you outright if your seat watches for it. It is never a`,
	`request — nobody asked you anything by opening the workspace —`,
	`so it never means start something new, and you`,
	`never greet, never say that you noticed, and never summarise the record back to the`,
	`room. Use it to aim what you were already going to say: pitch it at whoever is`,
	`actually reading now, say the part that needs them while they are still there, and`,
	`drop what only mattered to somebody who has gone. If it changes nothing about your`,
	`turn, ignore it. When nobody is in the room, work for the record: state what you`,
	`decided and why, and do not wait for an answer that nobody is there to give.`,
];

/** How a room opens the prompt it hands an assistant. */
function assistantHeader(assistant: string, person: string, room: string): string[] {
	return [
		`You are '${assistant}', ${person}'s assistant in the session '${room}' — a shared room with a`,
		`record. You are seated in it, and nothing said in it wakes you. ${person} asked a`,
		`question, the agents worked it out between them, and the room is quiet again.`,
	];
}

/** What an assistant is asked for, and the whole of what it may do. */
const ASSISTANT_PARAGRAPH = [
	`Writing is the summarise tool. Give it the one message your person reads instead of the`,
	`working: their question, answered once, for somebody who has not read a line of it.`,
	``,
	`Answer what they asked, and nothing beside it. Keep a fact only when their answer depends`,
	`on it — a quantity, a date, an owner, a deadline, or something still unknown that decides`,
	`what they do next. Keep what changed while the room worked: a correction, a decision, a`,
	`date that moved. They did not see it happen, and it is why the answer is what it is now.`,
	`Drop everything else the room raised, however true. A fact that changes nothing for them`,
	`is noise in the one message they read.`,
	``,
	`Write the shortest message that carries the answer. Do not restate their question, do not`,
	`list what the room discussed, and never say what you left out. Leave out who said what,`,
	`and in which order. Pass the message and nothing else: no preamble, no heading, no`,
	`sign-off, and never a note about how you wrote it.`,
	``,
	`Ending your turn without calling summarise leaves the range whole, and every reader still`,
	`sees all of it. Do that when there is nothing to consolidate — when what the room said`,
	`already reads as one answer, and standing between your person and it would only add a`,
	`voice. The tool fails if the room moved while you were drafting: it lists what landed,`,
	`which your message now covers as well, so write it again over the range as it now stands.`,
	``,
	`What you write is not something you said in the room. Nobody hears it, no agent wakes`,
	`because of it, and it never carries your person's name — the room stamps it as yours.`,
	`You hold their preferences; they hold the decision. You decide nothing, you act on nothing,`,
	`and you never answer in their place.`,
];

/** What a seat makes of a range that has left its context. */
const SUMMARY_PARAGRAPH = [
	`Part of the record may read as "── N messages, summarised for <name> below ──". Those`,
	`messages are still on the record; what stands for them is the summary further down,`,
	`written by that person's own assistant, and you read it in place of them. The line names who`,
	`it was written for, because two people's summaries may cover the same stretch. Treat a`,
	`summary as what happened. It asks you for nothing and it addresses one person, not you.`,
	`If you need a fact it left out, read it again from your own tools rather than asking the`,
	`room to repeat itself.`,
];
