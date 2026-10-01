/**
 * The driver: runs activations over `RoomProtocol`.
 *
 * AgentRunner owns the lease, its renewal, the cut, the wake queue, the
 * record a seat reads, and the decision to run another pass. It knows
 * nothing about a model, a provider, or a transcript. The `ActivationState`
 * of each activation keeps the read position, the tools, and the prompt,
 * and the executor runs its own loop over them. The runner is the port of
 * its seat: the room calls its wake, steer, and cut.
 */

import type { AgentExecutionContext } from '../host/runtime.ts';
import type {
	ActivationView,
	AgentPort,
	CommitRequest,
	CommitResult,
	PassInput,
	PassResult,
	RoomProtocol,
	Steer,
	TraceSink,
	ViewResponse,
	Wake,
} from '../protocol.ts';
import { renderLine } from '../record.ts';
import type {
	ActivationEvent,
	EndReason,
	FailureCause,
	Seq,
	Step,
	Usage,
	VendorSession,
} from '../types.ts';
import { type ActivationInput, ActivationState } from './activation.ts';
import { failedPass } from './failure.ts';

type CallResult<T> =
	{ kind: 'value'; value: T } | { kind: 'lost'; error: Error } | { kind: 'cancelled' };

// -- the actor ----------------------------------------------------------------

/** One activation the actor holds while it runs. */
interface Current {
	id: string;
	state: ActivationState;
	/** The steps of this activation. The driver closes it when the activation ends. */
	trace: TraceSink;
	/** The activation ran to its end, and its release is in flight. It takes no steer. */
	over: boolean;
	/** Ends local waits after a room cut or the last confirmed lease expiry. */
	cut: () => void;
	cutOff: Promise<void>;
	/** Set on a local lease expiry: the release reports it failed whatever the last pass said. */
	expired: boolean;
}

/**
 * The seat's side of the wire. One actor per seat, for as long as the room
 * runs; one activation at a time, named by the wake that started it.
 */
export class AgentRunner implements AgentPort {
	private readonly room: RoomProtocol;
	private readonly context: AgentExecutionContext;
	private current: Current | undefined;
	/** The wakes that arrived while an activation ran, in order. They run next, once each. */
	private readonly queued: string[] = [];

	constructor(room: RoomProtocol, context: AgentExecutionContext) {
		this.room = room;
		this.context = context;
	}

	/**
	 * A wake starts an activation when none runs. While one runs, a wake for
	 * another activation queues it to run next. Steering is a separate call
	 * targeted at the activation that was live when the message landed.
	 */
	async wake(wake: Wake): Promise<void> {
		if (this.current === undefined) {
			void this.run(wake.activation);
			return;
		}
		if (this.current.id === wake.activation) return;
		this.enqueue(wake.activation);
	}

	/** Deliver context only to the activation the journal projection targeted. */
	async steer(steer: Steer): Promise<void> {
		const current = this.current;
		if (current === undefined || current.over || current.id !== steer.activation) return;
		current.state.steer(steer.after, steer.message.seq, renderLine(steer.message));
	}

	/**
	 * One activation to its end: claim, run, release, then whatever queued
	 * behind it, in order. A host that runs a seat inside one request awaits
	 * this, and it resolves once the seat has nothing left to run.
	 */
	async run(id: string): Promise<void> {
		if (this.current !== undefined) {
			this.enqueue(id);
			return;
		}
		await this.take(id);
	}

	/** A wake sent twice queues once, and keeps the place the first one took. */
	private enqueue(id: string): void {
		if (!this.queued.includes(id)) this.queued.push(id);
	}

	/**
	 * The room ended this activation's lease. The activation is cut, and
	 * the actor moves on at once: a run that ignores the cut is left to
	 * finish on its own, and every call it still makes is answered stale.
	 */
	async cut(activation: string): Promise<void> {
		if (this.current?.id === activation) this.cutCurrent();
	}

	/**
	 * Release, as failed, an activation whose run this process lost. A host
	 * that dropped a run with its memory calls this when it comes back. The
	 * release makes the attempts of one room call, and a release that none
	 * of them confirms raises a `delivery_error`.
	 */
	async recover(activation: string): Promise<void> {
		await this.release(activation, 'failed', 0, undefined, undefined, undefined);
	}

	/** Cut the activation in flight, whatever its id. The room hears how it ended. */
	cutAll(): void {
		this.cutCurrent();
	}

	private cutCurrent(): void {
		const current = this.current;
		if (current === undefined) return;
		current.state.cut();
		current.cut();
	}

