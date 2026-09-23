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

import { type ActivationSource, decodeActivationId } from '../activation-id.ts';
import type { Close } from '../journal/events.ts';
import {
	type ActivationOutcome,
	addUsage,
	type ClosedExchange,
	copyMessage,
	type ExchangeActivation,
	type ExchangeOutcome,
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
	exchangeOutcome,
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

/** What the outcome and the recipients of a closed exchange read besides the close itself. */
export interface OutcomeFacts {
	/** The people of the room, by name. */
	readonly people: ReadonlySet<string>;
	/** The `through` of each close a cancellation wrote. */
	readonly cancelClosed: readonly Seq[];
}

/** What one pass over the room shares among its closed exchanges. */
interface Pass extends OutcomeFacts {
	messages: readonly Message[];
	summaries: readonly SummaryMessage[];
	leases: ReadonlyMap<string, LeaseHold>;
	/** The position of the last thing each person said. */
	lastSaid: ReadonlyMap<string, Seq>;
	cancelledAt: Seq | undefined;
}

/** The position of the first message at or after `seq` in an ordered record. */
function indexAtOrAfter(messages: readonly Message[], seq: Seq): number {
	let low = 0;
	let high = messages.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((messages[middle]?.seq ?? 0) < seq) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** The messages of an inclusive range, from an ordered record. */
function rangeOf(messages: readonly Message[], from: Seq, through: Seq): Message[] {
	return messages.slice(indexAtOrAfter(messages, from), indexAtOrAfter(messages, through + 1));
}

/**
 * The people a closing activation addresses: the owner first, then every
 * other person who spoke in the range, in the order they first spoke.
 */
export function recipientsOf(
	messages: readonly Message[],
	from: Seq,
	through: Seq,
	owner: string,
	people: ReadonlySet<string>,
): string[] {
	const recipients = [owner];
	for (const message of rangeOf(messages, from, through)) {
		if (message.kind !== 'said' || !people.has(message.from)) continue;
		if (!recipients.includes(message.from)) recipients.push(message.from);
	}
	return recipients;
}

/**
 * The person the last spoken message of the range asks, when they have said
 * nothing since. The owner asked the question, so a message to the owner is
 * the answer and asks nothing.
 */
function awaitedPerson(
	owner: string,
	range: readonly Message[],
	people: ReadonlySet<string>,
	lastSaid: ReadonlyMap<string, Seq>,
): string | undefined {
	const last = range.findLast(isSpoken);
	const person = last?.to;
	if (last === undefined || person === undefined || person === owner) return undefined;
	if (!people.has(person)) return undefined;
	return (lastSaid.get(person) ?? 0) > last.seq ? undefined : person;
}

/** The outcome of one closed exchange. The rule fixes the priority; this reads the facts. */
function exchangeOutcomeOf(
	close: Close,
	range: readonly Message[],
	pass: Pass,
	exhausted: boolean,
): ExchangeOutcome {
	const person = awaitedPerson(close.owner, range, pass.people, pass.lastSaid);
	const kind = exchangeOutcome(
		pass.cancelClosed.includes(close.through),
		exhausted,
		person !== undefined,
	);
	// The rule decides. The re-test narrows the TypeScript type only.
	if (kind === 'awaiting' && person !== undefined) return { kind, person };
	return { kind: kind === 'awaiting' ? 'complete' : kind };
}

/** The summaries of a closed range, one per recipient, in recipient order. */
function summariesOf(close: Close, range: readonly Message[], pass: Pass): SummaryMessage[] {
	const recipients = recipientsOf(range, close.from, close.through, close.owner, pass.people);
	return recipients.flatMap((person) => {
		const summary = pass.summaries.find((message) =>
			coversExchange(
				message.to,
				message.covers.from,
				message.covers.through,
				person,
				close.from,
				close.through,
			),
		);
		return summary === undefined ? [] : [copyMessage(summary)];
	});
}

/** Build one detached closed exchange view from the recorded close. */
function closedExchangeView(close: Close, pass: Pass): Extract<ExchangeView, { status: 'closed' }> {
	const { usage, exhausted } = workOf(close.from, close.through, pass.leases);
	const range = rangeOf(pass.messages, close.from, close.through);
	const summaries = summariesOf(close, range, pass);
	const summary = summaryCompletion(close, pass.messages, pass.leases, pass.cancelledAt);
	return {
		...closedExchange(close, pass.messages),
		status: 'closed',
		activations: activationsInRange(pass.leases, close.from, close.through).map(({ lease }) =>
			exchangeActivation(lease),
		),
		// A published summary is copied, as `summaries` is, so the view shares nothing with the fold.
		summary:
			summary.status === 'published'
				? { status: 'published', summary: copyMessage(summary.summary) }
				: summary,
		outcome: exchangeOutcomeOf(close, range, pass, exhausted),
		...(summaries.length === 0 ? {} : { summaries }),
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
): { lease: LeaseHold; source: ActivationSource }[] {
	return [...leases.values()].flatMap((lease) => {
		const parsed = decodeActivationId(lease.id);
		const inRange = parsed !== undefined && parsed.position >= from && parsed.position <= through;
		return inRange ? [{ lease, source: parsed.source }] : [];
	});
}

/** What a lease says about how its activation stands. */
function outcomeOf(lease: LeaseHold): ActivationOutcome {
	if (lease.phase === 'running') return { status: 'running' };
	return {
		status: lease.reason,
		...(lease.cancelled === true ? { cancelled: true as const } : {}),
		...(lease.cause === undefined ? {} : { cause: lease.cause }),
	};
}

/** Map one lease to the activation the exchange read lists. */
export function exchangeActivation(lease: LeaseHold): ExchangeActivation {
	const id = decodeActivationId(lease.id);
	if (id === undefined) throw new Error(`Malformed activation id '${lease.id}'.`);
	return {
		id: lease.id,
		seat: id.seat,
		attempt: id.attempt,
		purpose: id.source === 'closed' ? 'summary' : 'respond',
		outcome: outcomeOf(lease),
		...(lease.usage === undefined ? {} : { usage: { ...lease.usage } }),
		...(lease.session === undefined ? {} : { session: { ...lease.session } }),
	};
}

/**
 * What the activations in the range spent, or nothing when none recorded
 * usage, and whether the room gave up on a response activation.
 */
function workOf(
	from: Seq,
	through: Seq,
	leases: ReadonlyMap<string, LeaseHold>,
): { usage: Usage | undefined; exhausted: boolean } {
	let usage: Usage | undefined;
	let exhausted = false;
	for (const { lease, source } of activationsInRange(leases, from, through)) {
		if (lease.usage !== undefined) usage = addUsage(usage, lease.usage);
		if (source === 'message' && lease.phase === 'ended' && lease.reason === 'abandoned')
			exhausted = true;
	}
	return { usage, exhausted };
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

/** The position of the last thing each person said. */
function lastSaidBy(messages: readonly Message[], people: ReadonlySet<string>): Map<string, Seq> {
	const last = new Map<string, Seq>();
	for (const message of messages) {
		if (message.kind === 'said' && people.has(message.from)) last.set(message.from, message.seq);
	}
	return last;
}

/** Build detached exchange views in journal order, including the current open exchange. */
export function exchangeViews(
	closes: readonly Close[],
	messages: readonly Message[],
	open: ExchangeRef | undefined,
	leases: ReadonlyMap<string, LeaseHold>,
	cancelledAt: number | undefined,
	facts: OutcomeFacts,
): ExchangeView[] {
	const pass: Pass = {
		...facts,
		messages,
		summaries: messages.filter(isSummary),
		leases,
		lastSaid: lastSaidBy(messages, facts.people),
		cancelledAt,
	};
	const closed = closes.map((close) => closedExchangeView(close, pass));
	if (open === undefined) return closed;
	const activations = [...leases.values()]
		.filter((lease) => (decodeActivationId(lease.id)?.position ?? 0) >= open.from)
		.map(exchangeActivation);
	return [...closed, { status: 'open', ...open, activations }];
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
