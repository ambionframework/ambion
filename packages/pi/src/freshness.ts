/**
 * What the provider received of the record, read from the exact provider
 * input.
 *
 * The executor hands the harness each range of the record as a custom
 * message of type `ambion.record`: the rendered text, and in its details the
 * position the range starts after and the position it runs through. The
 * session keeps the details on disk and in memory. The harness hook that
 * turns the session into provider messages reads the messages of each
 * request, and tells the core each range and each tool result that the
 * request holds. The core keeps the position read. A user message with the
 * same text never counts: only the custom type and its details do.
 */
import {
	contentText,
	type ExecutorActivation,
	type ReadRange,
	type Seq,
} from '@ambionframework/ambion/hosting';
import type { AgentMessage, CustomMessage } from '@earendil-works/pi-agent-core';
import { convertToLlm, createCustomMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';

/** The custom type of a range of the record in the session. */
export const RECORD = 'ambion.record';

/** The custom entry that holds the position a session read through. */
export const READ = 'ambion.read';

/** One range of the record in the session. */
interface Range extends ReadRange {
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
	return contentText(message.content);
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

/**
 * Tell the core what the messages of one provider request hold: each range
 * of the record, and each tool result. Answer the positions of the steered
 * lines the request holds.
 */
export function provided(
	messages: readonly AgentMessage[],
	activation: Pick<ExecutorActivation, 'read' | 'delivered'>,
): Seq[] {
	const steers: Seq[] = [];
	for (const message of messages) {
		const range = rangeOf(message);
		if (range !== undefined) {
			activation.read({ after: range.after, through: range.through });
			if (range.steer === true) steers.push(range.through);
		}
		if (message.role === 'toolResult') activation.delivered(message.toolCallId);
	}
	return steers;
}