	private async take(id: string): Promise<void> {
		// Held before the claim, so a steer that lands while the claim is in
		// flight reaches the activation and remains available for the next run.
		let cut = () => {};
		const cutOff = new Promise<void>((resolve) => {
			cut = resolve;
		});
		const trace = this.context.trace.open(id);
		const state = new ActivationState(this.context.opener, {
			id,
			room: this.boundedRoom(cutOff, trace),
			definition: this.context.definition,
			emit: (event) => this.emit(event),
			trace,
		});
		const current: Current = { id, state, trace, over: false, cut, cutOff, expired: false };
		this.current = current;
		try {
			const claimed = await this.claim(id);
			if (claimed !== undefined) await this.runClaimed(id, current, claimed);
		} finally {
			// The sink logs each step as it comes. Close logs the block in progress.
			// The activation holds the seat until its sink closes, so a wake that
			// lands during the close queues behind it. A claim that failed ran no
			// pass, so the lines that waited for one record their step first.
			state.dropEarly();
			await trace.close();
			state.close();
			if (this.current === current) this.current = undefined;
			await this.next();
		}
	}

	/** Run and release one claimed activation: renewed until it stops, then released once. */
	private async runClaimed(
		id: string,
		current: Current,
		claimed: { expiresAt: number },
	): Promise<void> {
		current.expired = claimed.expiresAt <= this.context.clock.now();
		if (current.expired) this.cutCurrent();
		const stopRenewing = current.expired ? () => {} : this.renewUntil(current, claimed.expiresAt);
		let last: PassResult | undefined;
		try {
			if (!current.expired) {
				// The cut ends the wait, and never the run: a run that ignores the
				// cut finishes on its own, past a seat that took its next wake.
				last = await Promise.race([
					this.runPasses(id, current.state, current.trace, current.cutOff),
					current.cutOff.then(() => undefined),
				]);
			}
		} finally {
			stopRenewing();
			// Over, and holding the seat through the release: a wake that lands
			// now runs next, and never beside the activation that is releasing.
			current.over = true;
			const failed = current.expired || (last?.failed ?? false);
			// A line that waited for a first pass that never ran gets its step before the end.
			current.state.dropEarly();
			current.trace.record(endStep(current, last));
			await this.release(
				id,
				failed ? 'failed' : 'released',
				current.state.readThrough,
				last?.cause,
				current.trace.usage(),
				current.state.session,
			);
		}
	}

	/**
	 * Pass over the record until the activation stops: an executor failure, a
	 * summarize purpose (which never rebuilds), a cut activation, or nothing
	 * left the executor or the room needs it to see again. A cut activation
	 * earns no further room call on its behalf: a cut mid-pass is not a
	 * provider failure, but it still ends the loop here, before the freshness
	 * check would otherwise renew a lease this activation no longer holds. A
	 * room call this loop cannot recover from (a lost view or renewal) ends
	 * the activation as a transient failure, the same as a broken pass.
	 */
	private async runPasses(
		id: string,
		state: ActivationState,
		trace: TraceSink,
		cancelled: Promise<void>,
	): Promise<PassResult | undefined> {
		let last: PassResult | undefined;
		let after: Seq | undefined;
		try {
			for (;;) {
				const opened = await this.viewFor(id, cancelled);
				if ('stale' in opened) return last;
				const view = opened.view;
				last = await passOver(state, trace, passInput(view, after));
				after = state.readThrough;
				if (last.failed || state.cancelled || view.spec.purpose.kind !== 'respond') return last;
				if (!(await this.needsRefresh(id, state, cancelled))) return last;
			}
		} catch (error) {
			return broke(state, error);
		}
	}

	/**
	 * One call to the room, sent again while it never comes back. A call the
	 * room answers is done, whatever it answers. A call that throws reached
	 * nobody, or its answer was lost, so the seat sends it again, up to the
	 * attempts the runtime names. A cut cancels the call without a retry.
	 */
	private async calls<T>(
		send: () => Promise<T>,
		cancelled?: Promise<void>,
	): Promise<CallResult<T>> {
		let last: CallResult<T> = { kind: 'lost', error: new Error('Room call failed.') };
		for (let attempt = 0; attempt < this.context.call.attempts; attempt += 1) {
			const result = await this.call(send, cancelled);
			if (result.kind === 'value') return result;
			if (result.kind === 'cancelled') return result;
			last = result;
		}
		return last;
	}

	/** Wait for one room call, its host-clock deadline, or the activation cut. */
	private async call<T>(
		send: () => Promise<T>,
		cancelled: Promise<void> | undefined,
		timeout = this.context.call.timeout,
	): Promise<CallResult<T>> {
		let stopAlarm = () => {};
		let resolveDeadline: () => void = () => {};
		const deadline = new Promise<void>((resolve) => {
			resolveDeadline = resolve;
		});
		stopAlarm = this.context.clock.alarm(this.context.clock.now() + timeout, resolveDeadline);
		let sent: Promise<T>;
		try {
			sent = send();
		} catch (error) {
			sent = Promise.reject(error);
		}
		const outcome = await Promise.race([
			sent.then(
				(value) => ({ kind: 'value' as const, value }),
				(error: unknown) => ({
					kind: 'lost' as const,
					error: error instanceof Error ? error : new Error(String(error)),
				}),
			),
			deadline.then(() => ({ kind: 'lost' as const, error: new Error('Room call timed out.') })),
			...(cancelled === undefined ? [] : [cancelled.then(() => ({ kind: 'cancelled' as const }))]),
		]);
		stopAlarm();
		return outcome;
	}

