/**
 * Everything a participant reads, and nothing else.
 *
 * A room says two kinds of thing. It says them to a *developer* — an error, a
 * name, a log line — and those live where the mechanism lives. And it says
 * them to a *participant*: the system prompt a seat is given, the roster and
 * the record it reads at each activation, and the one line that tells it what
 * this activation is for. All of that is here.
 *
 * Every function is pure. It takes an activation view, not the room, and
 * returns text, so what a participant reads can be built,
 * diffed and tested without starting anything. The room's mechanics hold no
 * sentences, and this file holds no state.
 */

import type { ActivationView, ContextParticipant } from '../protocol.ts';
import { messageUri, roomUri } from '../refs.ts';
import type { AgentDefinition, Attention } from '../types.ts';
import { isSpoken, isSummary, type Message, type Seq, type SummaryMessage } from '../types.ts';
import { SUMMARY_DUTIES } from './summary.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type HumanContextParticipant = Extract<ContextParticipant, { kind: 'human' }>;

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
 *
 * A presence line names the author only where it differs from the subject. A
 * person arrives by themselves, and reading "priya arrived by priya" tells a
 * reader nothing.
 */
export function renderLine(message: Message): string {
	if (isSpoken(message) || isSummary(message)) {
		const refs = message.refs === undefined ? '' : ` (refs: ${message.refs.join(' ')})`;
		return `[${message.from}${message.to ? ` → ${message.to}` : ''}] ${message.text}${refs}`;
	}
	const by = message.from === undefined || message.from === message.subject;
	return `· ${message.subject} ${message.kind}${by ? '' : ` by ${message.from}`}`;
}

/** One block of the rendered record: a message on its own, or the run one summary stands for. */
type Block = { line: Message } | { fold: Message[]; by: SummaryMessage };

