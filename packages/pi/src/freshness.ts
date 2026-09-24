/**
 * What the provider received of the record, read from the exact provider
 * input.
 *
 * The executor hands the harness each range of the record as a custom
 * message of type `ambion.record`: the rendered text, and in its details the
 * position the range starts after and the position it runs through. The
 * session keeps the details on disk and in memory. The harness hook that
 * turns the session into provider messages hands `Freshness` the messages of
 * each request. A range counts as read when a request holds it and it joins
 * the position already read. A user message with the same text never
 * counts: only the custom type and its details do.
 */
import type { Seq } from '@ambionframework/ambion/hosting';
import type { AgentMessage, CustomMessage } from '@earendil-works/pi-agent-core';
import { convertToLlm, createCustomMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';

/** The custom type of a range of the record in the session. */
export const RECORD = 'ambion.record';

/** The custom entry that holds the position a session read through. */
export const READ = 'ambion.read';

/** One range of the record: after `after`, through `through`. */
interface Range {
	readonly after: Seq;
	readonly through: Seq;
	/** Set on a line steered into a live run. */
	readonly steer?: true;
}

/** A range of the record as a custom message the session keeps. */
export function recordMessage(range: Range, text: string, timestamp: number): CustomMessage<Range> {
	return createCustomMessage(RECORD, text, false, range, timestamp) as CustomMessage<Range>;
}

const isPosition = (value: unknown): value is Seq =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The range a message carries, when it is a range of the record. */
function rangeOf(message: AgentMessage): Range | undefined {
	if (message.role !== 'custom' || message.customType !== RECORD) return undefined;
	const details = message.details as Partial<Record<keyof Range, unknown>> | undefined;
	if (!isPosition(details?.after) || !isPosition(details?.through)) return undefined;
	return {
		after: details.after,
		through: details.through,
		...(details.steer === true ? { steer: true } : {}),
	};
}

/** The text of a custom message. */
function textOf(message: CustomMessage): string {
	if (typeof message.content === 'string') return message.content;
	return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * The provider messages of one request. A range of the record reaches the
 * provider as a user message with plain text. Every other message converts
 * as Pi converts it.
 */
export function providerMessages(messages: AgentMessage[]): Message[] {
	return messages.flatMap((message): Message[] =>
		rangeOf(message) !== undefined && message.role === 'custom'
			? [{ role: 'user', content: textOf(message), timestamp: message.timestamp }]
			: convertToLlm([message]),
	);
}

/** The position one activation read through, from what reached the provider. */
export class Freshness {
	private read: Seq;
	/** Ranges a request held that do not yet join the position read. */
	private readonly consumed = new Map<Seq, Range>();
	/** Tool results that carry record, by call id. */
	private readonly toolResults = new Map<string, Seq>();

	constructor(base: Seq = 0) {
		this.read = base;
	}

	get readThrough(): Seq {
		return this.read;
	}

	/** Something other than provider input confirmed the record through `seq`. */
	acknowledgeThrough(seq: Seq): void {
		this.read = Math.max(this.read, seq);
	}

	/** The result of the tool call `callId` carries the record through `seq`. */
	toolResultExpected(callId: string, seq: Seq): void {
		this.toolResults.set(callId, seq);
	}

	/**
	 * Read the messages of one provider request. Answer the positions of the
	 * steered lines the request holds.
	 */
	provided(messages: readonly AgentMessage[]): Seq[] {
		const steers: Seq[] = [];
		for (const message of messages) {
			const range = rangeOf(message);
			if (range !== undefined) this.rangeProvided(range, steers);
			if (message.role === 'toolResult') this.resultProvided(message.toolCallId);
		}
		this.join();
		return steers;
	}

	/** Hold a range a request held. A range at or below the position read adds nothing. */
	private rangeProvided(range: Range, steers: Seq[]): void {
		if (range.through > this.read) this.consumed.set(range.through, range);
		if (range.steer === true) steers.push(range.through);
	}

	private resultProvided(callId: string): void {
		const through = this.toolResults.get(callId);
		if (through === undefined) return;
		this.acknowledgeThrough(through);
		this.toolResults.delete(callId);
	}

	/** Advance through every held range that joins the position read, lowest first. */
	private join(): void {
		for (;;) {
			const next = [...this.consumed.values()]
				.filter((range) => range.after <= this.read && range.through > this.read)
				.sort((left, right) => left.through - right.through)[0];
			if (next === undefined) return;
			this.read = next.through;
			this.consumed.delete(next.through);
		}
	}
}