	/**
	 * The lease, or nothing: the room refused it, or no attempt at the claim
	 * came back. A claim of an id the room already runs is a renewal, so one
	 * activation starts whichever call reached the room first.
	 */
	private async claim(id: string): Promise<{ expiresAt: number } | undefined> {
		const claimed = await this.calls(
			() => this.room.lease({ activation: id, operation: 'claim' }),
			this.current?.cutOff,
		);
		if (claimed.kind !== 'value') {
			if (claimed.kind === 'lost') this.reportCallFailure(id, 'claim', claimed.error);
			return undefined;
		}
		return 'stale' in claimed.value ? undefined : claimed.value.ok;
	}

	/** The next wake that queued, to its end. */
	private async next(): Promise<void> {
		const queued = this.queued.shift();
		if (queued !== undefined) await this.take(queued);
	}

	/**
	 * The lease is released, however the activation went. A lease that ended
	 * answers stale, and that is fine. A release no attempt got through
	 * leaves the room to end the lease on its side.
	 */
	private async release(
		id: string,
		reason: EndReason,
		readThrough: Seq,
		cause: FailureCause | undefined,
		usage: Usage | undefined,
		session: VendorSession | undefined,
	): Promise<void> {
		const released = await this.calls(
			() =>
				this.room.lease({
					activation: id,
					operation: 'release',
					reason,
					readThrough,
					...(cause === undefined ? {} : { cause }),
					...(usage === undefined ? {} : { usage }),
					...(session === undefined ? {} : { session }),
				}),
			this.current?.cutOff,
		);
		if (released.kind === 'lost') this.reportCallFailure(id, 'release', released.error);
	}

	/**
	 * One renewal: the new expiry, `stale` when the room refused it, or
	 * `lost` when no reply confirms the result.
	 */
	private async renew(id: string, readThrough: Seq): Promise<number | 'stale' | 'lost'> {
		const renewed = await this.call(
			() => this.room.lease({ activation: id, operation: 'renew', readThrough }),
			this.current?.cutOff,
		);
		if (renewed.kind !== 'value') {
			if (renewed.kind === 'lost') this.reportCallFailure(id, 'renew', renewed.error);
			return renewed.kind === 'cancelled' ? 'stale' : 'lost';
		}
		return 'stale' in renewed.value ? 'stale' : renewed.value.ok.expiresAt;
	}

	/**
	 * Renew at half the expiry, for as long as the activation runs and the
	 * room renews it. A refused renewal cuts the activation now: its lease
	 * ended, so nothing it writes lands. A renewal that moves the expiry
	 * nowhere says the lease reached its deadline. An unconfirmed renewal
	 * keeps the last confirmed expiry as the local execution boundary.
	 * The room may have accepted a renewal whose reply was lost.
	 * The cancel stops the loop for good: a renewal in flight when the
	 * activation ends arms nothing when it comes back.
	 */
	private renewUntil(current: Current, firstExpiry: number): () => void {
		const clock = this.context.clock;
		let stopped = false;
		let cancelRenewal = () => {};
		let cancelExpiry = () => {};
		const cut = () => {
			if (this.current === current) this.cutCurrent();
		};
		const expire = () => {
			if (this.current !== current) return;
			// A local expiry is an execution failure even when the room may still
			// accept a late renewal. The room's journal remains authoritative.
			current.expired = true;
			this.cutCurrent();
		};
		const schedule = (expiry: number) => {
			cancelRenewal();
			cancelExpiry();
			cancelRenewal = clock.alarm(
				clock.now() + (expiry - clock.now()) / 2,
				() => void again(expiry),
			);
			cancelExpiry = clock.alarm(expiry, expire);
		};
		const again = async (held: number) => {
			const renewed = await this.renew(current.id, current.state.readThrough);
			if (stopped) return;
			if (renewed === 'stale') cut();
			else if (renewed === 'lost') {
				cancelRenewal = () => {};
			} else if (renewed <= held) {
				cancelRenewal = () => {};
				cancelExpiry();
				cancelExpiry = clock.alarm(renewed, expire);
			} else schedule(renewed);
		};
		schedule(firstExpiry);
		return () => {
			stopped = true;
			cancelRenewal();
			cancelExpiry();
		};
	}

