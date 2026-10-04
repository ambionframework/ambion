/**
 * The room's own commit machinery: the reconcile loop and its alarm, the
 * cancellation, the shutdown, and the writes a seat asks for. Each write
 * decides where it lands, so a write that loses a race becomes nothing.
 */

import { decodeActivationId } from '../activation-id.ts';
import { AmbionError } from '../errors.ts';
import { placed, spaced } from '../journal/journal.ts';
import type { CommitRequest, CommitResult, LeaseResponse } from '../protocol.ts';
import { unreadBy } from '../room/rules.verified.ts';
import {
	decide,
	type ReconcileDecision,
	type ReconcileStep,
	type Refusal,
	type ReleaseCommand,
	stopWork as stopWorkDecision,
} from '../room/transition.ts';
import type { Intent, Message, Seq } from '../types.ts';
import { copyMessage } from '../types.ts';
import {
	decideAndAppend,
	messageKeyConflict,
	type RoomRunState,
	refusalError,
	requireSubmission,
	saidContentMatches,
	sameRefs,
	submit,
} from './core.ts';

/** How many times one pass folds, decides and writes before it yields. */
const PASSES_PER_RECONCILE = 8;

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
	if (message.activation !== activation) return false;
	const parsed = decodeActivationId(activation);
	if (parsed !== undefined && message.from !== parsed.seat) return false;

	if (intent.kind !== 'said') return operationMatches(intent, message);
	if (message.kind === 'said') return saidContentMatches(message, intent);
	// A closing agent says through the same `said` intent, but the room records
	// its contribution as a summary addressed to the `person` of the exchange.
	// An omitted recipient is that person; a supplied recipient must still match.
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
	run: RoomRunState,
	commit: CommitRequest,
): Promise<CommitResult | { refusal: Refusal }> {
	const appended = await decideAndAppend(
		run,
		'message',
		{
			type: 'commit',
			commit,
			bytes: run.runtime.limits.message.bytes,
			schedule: run.runtime.limits.schedule,
		},
		{ key: spaced('commit', commit.key) },
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
		return { committed: copyMessage(message), ...unreadBefore(run, commit, message) };
	}
	if (appended.result === undefined) throw new Error('The commit did not propose a message.');
	return appended.result;
}

/**
 * The messages a scheduled say, a seating, or a dismissal landed past, from
 * the record: after its `readThrough` and before the entry. A retry under the same key reads the
 * same record, so it hands back the same messages.
 */
function unreadBefore(
	run: RoomRunState,
	commit: CommitRequest,
	message: Message,
): { unread?: Message[] } {
	const { readThrough, intent } = commit;
	const ordinarySay = intent.kind === 'said' && intent.delaySeconds === undefined;
	if (ordinarySay || readThrough === undefined) return {};
	// The rule decides which entries are unread.
	const unread = run
		.state()
		.messages.filter((entry) => unreadBy(ordinarySay, readThrough, entry.seq, message.seq));
	return unread.length === 0 ? {} : { unread: unread.map(copyMessage) };
}

export async function hold(
	run: RoomRunState,
	id: string,
	type: 'claim' | 'renew',
	readThrough?: Seq,
): Promise<LeaseResponse> {
	const lease = run.runtime.limits.lease;
	const written = await decideAndAppend(
		run,
		'lease',
		{
			type,
			id,
			expiry: lease.ttl,
			deadline: lease.deadline,
			...(readThrough === undefined ? {} : { readThrough }),
		},
		{ whileRunning: true },
	);
	// A refusal of a claim or a renewal is the same answer as a lease that ended.
	return 'entry' in written && written.entry.body.phase === 'running'
		? { ok: { expiresAt: written.entry.body.expiresAt, through: run.state().lastSeq } }
		: { stale: 'the lease ended' };
}

/**
 * End one lease, for whatever reason. Nothing to end is not an error. A
 * revocation may name an activation that never claimed: the change ends it
 * before it starts, and the due activation it stood for is answered.
 * An abandonment names an activation that never claimed and nothing else:
 * a lease that started ends how it went.
 * An expiry is judged where the change is written: a renewal that landed
 * ahead of it keeps the lease, and nothing is written. The change says
 * how the activation went, and `heardLease` says so once. A release is the
 * seat's own end, and `decide` checks the authority of the seat first.
 */
export async function end(
	run: RoomRunState,
	command: Extract<ReconcileStep, { type: 'end' }> | ReleaseCommand,
): Promise<boolean | { refusal: Refusal }> {
	const appended = await decideAndAppend(run, 'lease', command);
	if ('entry' in appended) return true;
	if (appended.result !== undefined && 'refusal' in appended.result)
		return { refusal: appended.result.refusal };
	return false;
}

// -- reconcile ----------------------------------------------------------------

export function reconcile(run: RoomRunState): Promise<void> {
	run.reconciling = run.reconciling.then(() => reconcileOnce(run)).catch(() => {});
	return run.reconciling;
}

/**
 * Fold, decide, write, send, until a decision writes nothing. Every write
 * checks the fold again where it lands, so a lease that arrives between
 * the decision and the write turns the write into nothing. A write the
 * storage refuses ends the pass: whoever waits still hears the room, and
 * the room looks again after the resend window, when the storage may be
 * back and what it decided is still on the fold.
 */
async function reconcileOnce(run: RoomRunState): Promise<void> {
	await run.journal.ready;
	for (let pass = 0; pass < PASSES_PER_RECONCILE && !run.gone(); pass += 1) {
		if (await onePass(run)) return;
	}
	// A pass that kept writing yields, and the room looks again after the resend window.
	if (!run.gone()) arm(run, run.now() + run.runtime.limits.port.resend);
}

