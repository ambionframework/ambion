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
	type HarnessSession,
	isReturned,
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
	draftsClose,
	exchangeOutcome,
	openingQuestion,
	summaryVerdict,
	survivesCancellation,
} from './rules.verified.ts';

/**
 * The first summary on the record that covers a closed exchange for one
 * person. With a writer, only a summary by that writer counts.
 */
export function coveringSummary(
	messages: readonly Message[],
	person: string,
	range: { readonly from: Seq; readonly through: Seq },
	writer?: string,
): SummaryMessage | undefined {
	return messages.find(
		(message): message is SummaryMessage =>
			isSummary(message) &&
			(writer === undefined || message.from === writer) &&
			coversExchange(
				message.to,
				message.covers.from,
				message.covers.through,
				person,
				range.from,
				range.through,
			),
	);
}

/** The recorded response outcome, with its writer only while summary work remains owed. */
export function summaryCompletion(
	close: Pick<Close, 'owner' | 'from' | 'through' | 'summary'>,
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseHold>,
	cancelledAt?: number,
): SummaryOutcome {
	const writer = close.summary;
	// A close with no writer has no summary to publish.
	const summary =
		writer === undefined ? undefined : coveringSummary(messages, close.owner, close, writer);
	if (summary !== undefined) return { status: 'published', summary };
	const verdict = summaryVerdict(
		writer !== undefined,
		writer !== undefined && removedAfter(messages, writer, close.through),
		draftsOf(leases, close.through, writer),
		!survivesCancellation(close.through, cancelledAt),
	);
	// The rule decides. The re-test narrows the TypeScript type only.
	if (verdict.status === 'pending' && verdict.owed && writer !== undefined)
		return { status: 'pending', writer };
	if (verdict.status === 'pending') return { status: 'pending' };
	return { status: verdict.status === 'silent' ? 'silent' : 'failed' };
}

/**
 * The drafts of one close's summary: every lease of the writer's closing
 * activations at the close. The validator holds `through >= 1`. A close
 * with no writer has no drafts, and `decodeActivationId` always names a
 * seat.
 */
function draftsOf(
	leases: ReadonlyMap<string, LeaseHold>,
	through: Seq,
	writer: string | undefined,
): Draft[] {
	if (writer === undefined) return [];
	return [...leases.values()]
		.filter((lease) => {
			const parsed = decodeActivationId(lease.id);
			// A terminal lease from another seat cannot settle this close.
			return parsed !== undefined && draftsClose(parsed, through, writer);
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
		const summary = coveringSummary(pass.summaries, person, close);
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
		// The view copies a published summary, as it copies `summaries`, so it
		// shares nothing with the fold.
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
 * The `from` of the exchange an activation serves, or nothing. A closing
 * activation serves the exchange its close ended. A response activation
 * serves the exchange whose range holds the message that caused it. A
 * message outside every exchange, such as agent speech in a quiet room,
 * serves none.
 */
function servedExchange(
	source: ActivationSource,
	position: Seq,
	closes: readonly Close[],
	open: ExchangeRef | undefined,
): Seq | undefined {
	if (source === 'closed') return closes.find((close) => close.through === position)?.from;
	if (open !== undefined && position >= open.from) return open.from;
	return closes.find((close) => close.from <= position && position <= close.through)?.from;
}

/**
 * The harness session an activation resumes: the one that the latest ended
 * activation of the same seat in the same exchange recorded. The latest is
 * the one whose end entry stands highest on the journal. A harness session
 * never crosses an exchange, so the first activation of a seat in each
 * exchange starts fresh.
 */
export function exchangeSession(
	id: string,
	closes: readonly Close[],
	open: ExchangeRef | undefined,
	leases: ReadonlyMap<string, LeaseHold>,
): HarnessSession | undefined {
	const activation = seatAndExchange(id, closes, open);
	if (activation?.exchange === undefined) return undefined;
	let latest: { until: Seq; session: HarnessSession } | undefined;
	for (const lease of withSession(leases)) {
		if (latest !== undefined && lease.until <= latest.until) continue;
		const ended = seatAndExchange(lease.id, closes, open);
		if (ended?.seat === activation.seat && ended.exchange === activation.exchange) latest = lease;
	}
	return latest?.session;
}

/** The ended leases that recorded a harness session. */
function withSession(
	leases: ReadonlyMap<string, LeaseHold>,
): { id: string; until: Seq; session: HarnessSession }[] {
	return [...leases.values()].flatMap((lease) =>
		lease.phase === 'ended' && lease.session !== undefined
			? [{ id: lease.id, until: lease.until, session: lease.session }]
			: [],
	);
}

/** The seat of an activation id and the `from` of the exchange it serves, or nothing for a malformed id. */
function seatAndExchange(
	id: string,
	closes: readonly Close[],
	open: ExchangeRef | undefined,
): { seat: string; exchange: Seq | undefined } | undefined {
	const decoded = decodeActivationId(id);
	if (decoded === undefined) return undefined;
	return {
		seat: decoded.seat,
		exchange: servedExchange(decoded.source, decoded.position, closes, open),
	};
}

/**
 * The open exchange, or nothing when nobody has asked since the boundary:
 * the first question a person asked after the last close's `through`. The
 * projection keeps only the messages after the boundary.
 */
export function exchangeAfter(
	messages: readonly Message[],
	people: readonly string[],
	closedThrough: Seq,
): ExchangeRef | undefined {
	const question = openingQuestion(messages, people, closedThrough);
	if (question === undefined) return undefined;
	// The re-test narrows the TypeScript type only: the contract fixes the kind.
	if (isReturned(question)) return { owner: question.owner, from: question.seq, at: question.at };
	return isSpoken(question)
		? { owner: question.from, from: question.seq, at: question.at }
		: undefined;
}
