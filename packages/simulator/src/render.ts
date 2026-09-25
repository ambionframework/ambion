/**
 * The text that an agent actor and an agent judge read. Both render from
 * values, and both are pure.
 *
 * - **The actor** reads what the person saw: the text the person sent, each
 *   spoken message with its author and recipient, and the summary.
 * - **The judge** reads the record: the goal, the person, every message in
 *   seq order, and each exchange with its range, its outcome, and its
 *   activations. It reads no move and no usage, because the reason of a
 *   `stop` can repeat the brief.
 */
import {
	type ExchangeActivation,
	type HumanDefinition,
	isReturned,
	isSpoken,
	isSummary,
	type Message,
	type RoomNotification,
} from '@ambionframework/ambion';
import type { Run, SeenExchange } from './types.ts';

/**
 * One message as one line: its place, its author, its recipient, its kind,
 * and its text as a JSON string. The quotes keep a newline in the text from
 * starting a line that reads as another message.
 */
function messageLine(message: Message): string {
	const text = JSON.stringify('text' in message ? message.text : '');
	if (isSummary(message)) {
		const { from, through } = message.covers;
		return `[${message.seq}] summary from ${message.from} to ${message.to} (covers ${from}-${through}): ${text}`;
	}
	if (isSpoken(message)) {
		return `[${message.seq}] ${message.from} to ${message.to ?? 'the room'}: ${text}`;
	}
	if (isReturned(message)) {
		return `[${message.seq}] the room returned a say to ${message.to} for ${message.owner}: ${text}`;
	}
	if (message.kind === 'dismissed') {
		return `[${message.seq}] ${message.from ?? 'the host'} dismissed say ${message.message}`;
	}
	const by =
		message.from === undefined || message.from === message.subject ? '' : ` by ${message.from}`;
	return `[${message.seq}] ${message.subject} ${message.kind}${by}`;
}

/** What the person saw in one exchange. */
function seenLines(exchange: SeenExchange, index: number): string[] {
	const lines = [`Exchange ${index + 1}. You sent: ${exchange.sent}`];
	for (const message of exchange.discussion) {
		if (isSpoken(message)) lines.push(messageLine(message));
	}
	if (exchange.summary !== undefined) lines.push(`Summary to you: ${exchange.summary.text}`);
	return lines;
}

/** The prompt of one move: every exchange so far, and the ask. */
export function actorPrompt(exchanges: readonly SeenExchange[]): string {
	if (exchanges.length === 0) return 'You have sent nothing yet. Send your first message.';
	const seen = exchanges.map((exchange, index) => seenLines(exchange, index).join('\n'));
	return `${seen.join('\n\n')}\n\nSend your next message, or stop.`;
}

/** The system prompt of the actor: the person, the brief, and the rules. */
export function actorSystem(person: HumanDefinition, brief: string): string {
	return [
		`You play ${person.name}, a person in a room of agents. ${person.identity}`,
		`Your goal, which only you know:\n${brief}`,
		[
			'Rules:',
			'- Speak as the person, in one message at a time.',
			'- Do not quote or mention your goal.',
			'- End each move with one call to `send` or to `stop`.',
		].join('\n'),
	].join('\n\n');
}

/** The tools each activation called, by activation id, in the order they started. */
function toolsByActivation(events: readonly RoomNotification[]): Map<string, string[]> {
	const tools = new Map<string, string[]>();
	for (const event of events) {
		if (event.type !== 'tool_execution_start') continue;
		tools.set(event.activation, [...(tools.get(event.activation) ?? []), event.toolName]);
	}
	return tools;
}

function activationLine(activation: ExchangeActivation, tools: readonly string[]): string {
	const { status, ...rest } = activation.outcome;
	const detail = Object.keys(rest).length === 0 ? '' : ` ${JSON.stringify(rest)}`;
	const called = tools.length === 0 ? 'no tools' : `tools ${tools.join(', ')}`;
	return `- ${activation.seat}, ${activation.purpose}, ${status}${detail}, ${called}`;
}

/** The record of a run as the judge reads it. */
export function renderRecord(run: Run): string {
	const tools = toolsByActivation(run.events);
	const lines = [
		`Goal of the room: ${run.room.goal ?? 'none stated'}`,
		`The person: ${run.person.name}. ${run.person.identity}`,
		'',
		'Messages:',
		...run.room.messages.map(messageLine),
	];
	run.exchanges.forEach((exchange, index) => {
		const { view } = exchange;
		lines.push(
			'',
			`Exchange ${index + 1}: messages ${view.from}-${view.through}, outcome ${view.outcome.kind}`,
			...view.activations.map((a) => activationLine(a, tools.get(a.id) ?? [])),
		);
	});
	return lines.join('\n');
}