/**
 * The summary that stands for each seq one covers. A summary is never folded
 * into another one: the message that stands for a range must survive whatever
 * covers it.
 *
 * A summary keeps the fixed range of its closed exchange. A message takes
 * the summary that covers it. Messages between two ranges stay visible.
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

/** The record as blocks, with each summarised run collapsed into one. */
function blocks(record: readonly Message[]): Block[] {
	const by = foldedBy(record);
	const out: Block[] = [];
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

/** The seqs one block stands for, and the text a token estimate reads. */
function blockSeqs(block: Block): Seq[] {
	return 'fold' in block ? block.fold.map((message) => message.seq) : [block.line.seq];
}

function blockText(block: Block): string {
	return renderLine('fold' in block ? block.by : block.line);
}

/**
 * The record trimmed to a token limit: the newest blocks whose estimated
 * tokens stay within `limit`, and never fewer than one block, so an
 * activation always reads the latest exchange. The walk runs over blocks, so a
 * summarised range counts once and is never split. `pin` keeps every message at
 * or after it, which holds the open exchange whole even past the limit.
 *
 * `from` is the lowest position the window keeps. The caller pages the record
 * until `from` sits above the record it holds, or the record reaches its floor.
 */
export function windowToLimit(
	record: readonly Message[],
	estimate: (text: string) => number,
	limit: number,
	pin?: Seq,
): { from: Seq; kept: Message[] } {
	const bs = blocks(record);
	const newest = bs.at(-1);
	if (newest === undefined) return { from: 0, kept: [] };
	let cost = 0;
	let cut = newest;
	for (let index = bs.length - 1; index >= 0; index -= 1) {
		const block = bs[index];
		if (block === undefined) break;
		cost += estimate(blockText(block));
		if (cost > limit) break;
		cut = block;
	}
	let from = Math.min(...blockSeqs(cut));
	if (pin !== undefined && pin < from) from = pin;
	return { from, kept: record.filter((message) => message.seq >= from) };
}

/**
 * The record, with each line's age, and a divider where each person in the
 * room stopped reading. The divider is what lets an agent tell somebody the
 * one thing they missed without re-reading the whole room to them.
 *
 * A closing seat's summary renders as its count and the person it was
 * written for, and the summary that stands for it renders below. The record
 * keeps every message; what a seat reads is a rendering of it, built fresh at
 * each activation.
 */
export function renderRecord(
	record: readonly Message[],
	people: readonly HumanContextParticipant[],
	now: number,
	exchangeFrom?: Seq,
	omitted = 0,
): string {
	if (record.length === 0) return '(the record is empty)';
	const dividers = departureDividers(people);
	const lines: string[] =
		omitted > 0 ? [`── ${count(omitted, 'earlier message')} not shown ──`] : [];
	for (const block of blocks(record)) {
		if ('line' in block && block.line.seq === exchangeFrom)
			lines.push('── Current exchange begins here; earlier exchanges are background ──');
		lines.push(renderBlock(block, now), ...divide(block, dividers));
	}
	return lines.join('\n');
}

function renderBlock(block: Block, now: number): string {
	if ('fold' in block) {
		return `── ${count(block.fold.length, 'message')}, summarised for ${block.by.to} below ──`;
	}
	return `${renderLine(block.line)}  (${ago(block.line.at, now)})`;
}

/** A person's divider lands where they stopped reading, folded or not. */
function divide(block: Block, dividers: Map<Seq, string[]>): string[] {
	const seqs = 'fold' in block ? block.fold.map((message) => message.seq) : [block.line.seq];
	return seqs.flatMap((seq) =>
		(dividers.get(seq) ?? []).map((name) => `── ${name} has not seen anything below this line ──`),
	);
}

/** Seq to the people whose divider sits right after it. */
function departureDividers(people: readonly HumanContextParticipant[]): Map<Seq, string[]> {
	const dividers = new Map<Seq, string[]>();
	for (const person of people) {
		if (
			person.presence === 'absent' ||
			person.lastDeparture === undefined ||
			person.messagesSinceDeparture === 0
		)
			continue;
		const at = dividers.get(person.lastDeparture) ?? [];
		at.push(person.name);
		dividers.set(person.lastDeparture, at);
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

function renderAgents(seats: readonly ContextParticipant[]): string {
	const agents = seats.filter((seat) => seat.kind === 'agent');
	return agents
		.map((seat) => `- ${seat.name} (${seatNotes(seat).join(', ')}): ${seat.identity}`)
		.join('\n');
}

/** How a seat is reading, the way `notes` says how a person is reading. */
function seatNotes(seat: Extract<ContextParticipant, { kind: 'agent' }>): string[] {
	const parts: string[] = [seat.status];
	const note = ATTENTION_NOTE[seat.attention];
	if (note) parts.push(note);
	return parts;
}

/** Who the room knows, how they are reading, and what they have not read. */
function renderPeople(people: readonly HumanContextParticipant[], now: number): string {
	if (people.length === 0) return 'Nobody has been in this room.';
	return people
		.map((person) => `- ${person.name} (${notes(person, now)}): ${person.identity}`)
		.join('\n');
}

function notes(person: HumanContextParticipant, now: number): string {
	const parts: string[] = [person.presence];
	if (person.changedAt) parts.push(`since ${ago(person.changedAt, now)}`);
	if (person.messagesSinceDeparture > 0)
		parts.push(`has not seen the last ${count(person.messagesSinceDeparture, 'message')}`);
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
 * The prompt of one activation in three parts. Each part depends on one thing,
 * so an adapter can place it where it caches best.
 */
export interface RenderedPrompt {
	/** How a room works. It depends on the kernel version only. */
	readonly mechanism: string;
	/** Who the seat is and how it speaks. It depends on the definition and the purpose. */
	readonly agent: string;
	/** What this activation reads: the room, the roster, the record, and the ask line. */
	readonly context: string;
}

/**
 * The default speaking policy. An agent definition replaces it with the
 * `speaking` option of its executor.
 */
export const DEFAULT_GUIDANCE = [
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
].join('\n');

/** Render the three prompt parts from one detached activation view. */
export function renderActivation(view: ActivationView, def: AgentDefinition): RenderedPrompt {
	return {
		mechanism: MECHANISM,
		agent: renderAgent(view, def),
		context: renderTurnContext(view, def),
	};
}

/**
 * What a later pass tells the model: each message that landed beyond `since`.
 * Each line reads as a steer does. Nothing is new when no message stands
 * beyond `since`.
 */
export function renderDelta(view: ActivationView, since: Seq): string | undefined {
	const fresh = view.context.messages.filter((message) => message.seq > since);
	if (fresh.length === 0) return undefined;
	return fresh.map((message) => `[new] ${renderLine(message)}`).join('\n');
}

/** How a room works. No definition and no pass shapes it. */
const MECHANISM = [
	`You are an agent seated in a room: a shared room with a record. Every participant sees`,
	`what is said; nobody sees your tool use. A room has a URI, and a message has the URI`,
	`<room URI>/message/<seq>. The context gives the room's URI, and the ask line at its end`,
	`gives the message that opened the current exchange.`,
].join('\n');

/** The seat's identity, its policy for this purpose, and its own instructions. */
function renderAgent(view: ActivationView, def: AgentDefinition): string {
	const lines = [`You are '${def.name}'.`, ``, ...duties(view, def), ``];
	lines.push(
		`Your identity, as the room knows it: ${def.identity}`,
		``,
		`Your instructions:`,
		def.executor.instructions.trim(),
	);
	if (view.spec.purpose.kind === 'summarize') lines.push(``, ...reader(view));
	return lines.join('\n');
}

/** What this seat is for, read off the activation purpose. */
function duties(view: ActivationView, def: AgentDefinition): string[] {
	if (view.spec.purpose.kind === 'summarize') return [...SUMMARY_DUTIES];
	const lines = [
		def.executor.speaking ?? DEFAULT_GUIDANCE,
		``,
		...AUDIENCE_PARAGRAPH,
		``,
		...HANDOFF_PARAGRAPH,
	];
	if (def.executor.guidance) lines.push(``, def.executor.guidance);
	return lines;
}

/** Where the activation happens: the room, its purpose, and how to read a fold. */
function renderSetting(view: ActivationView): string[] {
	const { context } = view;
	const lines = [`The room is '${context.name}'. Its URI is ${roomUri(context.name)}.`, ``];
	if (context.goal) lines.push(`This room exists to: ${context.goal}`, ``);
	// A fold renders once the record holds a summary, so only such a record
	// tells its seat how to read one.
	if (context.messages.some(isSummary)) lines.push(...SUMMARY_PARAGRAPH, ``);
	return lines;
}

function renderTurnContext(view: ActivationView, def: AgentDefinition): string {
	const { context } = view;
	const people = context.participants.filter(
		(participant): participant is HumanContextParticipant => participant.kind === 'human',
	);
	return [
		renderClock(context.now),
		``,
		...renderSetting(view),
		`The agents. Each is seated at one point of a scale — the widest kind of message`,
		`that wakes it. Unmarked: anything said. "named only": a say addressed to it.`,
		`"watches arrivals": also somebody arriving or leaving. "wakes for nothing said":`,
		`nothing reaches it and you cannot address it. A closing assignment writes the one`,
		`message a person reads when their exchange closes.`,
		`(active: taking a turn now; idle: at rest.)`,
		renderAgents(context.participants),
		...(view.spec.purpose.kind === 'summarize' || context.reserve === undefined
			? []
			: [``, ...renderReserve(context.reserve)]),
		``,
		`The people (present: in the room now; absent: not in the room):`,
		renderPeople(people, context.now),
		``,
		`The record of '${context.name}' so far:`,
		renderRecord(
			context.messages,
			people,
			context.now,
			view.spec.purpose.kind === 'respond' ? context.exchange?.from : view.spec.purpose.exchange,
			context.omitted,
		),
		``,
		askOf(view, def),
	].join('\n');
}

/** The agents that are available to seat. Every ordinary activation may read this list. */
function renderReserve(reserve: readonly { name: string; identity: string }[]): string[] {
	return [
		`The reserve: agents not in the room. You may seat a colleague when the question needs them.`,
		...reserve.map((agent) => `- ${agent.name}: ${agent.identity}`),
	];
}

/** What this activation is for, in the last line the model reads. */
function askOf(view: ActivationView, def: AgentDefinition): string {
	const { context, spec } = view;
	const purpose = spec.purpose;
	if (purpose.kind === 'summarize') {
		return (
			`${purpose.person}'s exchange is over: it holds the messages from seq ` +
			`${purpose.exchange} to seq ${purpose.through}. The opening message's URI is ` +
			`${messageUri(context.name, purpose.exchange)}. ${action(purpose.kind)}`
		);
	}
	// A seat seated during an exchange reads which question it was seated for.
	const open = context.exchange
		? `${context.exchange.owner}'s exchange opened by message ${context.exchange.from} is active; the marked request is the current human direction. The opening message's URI is ${messageUri(context.name, context.exchange.from)}. `
		: '';
	return (
		`${open}Take your turn, ${def.name}: this is ordinary work. ` +
		`Follow your configured instructions. Unless they require otherwise, use your tools or membership operations when needed ` +
		`and speak only to add something the record lacks. ` +
		`If the current request is already answered within this exchange, end silently without repeating its answer or failure to another recipient. ` +
		`An explicit later request to recheck, revise, or involve a colleague is new work even if an earlier exchange contains a similar answer. ` +
		`A specialist result after your directed assignment is already visible to the human; do not forward it during ordinary work. ` +
		`These speech defaults yield to explicit instructions in your agent definition. ` +
		`Closing summaries require a separate closing assignment.`
	);
}

/** What a seat does with a presence line that lands while it is working. */
const AUDIENCE_PARAGRAPH = [
	`Who is reading can change while you work. An arrival or a departure reaches you as a`,
	`[new] line mid-turn, and wakes you outright if your seat watches for it. It is never a`,
	`request — nobody asked you anything by opening the room —`,
	`so it never means start something new, and you`,
	`never greet, never say that you noticed, and never summarise the record back to the`,
	`room. Use it to aim what you were already going to say: pitch it at whoever is`,
	`actually reading now, say the part that needs them while they are still there, and`,
	`drop what only mattered to somebody who has gone. If it changes nothing about your`,
	`turn, ignore it. When nobody is in the room, work for the record: state what you`,
	`decided and why, and do not wait for an answer that nobody is there to give.`,
];

/** How a seat hands an artifact to a colleague, and where its own work stops. */
const HANDOFF_PARAGRAPH = [
	`The record holds conversation. An artifact goes to the workspace: write a document or a`,
	`generated result to a file once, and put structured data in the shared database as a named`,
	`table or view. A colleague reads the file by its path and queries the table by its name, and`,
	`sqlite_master shows how a view was built. A hand-off is still a message: say what you wrote`,
	`and where, in a directed say to the agent that needs it. Do not leave a file and assume the`,
	`reader finds it. Your identity on the roster names your work. When a task falls under a`,
	`colleague's identity, hand it to them with a directed say. Seat them first if they are in`,
	`the reserve. Do not do their work, and do not copy what they already hold into the record.`,
	`Put the URI of what you cite or changed in refs on the say, and keep the text for what the`,
	`reader must know.`,
];

/**
 * Who the closing seat is writing for, and how they read. How a person reads is
 * theirs, so it reaches that seat here and no other seat reads it.
 */
function reader(view: ActivationView): string[] {
	if (view.spec.purpose.kind !== 'summarize') return [];
	const person = view.spec.purpose.person;
	const { people } = view.spec.purpose;
	const lines = [`You are writing for ${person}.`];
	if (people.length > 1)
		lines.push(
			`These people spoke in the exchange: ${people.join(', ')}. Write one message for each, and`,
			`set \`to\` to that person. This list replaces the rule to answer no other person.`,
			`The reading preferences below belong to ${person}. Keep the message for each other person plain.`,
		);
	if (view.context.preferences) lines.push(`How ${person} reads:`, view.context.preferences.trim());
	return lines;
}

/** What a seat makes of a range that has left its context. */
const SUMMARY_PARAGRAPH = [
	`Part of the record may read as "── N messages, summarised for <name> below ──". Those`,
	`messages are still on the record; what stands for them is the summary further down,`,
	`written for that person, and you read it in place of them. The line names who`,
	`it was written for, because two people's summaries may cover the same stretch. Treat a`,
	`summary as a recorded report, preserving its uncertainty and qualifications. Later corrections`,
	`or conflicting concrete evidence take precedence over a summarized claim. The summary asks`,
	`you for nothing and addresses one person, not you.`,
	`If you need a fact it left out, read it again from your own tools rather than asking the`,
	`room to repeat itself.`,
];

function action(purpose: 'respond' | 'summarize'): string {
	return purpose === 'respond'
		? 'Speak, seat or unseat a colleague, use your tools, or end your turn.'
		: 'Write the one message with say, or end your turn.';
}
