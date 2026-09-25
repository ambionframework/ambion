/**
 * The room's own commit machinery: the reconcile loop and its alarm, the
 * cancellation, the shutdown, and the writes a seat asks for. Each write
 * decides where it lands, so a write that loses a race becomes nothing.
 */

import { decodeActivationId } from '../activation-id.ts';
import { AmbionError } from '../errors.ts';
import type { Close } from '../journal/events.ts';
import { placed, spaced } from '../journal/journal.ts';
import type { CommitRequest, CommitResult, LeaseResponse } from '../protocol.ts';
import { liveWork } from '../room/reconcile.ts';
import {
	decide,
	type ReconcileDecision,
	type Refusal,
	stopWork as stopWorkDecision,
} from '../room/transition.ts';
import type { EndReason, FailureCause, Intent, Message, Seq } from '../types.ts';
import { copyMessage, type HarnessSession, type Usage } from '../types.ts';
import {
	messageKeyConflict,
	type RoomBase,
	refusalError,
	requireSubmission,
	saidContentMatches,
	sameRefs,
	submit,
} from './core.ts';

/** How many times one pass folds, decides and writes before it yields. */
const PASSES_PER_RECONCILE = 8;

/** What the reconcile loop and the seat writes need of the room. */
export interface ControlHost extends RoomBase {
	/** When this room last sent each wake. A cache: a resumed room sends every pending wake again. */
	readonly sentAt: Map<string, number>;
	cancelAlarm: () => void;
	/** The reconcile in flight: the entries it writes, and whoever it wakes. A caller that asks waits for it. */
	reconciling: Promise<void>;
	/** A cancellation append in flight, with its key retained across uncertainty. */
	abortInFlight: Promise<void> | undefined;
	abortKey: string | undefined;
	evicted(): boolean;
	/** Free the name in the runtime. */
	release(): void;
	assertRunning(): void;
	sendWake(id: string, seat: string): void;
	notifyExchangeWaiters(): void;
	rejectExchangeWaiters(error: Error): void;
	leaveEverybody(): Promise<void>;
}

/** Whether a stored message is the room operation that a seating or a dismissal names. */
function operationMatches(intent: Exclude<Intent, { kind: 'said' }>, message: Message): boolean {
	if (intent.kind === 'dismissed')
		return message.kind === 'dismissed' && message.message === intent.message;
	return message.kind === intent.kind && message.subject === intent.name;
}

function contributionMatches(commit: CommitRequest, message: Message): boolean {
	const { activation, intent } = commit;
	// This activation check is the primary guard. It pins the returned entry to
	// this activation, so the later branches compare content within one
	// activation only. The summary branch relies on it: it accepts any recorded
	// recipient when the intent omits one, which is safe only because the
	// activation already matches. Do not loosen this check without tightening
	// that branch.
	if (message.activationId !== activation) return false;
	const parsed = decodeActivationId(activation);
	if (parsed !== undefined && message.from !== parsed.seat) return false;

	if (intent.kind !== 'said') return operationMatches(intent, message);
	if (message.kind === 'said') return saidContentMatches(message, intent);
	// A closing agent says through the same `said` intent, but the room records
	// its contribution as a summary addressed to the exchange owner. An omitted
	// recipient is that canonical owner; a supplied recipient must still match.
	return (
		message.kind === 'summary' &&
		(intent.to === undefined || message.to === intent.to) &&
		message.text === intent.text &&
		sameRefs(message.refs, intent.refs)
	);
}

// -- seat writes ------------------------------------------------------------

/** One operation on the room's commit queue, with the wakes the room routes. */
export async function writeCommit(
	host: ControlHost,
	commit: CommitRequest,
): Promise<CommitResult | { refusal: Refusal }> {
	const appended = await submit(
		host.journal,
		'message',
		() =>
			decide(
				host.state(),
				{
					type: 'commit',
					commit,
					bytes: host.runtime.limits.message.bytes,
					schedule: host.runtime.limits.schedule,
				},
				host.now(),
			),
		spaced('commit', commit.key),
	);
	if ('entry' in appended) {
		const message = placed(appended.entry);
		if (!contributionMatches(commit, message))
			return {
				refusal: {
					category: 'refused',
					reason: messageKeyConflict(commit.key, message),
				},
			};
		return { committed: copyMessage(message) };
	}
	if (appended.result === undefined) throw new Error('The commit did not propose a message.');
	return appended.result;
}