/**
 * One pass: decide, apply, and arm the clock where the room stops. True
 * where the room has nothing more to write, and the caller stops looking.
 */
async function onePass(run: RoomRunState): Promise<boolean> {
	const decision = decide(
		run.state(),
		{
			type: 'reconcile',
			options: {
				resend: run.runtime.limits.port.resend,
				attempts: run.runtime.limits.activation.attempts,
				sent: run.sentAt,
				stopped: run.gone(),
			},
		},
		run.now(),
	);
	let changed: boolean;
	try {
		changed = await apply(run, decision);
	} catch {
		// A write that failed because the room is gone arms nothing.
		if (!run.gone()) arm(run, run.now() + run.runtime.limits.port.resend);
		return true;
	}
	if (changed) return false;
	arm(run, decision.effects.alarmAt);
	return true;
}

/** Write what the decision wrote, send what it sent. True when anything changed. */
async function apply(run: RoomRunState, decision: ReconcileDecision): Promise<boolean> {
	// A wake the fold no longer says is due is not one this room waits on.
	for (const id of decision.effects.forget) run.sentAt.delete(id);
	let changed = false;
	// The decision says how each lease ends: revoked, expired, then given up on.
	for (const step of decision.steps) {
		// A room that went away mid-pass writes nothing more of what it decided.
		if (run.gone()) return changed;
		changed = (await applyStep(run, step)) || changed;
	}
	for (const send of decision.effects.sends) run.sendWake(send.id, send.seat);
	return changed || decision.effects.sends.length > 0;
}

function applyStep(run: RoomRunState, step: ReconcileStep): Promise<boolean> {
	switch (step.type) {
		case 'end':
			return end(run, step).then(requireEnd);
		case 'close':
			return closeExchange(run, step);
		case 'return':
			return returnSay(run, step);
	}
}

/**
 * The room gives one scheduled say back to its author. The write decides
 * inside the journal queue, so a say that another write returned first
 * writes nothing, and the fence refuses a run that lost the room.
 */
async function returnSay(
	run: RoomRunState,
	step: Extract<ReconcileStep, { type: 'return' }>,
): Promise<boolean> {
	const written = await decideAndAppend(run, 'message', step, { whileRunning: true });
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
async function closeExchange(
	run: RoomRunState,
	close: Extract<ReconcileStep, { type: 'close' }>,
): Promise<boolean> {
	const written = await decideAndAppend(run, 'close', close, { whileRunning: true });
	requireSubmission(written);
	return (
		'entry' in written ||
		(written.result !== undefined && 'close' in written.result && written.result.close === 'replan')
	);
}

function arm(run: RoomRunState, at: number | undefined): void {
	run.cancelAlarm();
	run.cancelAlarm =
		at === undefined ? () => {} : run.runtime.clock.alarm(at, () => void run.reconcile());
}

// -- control ----------------------------------------------------------------

/**
 * The host dismisses one scheduled say. The write decides again inside the
 * journal queue, so a say that returned first writes nothing. The room then
 * looks again, so its alarm drops the due time of the say.
 */
export async function dismissSay(run: RoomRunState, seq: Seq): Promise<boolean> {
	await run.ready;
	run.assertRunning();
	const written = await decideAndAppend(
		run,
		'message',
		{ type: 'dismiss', message: seq },
		{ whileRunning: true },
	);
	requireSubmission(written);
	if (run.gone() && !('entry' in written))
		throw new AmbionError('room_stopped', `Room '${run.name}' stopped before the dismissal.`);
	if (!('entry' in written)) return false;
	await run.reconcile();
	return true;
}

export async function cancel(run: RoomRunState): Promise<void> {
	run.assertRunning();
	if (run.cancelInFlight !== undefined) return run.cancelInFlight;
	const key = run.cancelKey ?? crypto.randomUUID();
	run.cancelKey = key;
	const operation = appendCancel(run, key);
	run.cancelInFlight = operation;
	try {
		await operation;
		run.cancelKey = undefined;
	} finally {
		if (run.cancelInFlight === operation) run.cancelInFlight = undefined;
	}
}

/** Append the cancellation marker after every earlier journal request. */
async function appendCancel(run: RoomRunState, key: string): Promise<void> {
	await run.ready;
	run.assertRunning();
	const appended = await decideAndAppend(
		run,
		'cancel',
		{ type: 'cancel' },
		{ key, whileRunning: true },
	);
	requireSubmission(appended);
	if (!('entry' in appended))
		throw new AmbionError('room_stopped', `Room '${run.name}' stopped before cancellation.`);
}

/** Revoke every running lease until a durable read finds none. Unclaimed work stays for the next run. */
async function stopWork(run: RoomRunState): Promise<void> {
	// Admission is closed. Each entry revokes one running lease;
	// the final decision confirms the recovered journal has no running lease.
	for (;;) {
		const result = await submit(run.journal, 'lease', () =>
			stopWorkDecision(run.state(), run.now()),
		);
		requireSubmission(result);
		if (!('entry' in result)) return;
	}
}

export async function stopRun(run: RoomRunState): Promise<void> {
	try {
		// A room dropped from memory writes nothing: the next run over the journal takes it up.
		if (run.evicted()) return;
		await run.ready;
		await stopWork(run);
		// A write queued ahead of the stop lands first, so the record says who was present.
		await run.journal.settled();
		await run.leaveEverybody();
	} catch (error) {
		// A stop that found another run's fence has nothing left to write: the
		// run said `superseded`, and the name is the other run's.
		if (!run.evicted()) throw error;
	} finally {
		// The name comes free whatever the storage did. A failed write must
		// not leave a room that can never be started again.
		run.release();
		// The room is gone: each caller that waits looks once more, and stops.
		run.notifyExchangeWaiters();
	}
}
