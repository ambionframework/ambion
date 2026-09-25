/**
 * The scheduled says that wait to return, as a fold over the record.
 *
 * An agent schedules a say when it says to itself with `after`. The say
 * waits until the room writes a `returned` entry for it. An unseating of its
 * author drops it, and a cancellation drops every say before it. The fold
 * and the projection run the same step, so both hold the same list in the
 * same order.
 */

import type { Body } from '../journal/journal.ts';
import type { PendingSay, ScheduleLimits } from '../scheduling.ts';
import type { ExchangeRef, Message, ReturnedMessage, Seq } from '../types.ts';
import { survivesCancellation } from './rules.verified.ts';

/** One say that waits to return to its author. */
export interface ScheduledSay {
	/** The seq of the say. */
	readonly seq: Seq;
	/** The seat that said it, and the seat it returns to. */
	readonly seat: string;
	/** The owner of the exchange that the say landed in, as the room stamped it. */
	readonly owner: string;
	/** When the say is due, in milliseconds on the wall clock. */
	readonly dueAt: number;
	readonly text: string;
	readonly refs?: readonly string[];
}

/** Whether a message is a scheduled say. */
function isScheduled(message: Message): message is Extract<Message, { kind: 'said' }> {
	return message.kind === 'said' && message.after !== undefined;
}

/** Whether a message changes the list: a scheduled say, a returned or dismissed say, or an unseating. */
export function changesScheduled(message: Message): boolean {
	if (isScheduled(message) || message.kind === 'unseated') return true;
	return message.kind === 'returned' || message.kind === 'dismissed';
}

/** The list after one message. */
export function scheduleStep(list: readonly ScheduledSay[], message: Message): ScheduledSay[] {
	if (message.kind === 'returned' || message.kind === 'dismissed')
		return list.filter((say) => say.seq !== message.message);
	if (message.kind === 'unseated') return list.filter((say) => say.seat !== message.subject);
	if (!isScheduled(message) || message.after === undefined || message.owner === undefined)
		return [...list];
	return [
		...list,
		{
			seq: message.seq,
			seat: message.from,
			owner: message.owner,
			dueAt: Date.parse(message.at) + message.after * 1000,
			text: message.text,
			...(message.refs === undefined ? {} : { refs: message.refs }),
		},
	];
}

/** A pending say as a read and a view show it: its due time as ISO, and a copy of its refs. */
export function pendingSay({ dueAt, refs, ...say }: ScheduledSay): PendingSay {
	return {
		...say,
		due: new Date(dueAt).toISOString(),
		...(refs === undefined ? {} : { refs: [...refs] }),
	};
}

/** The says that a cancellation leaves: the ones after it. */
export function afterCancellation(
	list: readonly ScheduledSay[],
	cancelledAt: Seq | undefined,
): ScheduledSay[] {
	return list.filter((say) => survivesCancellation(say.seq, cancelledAt));
}

/** The says that wait to return, folded over the whole record. */
export function foldScheduled(
	messages: readonly Message[],
	cancelledAt: Seq | undefined,
): ScheduledSay[] {
	let list: ScheduledSay[] = [];
	for (const message of messages) {
		if (changesScheduled(message)) list = scheduleStep(list, message);
	}
	return afterCancellation(list, cancelledAt);
}

/** No bound: a room that passes no limits takes any whole number of seconds and any count. */
const UNBOUNDED: ScheduleLimits = {
	minAfter: 1,
	maxAfter: Number.POSITIVE_INFINITY,
	pending: Number.POSITIVE_INFINITY,
};

/**
 * Why the room refuses a say with `after`, or nothing. The say goes to its
 * author, while an exchange is open, within the bounds. The open exchange
 * names the person the say returns for.
 */
export function scheduleRefusal(
	open: ExchangeRef | undefined,
	list: readonly ScheduledSay[],
	seat: string,
	intent: { to?: string; after?: number },
	schedule: ScheduleLimits = UNBOUNDED,
): string | undefined {
	const { after } = intent;
	if (intent.to !== seat) return `A say with \`after\` goes to yourself. Set \`to\` to '${seat}'.`;
	if (after === undefined || !Number.isSafeInteger(after))
		return '`after` is a whole number of seconds.';
	if (after < schedule.minAfter || after > schedule.maxAfter)
		return `\`after\` is ${after} seconds. This room takes from ${schedule.minAfter} to ${schedule.maxAfter} seconds.`;
	if (open === undefined)
		return 'No exchange is open, so no person owns the work. Schedule a say while you answer a question.';
	const waiting = list.filter((say) => say.seat === seat).length;
	if (waiting >= schedule.pending)
		return `${waiting} of your says wait to return. This room holds at most ${schedule.pending} for one seat.`;
	return undefined;
}

/** A scheduled say returns for the owner of the open exchange, which its refusal requires. */
export const ownerOf = (intent: { after?: number }, open: ExchangeRef | undefined) =>
	intent.after === undefined || open === undefined ? {} : { owner: open.owner };

/** The entry that gives a scheduled say back to its author. */
export function returnedBody(say: ScheduledSay, now: number): Body<ReturnedMessage> {
	return {
		kind: 'returned',
		at: new Date(now).toISOString(),
		to: say.seat,
		message: say.seq,
		owner: say.owner,
		text: say.text,
		...(say.refs === undefined ? {} : { refs: [...say.refs] }),
	};
}

/**
 * The returned entry the room writes for one say now, or nothing: the say
 * no longer waits, is not due, or its seat is not on the roster. A second
 * write of the same say finds it gone.
 */
export function returning(
	list: readonly ScheduledSay[],
	roster: readonly { readonly name: string }[],
	seq: Seq,
	now: number,
): Body<ReturnedMessage> | undefined {
	const say = list.find((candidate) => candidate.seq === seq);
	if (say === undefined || say.dueAt > now) return undefined;
	return roster.some((seat) => seat.name === say.seat) ? returnedBody(say, now) : undefined;
}

/**
 * What a dismissal of one handle does. A seat dismisses its own pending
 * say, and the host, with no seat, any pending say. A say that no longer
 * waits is `unchanged`, so a retry reads the same answer. Any other handle
 * of a seat gets a refusal.
 */
export function dismissal(
	list: readonly ScheduledSay[],
	messages: readonly Message[],
	seat: string | undefined,
	seq: Seq,
): 'dismiss' | 'unchanged' | string {
	const say = list.find((candidate) => candidate.seq === seq);
	if (seat === undefined) return say === undefined ? 'unchanged' : 'dismiss';
	if (say !== undefined)
		return say.seat === seat
			? 'dismiss'
			: `Say ${seq} is the say of '${say.seat}'. Dismiss only your own.`;
	const own = messages.some(
		(message) => message.seq === seq && isScheduled(message) && message.from === seat,
	);
	return own ? 'unchanged' : `${seq} is not the handle of a say that you scheduled.`;
}
