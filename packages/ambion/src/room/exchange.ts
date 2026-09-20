/**
 * The exchange: a question, and everything the room does until it goes quiet
 * again. The room goes from idle, to active, and back to idle, and one person
 * owns what happens in between.
 *
 * This is the room's own unit of work. A configured writer may read it and
 * write one message per exchange, but it is not the last reader: a client
 * folds the working under the question it answered, and a host
 * measures what an exchange cost. So the rule lives here, on its own, and every reader takes it from the
 * same place.
 *
 * The rule, in three sentences:
 *
 * - **A person's question opens one**, when no exchange is open. Nothing else
 *   does: an agent speaking into a quiet room opens nothing, and arriving or
 *   leaving asks nobody anything.
 * - **Quiescence closes it.** The room reconciles when nothing is live, and
 *   writes a close that names the range the exchange turned out to hold.
 * - **What lands while it is open steers it and changes nothing.** Not the
 *   owner, not the range, not who the answer belongs to.
 *
 * An exchange is a fold over the journal: the first person's question after the
 * last close is the open one. A room resumed mid-exchange continues it.
 *
 * The design contract is `docs/exchange.md`.
 */

import { decodeActivationId } from '../activation-id.ts';
import type { Close } from '../journal/events.ts';
import {
	addUsage,
	type ClosedExchange,
	copyMessage,
	type ExchangeRef,
	type ExchangeView,
	isSpoken,
	isSummary,
	type Message,
	type Seq,
	type SummaryMessage,
	type SummaryOutcome,
	type Usage,
} from '../types.ts';
import { type LeaseHold, removedAfter } from './lease.ts';
import {
	coversExchange,
	type Draft,
	lastOf,
	openingQuestion,
	summaryVerdict,
	survivesCancellation,
} from './rules.verified.ts';

/** The recorded response outcome, with its writer only while summary work remains owed. */
export function summaryCompletion(
	close: Pick<Close, 'owner' | 'from' | 'through' | 'summary'>,
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseHold>,
	cancelledAt?: number,
): SummaryOutcome {
	const summary = messages.find(
		(message): message is SummaryMessage =>
			isSummary(message) &&
			message.from === close.summary &&
			coversExchange(
				message.to,
				message.covers.from,
				message.covers.through,
				close.owner,
				close.from,
				close.through,
			),
	);
	if (summary !== undefined) return { status: 'published', summary };
	const writer = close.summary;
	const verdict = summaryVerdict(
		summary !== undefined,
		writer !== undefined,
		writer !== undefined && removedAfter(messages, writer, close.through),
		draftsOf(leases, close.through, writer),
		!survivesCancellation(close.through, cancelledAt),
	);
	// The rule decides. The re-tests narrow the TypeScript type only.
	if (verdict.status === 'published' && summary !== undefined)
		return { status: 'published', summary };
	if (verdict.status === 'pending' && verdict.owed && writer !== undefined)
		return { status: 'pending', writer };
	if (verdict.status === 'pending') return { status: 'pending' };
	return { status: verdict.status === 'silent' ? 'silent' : 'failed' };
}

/** The drafts of one close's summary: every lease of the writer's closing activations at the close. */
function draftsOf(
	leases: ReadonlyMap<string, LeaseHold>,
	through: Seq,
	writer: string | undefined,
): Draft[] {
	return [...leases.values()]
		.filter((lease) => {
			const parsed = decodeActivationId(lease.id);
			// A terminal lease from another seat cannot settle this close.
			return parsed?.source === 'closed' && parsed.position === through && parsed.seat === writer;
		})
		.map((lease) =>
			lease.phase === 'running'
				? { phase: 'running' }
				: { phase: 'ended', reason: lease.reason, cancelled: lease.cancelled === true },
		);
}

/** Build one detached closed exchange view from the recorded close. */
function closedExchangeView(
	close: Close,
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseHold>,
	cancelledAt?: number,
): Extract<ExchangeView, { status: 'closed' }> {
	const usage = exchangeUsage(close.from, close.through, leases);
	return {
		...closedExchange(close, messages),
		status: 'closed',
		summary: summaryOutcome(close, messages, leases, cancelledAt),
		...(usage === undefined ? {} : { usage }),
	};
}

/**
 * The leases of the activations in an exchange range. An activation is in
 * the range when the position its id names lies in `[from, through]`. That
 * holds the respond activations the range woke and the summary activation,
 * which names `through`. Every attempt counts.
 */
function activationsInRange(
	leases: ReadonlyMap<string, LeaseHold>,
	from: Seq,
	through: Seq,
): LeaseHold[] {
	return [...leases.values()].filter((lease) => {
		const position = decodeActivationId(lease.id)?.position;
		return position !== undefined && position >= from && position <= through;
	});
}

/** The sum of what the activations in the range spent, or nothing when none recorded usage. */
function exchangeUsage(
	from: Seq,
	through: Seq,
	leases: ReadonlyMap<string, LeaseHold>,
): Usage | undefined {
	let total: Usage | undefined;
	for (const { usage } of activationsInRange(leases, from, through)) {
		if (usage === undefined) continue;
		total = addUsage(total, usage);
	}
	return total;
}

/** Select the detached closed handle shared by waits and read views. */
export function closedExchange(
	close: Pick<Close, 'owner' | 'from' | 'through' | 'at'>,
	messages: readonly Message[],
): ClosedExchange {
	return {
		owner: close.owner,
		from: close.from,
		through: close.through,
		at: messages.find((message) => message.seq === close.from)?.at ?? close.at,
	};
}

/** Select and detach the non-summary discussion for one exchange's inclusive range. */
export function discussionMessages(
	messages: readonly Message[],
	from: number,
	through: number,
): Message[] {
	return messages
		.filter((message) => message.kind !== 'summary')
		.filter((message) => message.seq >= from && message.seq <= through)
		.map(copyMessage);
}

/** Build detached exchange views in journal order, including the current open exchange. */
export function exchangeViews(
	closes: readonly Close[],
	messages: readonly Message[],
	open: ExchangeRef | undefined,
	leases: ReadonlyMap<string, LeaseHold>,
	cancelledAt?: number,
): ExchangeView[] {
	const closed = closes.map((close) => closedExchangeView(close, messages, leases, cancelledAt));
	return open === undefined ? closed : [...closed, { status: 'open', ...open }];
}

function summaryOutcome(
	close: Close,
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseHold>,
	cancelledAt?: number,
): SummaryOutcome {
	const completion = summaryCompletion(close, messages, leases, cancelledAt);
	if (completion.status === 'published')
		return { status: 'published', summary: copyMessage(completion.summary) };
	if (completion.status === 'pending')
		return completion.writer === undefined
			? { status: 'pending' }
			: { status: 'pending', writer: completion.writer };
	return { status: completion.status };
}

/**
 * The open exchange, or nothing when nobody has asked since the last close:
 * the first question a person asked after the last close's `through`.
 */
export function openExchange(
	messages: readonly Message[],
	closes: readonly Close[],
	people: readonly string[],
): ExchangeRef | undefined {
	return exchangeAfter(messages, people, lastOf(closes.map((close) => close.through)));
}

/** The open exchange over the messages after a boundary, for a projection that keeps only those. */
export function exchangeAfter(
	messages: readonly Message[],
	people: readonly string[],
	closedThrough: Seq,
): ExchangeRef | undefined {
	const question = openingQuestion(messages, people, closedThrough);
	// The re-test narrows the TypeScript type only: the contract fixes the kind.
	return question !== undefined && isSpoken(question)
		? { owner: question.from, from: question.seq, at: question.at }
		: undefined;
}
