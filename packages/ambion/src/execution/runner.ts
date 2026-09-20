/**
 * The driver: runs activations over the RoomProtocol protocol.
 *
 * AgentRunner owns the lease, its renewal, the cut, the wake queue, the
 * record a seat reads, and the decision to run another pass. It knows
 * nothing about a model, a provider, or a transcript: an activation's
 * executor renders the prompt, runs its own loop, and reports where it left
 * off. Wake, steer, and cut reach this driver through the transport.
 */

import type { AgentExecutionContext, Transport } from '../host/runtime.ts';
import type {
	ActivationView,
	AgentPort,
	RoomProtocol,
	Steer,
	ViewRange,
	ViewResponse,
	Wake,
} from '../protocol.ts';
import type { EndReason, ExecutionEvent, FailureCause, Message, Seq } from '../types.ts';
import type { ExecutorSession, PassResult } from './executor.ts';
import { renderLine, windowToLimit } from './render.ts';

type CallResult<T> =
	{ kind: 'value'; value: T } | { kind: 'lost'; error: Error } | { kind: 'cancelled' };

// -- the actor ----------------------------------------------------------------

/** One activation the actor holds while it runs. */
interface Current {
	id: string;
	session: ExecutorSession;
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
		current.session.steer?.(steer.after, steer.message.seq, renderLine(steer.message));
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
	 * The room ended this activation's lease. The activation is aborted, and
	 * the actor moves on at once: a run that ignores the abort is left to
	 * finish on its own, and every call it still makes is answered stale.
	 */
	async cut(activation: string): Promise<void> {
		if (this.current?.id === activation) this.cutCurrent();
	}

	/** Cut the activation in flight, whatever its id. The room hears how it ended. */
	abort(): void {
		this.cutCurrent();
	}

	private cutCurrent(): void {
		const current = this.current;
		if (current === undefined) return;
		current.session.abort();
		current.cut();
	}

