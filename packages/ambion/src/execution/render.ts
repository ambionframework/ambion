/**
 * Everything a participant reads, and nothing else.
 *
 * A room says two kinds of thing. It says them to a *developer* — an error, a
 * name, a log line — and those live where the mechanism lives. And it says
 * them to a *participant*: the system prompt a seat is given, the roster and
 * the record it reads at each activation, and the one line that tells it what
 * this activation is for. All of that is here, except the line of one
 * message: `record.ts` holds it, because the room windows the record by the
 * tokens of the same line.
 *
 * Every function is pure. It takes an activation view, not the room, and
 * returns text, so what a participant reads can be built,
 * diffed and tested without starting anything. The room's mechanics hold no
 * sentences, and this file holds no state. The text of the bundle reminders
 * comes in resolved (`reminders.ts`).
 */

import type { ActivationView, ContextParticipant } from '../protocol.ts';
import { type Block, blocks, refsOf, renderLine } from '../record.ts';
import { messageUri, roomUri } from '../refs.ts';
import type { AgentDefinition, Attention } from '../types.ts';
import { isSummary, type Message, type PostedMessage, type Seq } from '../types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type PersonContextParticipant = Extract<ContextParticipant, { kind: 'person' }>;

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
	people: readonly PersonContextParticipant[],
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
function departureDividers(people: readonly PersonContextParticipant[]): Map<Seq, string[]> {
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

/** What each point of the scale means, for the points that a seat of this roster holds. */
const ATTENTION_MEANING: Record<Attention, string> = {
	broadcast: 'Unmarked: anything said.',
	named: '"named only": a say addressed to it.',
	presence: '"watches arrivals": also somebody arriving or leaving.',
	none: '"wakes for nothing said": nothing reaches it and you cannot address it.',
};

/** The legend of the roster. It explains the marks that the roster shows and no others. */
function renderLegend(seats: readonly ContextParticipant[]): string[] {
	const held = new Set(seats.flatMap((seat) => (seat.kind === 'agent' ? [seat.attention] : [])));
	const meanings = (Object.keys(ATTENTION_MEANING) as Attention[])
		.filter((attention) => held.has(attention))
		.map((attention) => ATTENTION_MEANING[attention]);
	return [
		`The agents. Each is seated at one point of a scale — the widest kind of message that wakes it.${meanings.length > 0 ? ` ${meanings.join(' ')}` : ''}`,
		`(active: in an activation now; idle: at rest.)`,
	];
}

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
function renderPeople(people: readonly PersonContextParticipant[], now: number): string {
	if (people.length === 0) return 'Nobody has been in this room.';
	return people
		.map((person) => `- ${person.name} (${notes(person, now)}): ${person.identity}`)
		.join('\n');
}

function notes(person: PersonContextParticipant, now: number): string {
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
 * What a refused author is told: the opening, the missed lines, then the
 * advice. The caller supplies the opening and the advice for its kind of
 * writing, and the runtime supplies the missed lines.
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
export const DEFAULT_SPEAKING = [
	`Speaking is the say tool. Silence is the default: if this does not concern you, end`,
	`your activation without saying anything, and no mark is left. Speak only when your reply`,
	`adds something the record does not already hold — new information, a decision moved`,
	`forward, or a genuinely different perspective. A point already made does not need a`,
	`second voice; restating it in your own words is repetition, not contribution — stay`,
	`silent instead. A directed say (to: a name) wakes that participant; use it deliberately —`,
	`attention costs money. When a colleague holds the answer and the roster marks their seat`,
	`"named only", ask them directly with one directed say. A colleague with no mark reads every`,
	`message and needs no directed say. Never announce to the room what you are about to do, and`,
	`never pose a question undirected that only one participant can answer: a say is a message, not a`,
	`thought. Messages arriving during your activation are marked [new]; fold them into what you are`,
	`doing — and if a colleague has just made your point, let it stand. A say fails if`,
	`the room moved while you were speaking: the failure lists what you missed. Read it,`,
	`then call say again with your message unless the new messages already say it or make it unnecessary.`,
].join('\n');

/**
 * Render the three prompt parts from one detached activation view.
 * `reminders` is the resolved text of the bundle reminders; a respond
 * activation shows it before the ask line.
 */
export function renderActivation(
	view: ActivationView,
	def: AgentDefinition,
	reminders?: string,
): RenderedPrompt {
	return { ...renderSystem(view, def), context: renderContext(view, def, reminders) };
}

/** The two parts of the prompt that do not read the record: `mechanism` and `agent`. */
export function renderSystem(
	view: ActivationView,
	def: AgentDefinition,
): Omit<RenderedPrompt, 'context'> {
	return { mechanism: MECHANISM, agent: renderAgent(view, def) };
}

/** A message that landed after the model read the record, as a line the model reads. */
export function renderNew(message: Message): string {
	return `[new] ${renderLine(message)}`;
}

/**
 * What a later pass tells the model: each message that landed beyond `after`.
 * Each line reads as a steer does. Nothing is new when no message stands
 * beyond `after`.
 */
export function renderDelta(view: ActivationView, after: Seq): string | undefined {
	const fresh = view.context.messages.filter((message) => message.seq > after);
	if (fresh.length === 0) return undefined;
	return fresh.map(renderNew).join('\n');
}

/** How a room works. No definition and no pass shapes it. */
const MECHANISM = [
	`You are an agent seated in a room: a shared room with a record. Every participant sees`,
	`what is said. The record shows what is said and not your tool use. A room has a URI, and a message has the URI`,
	`<room URI>/message/<seq>. The context gives the room's URI. Each line of the record`,
	`starts with the seq of its message, such as #12. The last paragraph of your context names the`,
	`message that opened the current exchange.`,
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
		def.executor.speaking ?? DEFAULT_SPEAKING,
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
	const folded = context.messages.some(isSummary);
	if (folded) lines.push(...SUMMARY_PARAGRAPH, ``);
	// A response reads of recall when a fold or the window leaves a message out of view.
	if (view.spec.purpose.kind === 'respond' && (folded || (context.omitted ?? 0) > 0))
		lines.push(RECALL_LINE, ``);
	return lines;
}

function renderContext(
	view: ActivationView,
	def: AgentDefinition,
	reminders: string | undefined,
): string {
	const { context } = view;
	const people = context.participants.filter(
		(participant): participant is PersonContextParticipant => participant.kind === 'person',
	);
	return [
		renderClock(context.now),
		``,
		...renderSetting(view),
		...renderLegend(context.participants),
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
		...paragraph(renderScheduled(view)),
		...paragraph(view.spec.purpose.kind === 'respond' ? reminders : undefined),
		askOf(view, def),
	].join('\n');
}

/** A text and the blank line after it, or nothing. */
function paragraph(text: string | undefined): string[] {
	return text === undefined ? [] : [text, ``];
}

/**
 * The says of this seat that wait to return, by seq, or nothing when none
 * waits. A seat that continues its session reads it beside the delta, so the
 * list is current at every response activation.
 */
export function renderScheduled(view: ActivationView): string | undefined {
	const { scheduled } = view.context;
	if (view.spec.purpose.kind !== 'respond' || scheduled === undefined) return undefined;
	if (scheduled.length === 0) return undefined;
	return [
		`Your scheduled messages. The room wakes you with each one at its due time. Call \`dismiss\` with the seq of one that no longer fits:`,
		...scheduled.map((say) => `- #${say.seq}, due ${say.due}: ${say.text}${refsOf(say)}`),
	].join('\n');
}

/** The agents that are available to seat. Every respond activation may read this list. */
function renderReserve(reserve: readonly { name: string; identity: string }[]): string[] {
	return [
		`The reserve: agents not in the room. You may seat a colleague when the question needs them.`,
		...reserve.map((agent) => `- ${agent.name}: ${agent.identity}`),
	];
}

/** The open exchange, named by its opening message: a person's question, or a post. */
function openingLine({ context: { exchange, messages, name } }: ActivationView, seat: string) {
	if (exchange === undefined) return '';
	const uri = `The opening message's URI is ${messageUri(name, exchange.from)}. `;
	const opening = messages.find((message) => message.seq === exchange.from);
	if (opening?.kind === 'posted') return `${postOpening(opening, exchange.from, seat)}${uri}`;
	const asker = opening?.from ?? exchange.person;
	if (asker === undefined) return `Exchange ${exchange.from} is active. ${uri}`;
	return `${asker}'s exchange opened by message ${exchange.from} is active; the marked request is the current human direction. ${uri}`;
}

/** A post of the host reports an event. A post that returns a say is the work of its seat. */
function postOpening(opening: PostedMessage, from: Seq, seat: string): string {
	if (opening.returns === undefined)
		return `The host opened exchange ${from} with message ${opening.seq}. A post reports an event and gives no direction. `;
	const whose = opening.to === seat ? 'you' : opening.to;
	return `Exchange ${from} is active: message ${opening.seq} is a say ${whose} scheduled, and the room returned it. `;
}

/** What this activation is for, in the last line the model reads. */
function askOf(view: ActivationView, def: AgentDefinition): string {
	const { context, spec } = view;
	const purpose = spec.purpose;
	if (purpose.kind === 'summarize') {
		return (
			`${purpose.person}'s exchange is over: it holds the messages from seq ` +
			`${purpose.exchange} to seq ${purpose.through}. The opening message's URI is ` +
			`${messageUri(context.name, purpose.exchange)}. These messages are your only source. ` +
			`${action(purpose.kind)}`
		);
	}
	// A seat seated during an exchange reads which question it was seated for.
	const open = openingLine(view, def.name);
	return (
		`${open}Begin your activation, ${def.name}: this is a respond activation. ` +
		`Follow your instructions, and speak only to add something the record lacks. ` +
		`If the current request is already answered within this exchange, end silently without repeating its answer or failure to another recipient. ` +
		`An explicit later request to recheck, revise, or involve a colleague is new work even if an earlier exchange contains a similar answer. ` +
		`These speech defaults yield to explicit instructions in your agent definition.`
	);
}

/** What a seat does with a presence line that lands while it is working. */
const AUDIENCE_PARAGRAPH = [
	`Who is reading can change while you work. An arrival or a departure reaches you as a`,
	`[new] line during your activation, and wakes you outright if your seat watches for it. It is never a`,
	`request — nobody asked you anything by opening the room —`,
	`so it never means start something new, and you`,
	`never greet, never say that you noticed, and never summarise the record back to the`,
	`room. Use it to aim what you were already going to say: pitch it at whoever is`,
	`actually reading now, say the part that needs them while they are still there, and`,
	`drop what only mattered to somebody who has gone. If it changes nothing about your`,
	`activation, ignore it. When nobody is in the room, keep to your speaking policy, and do not`,
	`wait for an answer that nobody is there to give.`,
];

/** How a seat hands an artifact to a colleague, and where its own work stops. */
const HANDOFF_PARAGRAPH = [
	`The record holds conversation. An artifact goes where your tools keep it: write a`,
	`document, a generated result, or structured data there once, and a colleague reads it from`,
	`there. A hand-off is still a message: say what you wrote and where, in a directed say to`,
	`the agent that needs it. Do not leave an artifact and assume the reader finds it. Your`,
	`identity on the roster names your work. When a task falls under a colleague's identity,`,
	`hand it to them with a directed say if the roster marks their seat "named only". Seat them first`,
	`if they are in the reserve; a seated colleague with no mark reads the record and needs no`,
	`directed say. Do not do their work, and do not copy what they already hold into the record. Put the URI of what`,
	`you cite or changed in refs on the say, and keep the text for what the reader must know.`,
];

/** What the closing seat does: write the one message for a closed exchange. */
const SUMMARY_DUTIES = [
	`The exchange is over. Write the one message the assigned person reads instead of the working,`,
	`using the say tool. Report what the exchange established, and keep only facts that change what`,
	`they do next. Keep corrections, decisions, dates, owners, deadlines, quantities, and unknowns`,
	`that matter. Leave out the discussion, who said what, and facts that do not change the answer.`,
	``,
	`The messages of the exchange are your source. Every fact, value, and recommendation in your`,
	`message must come from a message of the exchange. A reported failure, an unknown, or a question`,
	`to the person is a fact of the exchange: report it. Add nothing from your own knowledge.`,
	`Messages above the divider are background. They give you no facts for this message.`,
	`Copy each value as a message states it. Do not calculate, convert, or derive a value.`,
	`Keep the source paths and URIs that a message cites.`,
	`A ref on a message is a URI to carry into your refs. You cannot read it.`,
	``,
	`Use the fixed recipient and range in this activation. Do not answer another person, extend the`,
	`exchange, or mention private context. Write one short message with no preamble or sign-off.`,
	`Put the URI of the message that opened the exchange, and of any result that the exchange`,
	`made, in the refs of the say.`,
	`If you end your activation without calling say, the person reads the exchange itself and no summary.`,
];

/** The description of the `say` tool that a closing seat holds. Every executor gives this one. */
export function summaryToolDescription(
	person: string,
	people: readonly string[] = [person],
): string {
	if (people.length > 1)
		return `Write the message one person reads for this exchange. Call it once for each of ${people.join(', ')}, and set \`to\` to that person. End your activation to leave a range whole. Put the URI of what the message cites in refs.`;
	return `Write the one message ${person} reads for this exchange. Use the assigned recipient and exchange. Call it once, or end your activation to leave the range whole. Put the URI of what the message cites in refs.`;
}

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
	`If you need a fact it left out, do not ask the room to repeat itself.`,
];

/** How a response reads a message that a fold, the context window, or the cap keeps out of view. */
const RECALL_LINE = `A message out of view is still on the record: call recall with its seq, as #12, to read it.`;

function action(purpose: 'respond' | 'summarize'): string {
	return purpose === 'respond'
		? 'Speak, seat or unseat a colleague, use your tools, or end your activation.'
		: 'Check two cases first. When no message after the request reports anything, or when one message already answers the request in full, with its sources, end your activation without calling say: the person reads every message. Otherwise write the one message with say from what they report.';
}