export async function hold(
	host: ControlHost,
	id: string,
	type: 'claim' | 'renew',
	readThrough?: Seq,
): Promise<LeaseResponse> {
	const written = await submit(host.journal, 'lease', () => {
		if (host.gone()) return { event: undefined };
		const lease = host.runtime.limits.lease;
		const decision = decide(
			host.state(),
			{
				type,
				id,
				expiry: lease.ttl,
				deadline: lease.deadline,
				...(readThrough === undefined ? {} : { readThrough }),
			},
			host.now(),
		);
		if (!('event' in decision) || decision.event?.body.phase !== 'running')
			return { event: undefined };
		return decision;
	});
	requireSubmission(written);
	return 'entry' in written && written.entry.body.phase === 'running'
		? { ok: { expiresAt: written.entry.body.expiresAt, lastSeq: host.state().lastSeq } }
		: { stale: 'the lease ended' };
}

/**
 * End one lease, for whatever reason. Nothing to end is not an error. A
 * revocation may name an activation that never claimed: the change ends it
 * before it starts, and the wake or the draft it stood for is answered.
 * An abandonment names an activation that never claimed and nothing else:
 * a lease that started ends how it went.
 * An expiry is judged where the change is written: a renewal that landed
 * ahead of it keeps the lease, and nothing is written. The change says
 * how the activation went, and `heardLease` says so once.
 */
export async function end(
	host: ControlHost,
	id: string,
	reason: EndReason,
	readThrough: Seq,
	cause?: FailureCause,
	usage?: Usage,
	session?: HarnessSession,
): Promise<boolean | { refusal: Refusal }> {
	const appended = await submit(host.journal, 'lease', () =>
		decide(
			host.state(),
			{
				type: 'end',
				id,
				reason,
				readThrough,
				...(cause === undefined ? {} : { cause }),
				...(usage === undefined ? {} : { usage }),
				...(session === undefined ? {} : { session }),
			},
			host.now(),
		),
	);
	if ('entry' in appended) return true;
	if (appended.result !== undefined && 'refusal' in appended.result)
		return { refusal: appended.result.refusal };
	return false;
}

// -- reconcile ----------------------------------------------------------------

export function reconcile(host: ControlHost): Promise<void> {
	host.reconciling = host.reconciling.then(() => reconcileOnce(host)).catch(() => {});
	return host.reconciling;
}

/**
 * Fold, decide, write, send, until a decision writes nothing. Every write
 * checks the fold again where it lands, so a lease that arrives between
 * the decision and the write turns the write into nothing. A write the
 * storage refuses ends the pass: whoever waits still hears the room, and
 * the room looks again after the resend window, when the storage may be
 * back and what it decided is still on the fold.
 */
async function reconcileOnce(host: ControlHost): Promise<void> {
	await host.journal.ready;
	for (let pass = 0; pass < PASSES_PER_RECONCILE && !host.gone(); pass += 1) {
		if (await onePass(host)) return;
	}
	// A pass that kept writing yields, and the room looks again after the resend window.
	if (!host.gone()) arm(host, host.now() + host.runtime.limits.delivery.resend);
}

/**
 * One pass: decide, apply, and arm the clock where the room stops. True
 * where the room has nothing more to write, and the caller stops looking.
 */
async function onePass(host: ControlHost): Promise<boolean> {
	const decision = decide(
		host.state(),
		{
			type: 'reconcile',
			options: {
				resend: host.runtime.limits.delivery.resend,
				attempts: host.runtime.limits.activation.attempts,
				sent: host.sentAt,
				stopped: host.gone(),
			},
		},
		host.now(),
	);
	let changed: boolean;
	try {
		changed = await apply(host, decision);
	} catch {
		host.notifyExchangeWaiters();
		// A write that failed because the room is gone arms nothing.
		if (!host.gone()) arm(host, host.now() + host.runtime.limits.delivery.resend);
		return true;
	}
	if (changed) return false;
	// Whoever waits hears it once the room has nothing more to write: a
	// pass that expired a lease is followed by the pass that closes.
	host.notifyExchangeWaiters();
	arm(host, decision.effects.alarmAt);
	return true;
}

/** Write what the decision wrote, send what it sent. True when anything changed. */
async function apply(host: ControlHost, decision: ReconcileDecision): Promise<boolean> {
	// A wake the fold no longer says is due is not one this room waits on.
	for (const id of decision.effects.forget) host.sentAt.delete(id);
	let changed = false;
	// The decision says how each lease ends: expired first, then given up on.
	for (const event of decision.events) {
		// A room that went away mid-pass writes nothing more of what it decided.
		if (host.gone()) return changed;
		changed = (await applyEvent(host, event)) || changed;
	}
	for (const send of decision.effects.sends) host.sendWake(send.id, send.seat);
	return changed || decision.effects.sends.length > 0;
}

function applyEvent(
	host: ControlHost,
	event: ReconcileDecision['events'][number],
): Promise<boolean> {
	if (event.kind === 'lease' && event.body.phase === 'ended')
		return end(
			host,
			event.body.id,
			event.body.reason,
			event.body.readThrough,
			event.body.cause,
			event.body.usage,
			event.body.session,
		).then((result) => {
			return requireEnd(result);
		});
	if (event.kind === 'message' && event.body.kind === 'returned')
		return returnSay(host, event.body.message);
	return event.kind === 'close' ? closeExchange(host, event.body) : Promise.resolve(false);
}

