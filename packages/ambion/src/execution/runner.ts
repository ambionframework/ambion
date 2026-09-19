/**
 * Runs agent activations over the SeatRoom protocol.
 *
 * AgentRunner owns the Pi loop and transcript audit. The room owns routing,
 * leases, and the collaboration record. Wake, steer, and cut reach this runner
 * through the transport.
 */

import type { AuditSession as PiSession, SessionOpener } from '@ambionframework/pi-journal';
import type { Agent as PiAgent } from '@earendil-works/pi-agent-core';
import { Agent } from '@earendil-works/pi-agent-core';
import type { SeatContext, Transport } from '../host/runtime.ts';
import type { ActivationView, SeatPort, SeatRoom, Steer, Wake } from '../protocol.ts';
import type { RoomNotification } from '../types.ts';
import { Activation, persistTurns } from './activation.ts';
import { renderActivation, renderLine } from './render.ts';
import { seatSessionId } from './services.ts';
import { binding, toolsFor } from './tools.ts';

type CallResult<T> =
	{ kind: 'value'; value: T } | { kind: 'lost'; error: Error } | { kind: 'cancelled' };

// -- the actor ----------------------------------------------------------------

/** One activation the actor holds while it runs. */
interface Current {
	id: string;
	activation: Activation;
	/** The activation ran to its end, and its release is in flight. It takes no steer. */
	over: boolean;
	/** Ends local waits after a room cut or the last confirmed lease expiry. */
	cut: () => void;
	cutOff: Promise<void>;
}

/**
 * The seat's side of the wire. One actor per seat, for as long as the room
 * runs; one activation at a time, named by the wake that started it.
 */
export class AgentRunner implements SeatPort {
	private readonly room: SeatRoom;
	private readonly context: SeatContext;
	private current: Current | undefined;
	/** The wakes that arrived while an activation ran, in order. They run next, once each. */
	private readonly queued: string[] = [];
	private audit: Promise<PiSession> | undefined;

	constructor(room: SeatRoom, context: SeatContext) {
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
		current.activation.steer(steer.after, steer.message.seq, renderLine(steer.message));
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
		current.activation.abort();
		current.cut();
	}

	private async take(id: string): Promise<void> {
		// Held before the claim, so a steer that lands while the claim is in
		// flight reaches the activation and remains available for the next run.
		let cut = () => {};
		const cutOff = new Promise<void>((resolve) => {
			cut = resolve;
		});
		const activation = new Activation(id, this.context.seat, this.host(id, cutOff));
		const current: Current = { id, activation, over: false, cut, cutOff };
		this.current = current;
		try {
			const claimed = await this.claim(id);
			if (claimed !== undefined) {
				const expired = claimed.expiresAt <= this.context.clock.now();
				if (expired) {
					activation.failed = true;
					this.cutCurrent();
				}
				const stopRenewing = expired ? () => {} : this.renewUntil(current, claimed.expiresAt);
				try {
					if (!expired) {
						// The cut ends the wait, and never the run: a run that ignores the
						// abort finishes on its own, past a seat that took its next wake.
						await Promise.race([activation.run(), cutOff]);
					}
				} finally {
					stopRenewing();
					// Over, and holding the seat through the release: a wake that lands
					// now runs next, and never beside the activation that is releasing.
					current.over = true;
					await this.release(id, activation);
				}
			}
		} finally {
			if (this.current === current) this.current = undefined;
			await this.next();
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
	private async release(id: string, activation: Activation): Promise<void> {
		const { reason, cause } = activation;
		const released = await this.calls(
			() =>
				this.room.lease({
					activation: id,
					operation: 'release',
					reason,
					readThrough: activation.readThrough,
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
	private async renew(activation: Activation): Promise<number | 'stale' | 'lost'> {
		const renewed = await this.call(
			() =>
				this.room.lease({
					activation: activation.id,
					operation: 'renew',
					readThrough: activation.readThrough,
				}),
			this.current?.cutOff,
		);
		if (renewed.kind !== 'value') {
			if (renewed.kind === 'lost') this.reportCallFailure(activation.id, 'renew', renewed.error);
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
			current.activation.failed = true;
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
			const renewed = await this.renew(current.activation);
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

	private host(id: string, cancelled: Promise<void>) {
		const { clock, room, seat, transcripts } = this.context;
		return {
			view: async () => {
				const opened = await this.call(() => this.room.view(id), cancelled);
				if (opened.kind === 'value') return opened.value;
				if (opened.kind === 'cancelled') return { stale: 'the activation was cut' };
				this.reportCallFailure(id, 'view', opened.error);
				throw opened.error;
			},
			renew: async (readThrough: number) => {
				const renewed = await this.call(
					() => this.room.lease({ activation: id, operation: 'renew', readThrough }),
					cancelled,
				);
				if (renewed.kind === 'value') return renewed.value;
				if (renewed.kind === 'cancelled') return { stale: 'the activation was cut' };
				this.reportCallFailure(id, 'renew', renewed.error);
				throw renewed.error;
			},
			build: (view: ActivationView, activation: Activation) =>
				this.build(view, activation, cancelled),
			persist: (agent: PiAgent) => {
				const open = () => this.openAudit(transcripts, seatSessionId(room, seat), room);
				return persistTurns(open, agent, new Date(clock.now()).toISOString());
			},
			emit: (event: RoomNotification) => this.emit(event),
			now: () => clock.now(),
		};
	}

	private reportCallFailure(
		activation: string,
		operation: 'view' | 'commit' | 'claim' | 'renew' | 'release',
		error: Error,
	): void {
		this.emit({ type: 'delivery_error', agent: this.context.seat, activation, operation, error });
	}

	private emit(event: RoomNotification): void {
		try {
			this.context.emit?.(event);
		} catch {
			// A diagnostic listener cannot strand an activation.
		}
	}

	private boundedRoom(cancelled: Promise<void>): SeatRoom {
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

	private openAudit(transcripts: SessionOpener, id: string, parent: string): Promise<PiSession> {
		if (this.audit !== undefined) return this.audit;
		const opening = transcripts.open(id, parent);
		let retained: Promise<PiSession>;
		retained = opening.then(
			(session) => session,
			(error: unknown) => {
				if (this.audit === retained) this.audit = undefined;
				throw error;
			},
		);
		this.audit = retained;
		return retained;
	}

	/**
	 * The model over the view: the executor renders the prompt, resolves the
	 * definition's model, and binds the permitted tools. The stream function tells the activation
	 * when the model is asked, so a steer never joins the request it lands during.
	 */
	private async build(
		view: ActivationView,
		activation: Activation,
		cancelled: Promise<void>,
	): Promise<{ agent: PiAgent; context: string }> {
		const def = this.context.definition;
		if (view.spec.seat !== def.name)
			throw new Error(`Activation names another seat: '${view.spec.seat}'.`);
		const rendered = renderActivation(view, def);
		const stream = this.context.stream;
		const agent = new Agent({
			streamFn: (model, context, options) => {
				activation.providerRequestStarted(context.messages);
				return stream(model, context, options);
			},
			initialState: {
				systemPrompt: rendered.systemPrompt,
				model: await this.context.model(def.model, def.name),
				thinkingLevel: 'off',
				tools: toolsFor(view, def, binding(activation, this.boundedRoom(cancelled))),
				messages: [],
			},
		});
		return { agent, context: rendered.context };
	}
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