	private async take(id: string): Promise<void> {
		// Held before the claim, so a steer that lands while the claim is in
		// flight reaches the activation and remains available for the next run.
		let cut = () => {};
		const cutOff = new Promise<void>((resolve) => {
			cut = resolve;
		});
		const session = this.context.executor.open({
			id,
			room: this.boundedRoom(cutOff),
			emit: (event) => this.emit(event),
		});
		const current: Current = { id, session, over: false, cut, cutOff, expired: false };
		this.current = current;
		try {
			const claimed = await this.claim(id);
			if (claimed !== undefined) await this.runClaimed(id, current, claimed);
		} finally {
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
				// abort finishes on its own, past a seat that took its next wake.
				last = await Promise.race([
					this.runPasses(id, current.session, current.cutOff),
					current.cutOff.then(() => undefined),
				]);
			}
		} finally {
			stopRenewing();
			// Over, and holding the seat through the release: a wake that lands
			// now runs next, and never beside the activation that is releasing.
			current.over = true;
			const failed = current.expired || (last?.failed ?? false);
			await this.release(
				id,
				failed ? 'failed' : 'released',
				current.session.readThrough,
				last?.cause,
			);
		}
	}

	/**
	 * Pass over the record until the activation stops: an executor failure, a
	 * closing purpose (which never rebuilds), a cancelled session, or nothing
	 * left the executor or the room needs it to see again. A cancelled
	 * session earns no further room call on its behalf: an abort mid-pass is
	 * not a provider failure, but it still ends the loop here, before the
	 * freshness check would otherwise renew a lease this activation no
	 * longer holds. A room call this loop cannot recover from (a lost view
	 * or renewal) ends the activation as a transient failure, the same as a
	 * broken pass.
	 */
	private async runPasses(
		id: string,
		session: ExecutorSession,
		cancelled: Promise<void>,
	): Promise<PassResult | undefined> {
		let last: PassResult | undefined;
		try {
			for (;;) {
				const opened = await this.viewFor(id, cancelled);
				if ('stale' in opened) return last;
				const view = opened.view;
				last = await session.pass(view);
				if (last.failed || session.cancelled || view.spec.purpose.kind !== 'respond') return last;
				if (!(await this.needsRefresh(id, session, cancelled))) return last;
			}
		} catch (error) {
			return this.broke(id, error);
		}
	}

	/** Record and report a room call this loop cannot recover from, as a transient failure. */
	private broke(id: string, error: unknown): PassResult {
		const broken = error instanceof Error ? error : new Error(String(error));
		this.emit({
			type: 'error',
			agent: this.context.seat,
			activation: id,
			error: broken,
			cause: 'transient',
		});
		return { failed: true, cause: 'transient' };
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
	): Promise<void> {
		const released = await this.calls(
			() =>
				this.room.lease({
					activation: id,
					operation: 'release',
					reason,
					readThrough,
					...(cause === undefined ? {} : { cause }),
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
			const renewed = await this.renew(current.id, current.session.readThrough);
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
		session: ExecutorSession,
		cancelled: Promise<void>,
	): Promise<boolean> {
		const renewed = await this.call(
			() =>
				this.room.lease({ activation: id, operation: 'renew', readThrough: session.readThrough }),
			cancelled,
		);
		if (renewed.kind === 'cancelled') return false;
		if (renewed.kind !== 'value') {
			this.reportCallFailure(id, 'renew', renewed.error);
			throw renewed.error;
		}
		if ('stale' in renewed.value) return false;
		return session.shouldRefresh(renewed.value.ok.lastSeq);
	}

	/**
	 * The record windowed to the agent's token limit. The seat pages the record
	 * from the tail, keeps the newest blocks that fit, and stops when the window
	 * starts above the record it holds or the record reaches its floor. The open
	 * exchange stays whole even past the limit; a summary activation pins its own
	 * exchange whole the same way and windows the background before it.
	 *
	 * The first page fixes the frame — its purpose, exchange, participants, and
	 * `through`. Later pages add only older messages, so the acknowledged
	 * position stays what the tail page held.
	 */
	private async windowedView(
		id: string,
		limit: number,
		cancelled: Promise<void>,
	): Promise<ViewResponse> {
		const estimate = this.context.definition.executor.estimateTokens ?? defaultEstimate;
		let before: number | undefined;
		let held: Message[] = [];
		let frame: ActivationView | undefined;
		for (;;) {
			const page = await this.pageView(id, before, cancelled);
			if ('stop' in page) return page.stop;
			if (frame === undefined) frame = page.view;
			const older = page.view.context.messages;
			held = [...older, ...held];
			const window = windowToLimit(held, estimate, limit, pinOf(frame));
			before = held[0]?.seq;
			if (pagingDone(window.from, held, frame.context.earliest, older.length))
				return { view: withWindow(frame, window.kept) };
		}
	}

	/** The record a pass reads: windowed to the agent's limit, or the room's whole answer. */
	private async viewFor(id: string, cancelled: Promise<void>): Promise<ViewResponse> {
		const limit = this.context.definition.executor.activationTokenLimit;
		if (limit !== undefined) return this.windowedView(id, limit, cancelled);
		const opened = await this.call(() => this.room.view(id), cancelled);
		if (opened.kind === 'value') return opened.value;
		if (opened.kind === 'cancelled') return { stale: 'the activation was cut' };
		this.reportCallFailure(id, 'view', opened.error);
		throw opened.error;
	}

	/** One bounded page of the record, or the response that stops the paging. */
	private async pageView(
		id: string,
		before: number | undefined,
		cancelled: Promise<void>,
	): Promise<{ stop: ViewResponse } | { view: ActivationView }> {
		const range: ViewRange =
			before === undefined ? { limit: RECORD_PAGE } : { before, limit: RECORD_PAGE };
		const opened = await this.call(() => this.room.view(id, range), cancelled);
		if (opened.kind === 'cancelled') return { stop: { stale: 'the activation was cut' } };
		if (opened.kind !== 'value') {
			this.reportCallFailure(id, 'view', opened.error);
			throw opened.error;
		}
		const response = opened.value;
		return 'stale' in response ? { stop: response } : { view: response.view };
	}

	private reportCallFailure(
		activation: string,
		operation: 'view' | 'commit' | 'claim' | 'renew' | 'release',
		error: Error,
	): void {
		this.emit({ type: 'delivery_error', agent: this.context.seat, activation, operation, error });
	}

	private emit(event: ExecutionEvent): void {
		try {
			this.context.emit?.(event);
		} catch {
			// A diagnostic listener cannot strand an activation.
		}
	}

	private boundedRoom(cancelled: Promise<void>): RoomProtocol {
		return {
			view: (id) => this.room.view(id),
			commit: async (request) => {
				// The commit key is the tool call id, so a retry under it is
				// idempotent: the room returns the message it already holds. A commit
				// no attempt confirms is unknown; it may or may not have landed. The
				// tool then ends the turn. A second say under a new key would land the
				// same message twice.
				const committed = await this.calls(() => this.room.commit(request), cancelled);
				if (committed.kind === 'value') return committed.value;
				if (committed.kind === 'cancelled') return { stale: 'the activation was cut' };
				this.reportCallFailure(request.activation, 'commit', committed.error);
				return { unknown: committed.error.message };
			},
			lease: (request) => this.room.lease(request),
		};
	}
}

// -- record windowing ---------------------------------------------------------

/** How many messages one bounded page reads back from the record cursor. */
const RECORD_PAGE = 64;

/** The token estimate when an agent declares a budget but no estimator. */
function defaultEstimate(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * The open exchange is pinned whole for an ordinary response; a summary
 * activation pins its own closed exchange the same way, so the window never
 * trims the range it is writing about.
 */
function pinOf(view: ActivationView): Seq | undefined {
	const { purpose } = view.spec;
	return purpose.kind === 'respond' ? view.context.exchange?.from : purpose.exchange;
}

/**
 * Paging is done when the last page added nothing, the window starts above the
 * held record, or the record has no earlier entry. Otherwise the window still
 * reaches the oldest held message, so an earlier page may hold more of it.
 */
function pagingDone(
	from: Seq,
	held: readonly Message[],
	earliest: Seq | undefined,
	older: number,
): boolean {
	const lowest = held[0]?.seq;
	if (older === 0 || lowest === undefined) return true;
	if (from > lowest) return true;
	return earliest === undefined || lowest <= earliest;
}

/** The view with its messages replaced by the windowed record the seat assembled. */
function withWindow(view: ActivationView, kept: readonly Message[]): ActivationView {
	return { ...view, context: { ...view.context, messages: [...kept] } };
}

// -- the transport ------------------------------------------------------------

/** Run each seat locally through the room-call facade and its executor context. */
export function inProcessTransport(): Transport {
	return {
		connect(room, context) {
			return new AgentRunner(room, context);
		},
	};
}
