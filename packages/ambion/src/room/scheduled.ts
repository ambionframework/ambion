/**
 * The scheduled says that wait to return, as a fold over the record.
 *
 * An agent schedules a say with the `schedule` tool: a say to itself with
 * `delaySeconds`. The say waits until the room posts it back with `returns`. An
 * unseating of its author drops it, and a cancellation drops every say
 * before it. The projection runs one step for each entry, so a replay holds
 * the same list in the same order.
 */

import type { Body } from '../journal/journal.ts';
import type { ScheduledSay, ScheduleLimits } from '../scheduling.ts';
import type { Message, MessageSnapshot, PostedMessage, Seq } from '../types.ts';
import { returnable } from './rules.verified.ts';

/** Whether a message is a returned say: a post that gives a scheduled say back to its seat. */
function returnsSay(
	message: Message,
): message is PostedMessage & { readonly returns: Seq; readonly to: string } {
	return message.kind === 'posted' && message.returns !== undefined;
}

/** Whether a message is a scheduled say. */
function isScheduled(
	message: MessageSnapshot,
): message is Extract<MessageSnapshot, { kind: 'said' }> {
	return message.kind === 'said' && message.delaySeconds !== undefined;
}

/** Whether a message changes the list: a scheduled say, a returned or dismissed say, or an unseating. */
export function changesScheduled(message: Message): boolean {
	if (isScheduled(message) || message.kind === 'unseated') return true;
	return returnsSay(message) || message.kind === 'dismissed';
}

/** The list after one message. */
export function scheduleStep(list: readonly ScheduledSay[], message: Message): ScheduledSay[] {
	if (returnsSay(message)) return list.filter((say) => say.seq !== message.returns);
	if (message.kind === 'dismissed') return list.filter((say) => say.seq !== message.message);
	if (message.kind === 'unseated') return list.filter((say) => say.seat !== message.subject);
	if (!isScheduled(message) || message.delaySeconds === undefined) return [...list];
	return [
		...list,
		{
			seq: message.seq,
			seat: message.from,
			due: new Date(Date.parse(message.at) + message.delaySeconds * 1000).toISOString(),
			text: message.text,
			...(message.refs === undefined ? {} : { refs: message.refs }),
		},
	];
}

/** When a say is due, in milliseconds on the wall clock. */
export const returnsAt = (say: ScheduledSay): number => Date.parse(say.due);

/** No bound: a room that passes no limits takes any whole number of seconds and any count. */
const UNBOUNDED: ScheduleLimits = {
	minDelaySeconds: 1,
	maxDelaySeconds: Number.POSITIVE_INFINITY,
	waiting: Number.POSITIVE_INFINITY,
};

/**
 * Why the room refuses a say with `delaySeconds`, or nothing. The say goes to its
 * author, within the bounds.
 */
export function scheduleRefusal(
	list: readonly ScheduledSay[],
	seat: string,
	intent: { to?: string; delaySeconds?: number },
	schedule: ScheduleLimits = UNBOUNDED,
): string | undefined {
	const { delaySeconds } = intent;
	if (intent.to !== seat) return `A scheduled say goes to its author. Set \`to\` to '${seat}'.`;
	if (delaySeconds === undefined || !Number.isSafeInteger(delaySeconds))
		return '`delaySeconds` is a whole number of seconds.';
	if (delaySeconds < schedule.minDelaySeconds || delaySeconds > schedule.maxDelaySeconds)
		return `\`delaySeconds\` is ${delaySeconds} seconds. This room takes from ${schedule.minDelaySeconds} to ${schedule.maxDelaySeconds} seconds.`;
	const waiting = list.filter((say) => say.seat === seat).length;
	if (waiting >= schedule.waiting)
		return `${waiting} of your says wait to return. This room holds at most ${schedule.waiting} for one seat.`;
	return undefined;
}

/**
 * The post that the room writes for one say now, or nothing: the say
 * no longer waits, or it is not `returnable`. A second write of the same
 * say finds it gone.
 */
export function returning(
	list: readonly ScheduledSay[],
	roster: readonly { readonly name: string }[],
	seq: Seq,
	now: number,
): Body<PostedMessage> | undefined {
	const say = list.find((candidate) => candidate.seq === seq);
	if (
		say === undefined ||
		!returnable(
			returnsAt(say),
			now,
			roster.some((seat) => seat.name === say.seat),
		)
	)
		return undefined;
	return {
		kind: 'posted',
		at: new Date(now).toISOString(),
		to: say.seat,
		returns: say.seq,
		text: say.text,
		...(say.refs === undefined ? {} : { refs: [...say.refs] }),
	};
}

/**
 * What a dismissal of one scheduled say does. A seat dismisses its own scheduled
 * say, and the host, with no seat, any scheduled say. A say that no longer
 * waits is `unchanged`, so a retry reads the same answer. Any other seq
 * of a seat gets a refusal.
 */
export function dismissal(
	list: readonly ScheduledSay[],
	messages: readonly MessageSnapshot[],
	seat: string | undefined,
	seq: Seq,
): 'dismiss' | 'unchanged' | string {
	const say = list.find((candidate) => candidate.seq === seq);
	if (seat === undefined) return say === undefined ? 'unchanged' : 'dismiss';
	if (say !== undefined)
		return say.seat === seat
			? 'dismiss'
			: `#${seq} is the say of '${say.seat}'. Dismiss only your own.`;
	const own = messages.some(
		(message) => message.seq === seq && isScheduled(message) && message.from === seat,
	);
	return own ? 'unchanged' : `#${seq} is not a say that you scheduled.`;
}