	/**
	 * Whether the record moved past what this pass consumed. A renewal
	 * confirms the room's current position; the executor reports whether it
	 * still has work queued even without one. A renewal no attempt confirms
	 * is unknown, not stale, so it fails the activation the same as a
	 * broken pass rather than ending it quietly.
	 */
	private async needsRefresh(
		id: string,
		state: ActivationState,
		cancelled: Promise<void>,
	): Promise<boolean> {
		const renewed = await this.call(
			() => this.room.lease({ activation: id, operation: 'renew', readThrough: state.readThrough }),
			cancelled,
		);
		if (renewed.kind === 'cancelled') return false;
		if (renewed.kind !== 'value') {
			this.reportCallFailure(id, 'renew', renewed.error);
			throw renewed.error;
		}
		if ('stale' in renewed.value) return false;
		return state.shouldRefresh(renewed.value.ok.through);
	}

	/** The record a pass reads, as the room windows it for this seat. */
	private async viewFor(id: string, cancelled: Promise<void>): Promise<ViewResponse> {
		const opened = await this.call(() => this.room.view(id), cancelled);
		if (opened.kind === 'value') return opened.value;
		if (opened.kind === 'cancelled') return { stale: 'the activation was cut' };
		this.reportCallFailure(id, 'view', opened.error);
		throw opened.error;
	}

	private reportCallFailure(
		activation: string,
		operation: 'view' | 'commit' | 'claim' | 'renew' | 'release',
		error: Error,
	): void {
		this.emit({ type: 'delivery_error', seat: this.context.seat, activation, operation, error });
	}

	private emit(event: ActivationEvent): void {
		try {
			this.context.emit?.(event);
		} catch {
			// A diagnostic listener cannot strand an activation.
		}
	}

	/**
	 * The room calls the room tools make. A commit ends when the activation is
	 * cut, and its answer becomes a `room` step.
	 */
	private boundedRoom(cancelled: Promise<void>, trace: TraceSink): ActivationInput['room'] {
		return {
			view: (id, message) => this.room.view(id, message),
			commit: async (request) => {
				const response = await this.commitOnce(request, cancelled);
				trace.record(roomStep(request, response));
				return response;
			},
		};
	}

	/**
	 * The commit key is the tool call id, so a retry under it is idempotent:
	 * the room returns the message it already holds. A commit no attempt
	 * confirms is unknown; it may or may not have landed. The tool then ends
	 * the turn. A second say under a new key would land the same message twice.
	 */
	private async commitOnce(
		request: CommitRequest,
		cancelled: Promise<void>,
	): Promise<CommitResult> {
		const committed = await this.calls(() => this.room.commit(request), cancelled);
		if (committed.kind === 'value') return committed.value;
		if (committed.kind === 'cancelled') return { stale: 'the activation was cut' };
		this.reportCallFailure(request.activation, 'commit', committed.error);
		return { unknown: committed.error.message };
	}
}

// -- the trace ----------------------------------------------------------------

/** A room call the pass loop cannot recover from fails the activation, as a thrown pass does. */
function broke(state: ActivationState, thrown: unknown): PassResult {
	return state.report(failedPass(thrown));
}

/** One pass, opened in the trace. The first pass reads the view; a later one follows the record. */
function passOver(state: ActivationState, trace: TraceSink, input: PassInput): Promise<PassResult> {
	trace.startPass(input.kind, input.view.through);
	return state.pass(input);
}

/** What the room answered to a commit, as a `room` step. */
function roomStep(request: CommitRequest, response: CommitResult): Step {
	const base = { type: 'room' as const, call: request.key, intent: request.intent };
	if ('committed' in response) return { ...base, result: 'committed', seq: response.committed.seq };
	if ('unchanged' in response) return { ...base, result: 'unchanged' };
	if ('missed' in response) return { ...base, result: 'missed' };
	if ('refused' in response) return { ...base, result: 'refused' };
	if ('stale' in response) return { ...base, result: 'stale' };
	return { ...base, result: 'unknown' };
}

/** How the activation stopped. A cut or an expired lease is `cut`. */
function endStep(current: Current, last: PassResult | undefined): Step {
	const cut = current.expired || current.state.cancelled;
	const stop = cut ? 'cut' : (last?.stop ?? 'stopped');
	if (last?.failed === true) {
		const failure = {
			cause: last.cause ?? 'transient',
			message: last.message ?? 'The activation failed.',
		};
		return { type: 'end', stop, failure };
	}
	if (current.expired) {
		return { type: 'end', stop, failure: { cause: 'transient', message: 'The lease expired.' } };
	}
	return { type: 'end', stop };
}

/** The first pass reads the whole view. A later pass reads what came after `after`. */
function passInput(view: ActivationView, after: Seq | undefined): PassInput {
	return after === undefined ? { kind: 'view', view } : { kind: 'delta', after, view };
}