/**
 * The room gives one scheduled say back to its author. The write decides
 * again inside the journal queue, so a say that another write returned
 * first writes nothing, and the fence refuses a run that lost the room.
 */
async function returnSay(host: ControlHost, seq: Seq): Promise<boolean> {
	const written = await submit(host.journal, 'message', () => {
		if (host.gone()) return { event: undefined };
		return decide(host.state(), { type: 'return', message: seq }, host.now());
	});
	requireSubmission(written);
	return 'entry' in written;
}

function requireEnd(result: boolean | { refusal: Refusal }): boolean {
	if (typeof result === 'boolean') return result;
	throw refusalError(result.refusal);
}

/**
 * The room completed an exchange, so that exchange ends at the record
 * as the decision saw it: the close is an entry on the journal, written where the
 * fold still says the same exchange is open. The queued close publication says so, and
 * opens the next exchange when a question landed after the decision; the
 * next pass closes that one at once when nobody works on it.
 */
async function closeExchange(host: ControlHost, close: Close): Promise<boolean> {
	const written = await submit(host.journal, 'close', () => {
		if (host.gone()) return { event: undefined };
		return decide(host.state(), { type: 'close', close }, host.now());
	});
	requireSubmission(written);
	if ('entry' in written) return true;
	const state = host.state();
	// A close that did not land is progress when the same exchange is still open
	// and the record moved or its work is live: the complement of what
	// `admitsClose` admits, so the next pass decides the close again.
	return (
		state.exchange?.from === close.from &&
		(state.lastSeq !== close.through || liveWork(state, host.now()).exchange)
	);
}

function arm(host: ControlHost, at: number | undefined): void {
	host.cancelAlarm();
	host.cancelAlarm =
		at === undefined ? () => {} : host.runtime.clock.alarm(at, () => void host.reconcile());
}

// -- control ----------------------------------------------------------------

/**
 * The host dismisses one pending say. The write decides again inside the
 * journal queue, so a say that returned first writes nothing. The room then
 * looks again, so its alarm drops the due time of the say.
 */
export async function dismissSay(host: ControlHost, handle: Seq): Promise<boolean> {
	host.assertRunning();
	await host.journal.ready;
	const written = await submit(host.journal, 'message', () => {
		if (host.gone()) return { event: undefined };
		return decide(host.state(), { type: 'dismiss', message: handle }, host.now());
	});
	requireSubmission(written);
	if (!('entry' in written)) return false;
	await host.reconcile();
	return true;
}

export async function abort(host: ControlHost): Promise<void> {
	host.assertRunning();
	if (host.abortInFlight !== undefined) return host.abortInFlight;
	const key = host.abortKey ?? crypto.randomUUID();
	host.abortKey = key;
	const operation = cancel(host, key);
	host.abortInFlight = operation;
	try {
		await operation;
		host.abortKey = undefined;
	} finally {
		if (host.abortInFlight === operation) host.abortInFlight = undefined;
	}
}

/** Append the cancellation marker after every earlier journal request. */
async function cancel(host: ControlHost, key: string): Promise<void> {
	await host.ready;
	host.assertRunning();
	const appended = await submit(
		host.journal,
		'cancel',
		() => {
			if (host.gone()) return { event: undefined };
			return decide(host.state(), { type: 'cancel' }, host.now());
		},
		key,
	);
	requireSubmission(appended);
	if (!('entry' in appended))
		throw new AmbionError('room_stopped', `Room '${host.name}' stopped before cancellation.`);
}

/** Revoke every running lease until a durable read finds none. Unclaimed work stays for the next run. */
async function stopWork(host: ControlHost): Promise<void> {
	// Admission is closed. Each entry revokes one running lease;
	// the final decision confirms the recovered journal has no running lease.
	for (;;) {
		const result = await submit(host.journal, 'lease', () =>
			stopWorkDecision(host.state(), host.now()),
		);
		requireSubmission(result);
		if (!('entry' in result)) return;
	}
}

export async function stopRun(host: ControlHost): Promise<void> {
	try {
		// A room dropped from memory writes nothing: the next run over the journal takes it up.
		if (host.evicted()) return;
		await host.ready;
		await stopWork(host);
		// A write queued ahead of the stop lands first, so the record says who was present.
		await host.journal.settled();
		await host.leaveEverybody();
	} catch (error) {
		// A stop that found another run's fence has nothing left to write: the
		// run said `superseded`, and the name is the other run's.
		if (!host.evicted()) throw error;
	} finally {
		// The name comes free whatever the storage did. A failed write must
		// not leave a room that can never be started again.
		host.release();
		host.rejectExchangeWaiters(new AmbionError('room_stopped', `Room '${host.name}' was stopped.`));
	}
}
