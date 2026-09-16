/**
 * A seat: one agent in one room, what wakes it, and the side of the wire
 * that runs its activations.
 *
 * A seat is the agent plus what the room knows about it while it is seated:
 * where its attention sits on the scale, and whether an activation of it is
 * live. The agent definition is a value and says none of that: the same
 * definition is the quiet corner in one room and the one who meets people in
 * another.
 *
 * Three things live here. The routing rule, because it is a fact about a
 * seat rather than about the room: every message has a reach, and a seat
 * wakes when its attention is at least that wide. The seat's own actor: it
 * takes a wake, claims the lease, reads the room's view, builds the Pi
 * `Agent` over it with the tool its purpose permits (`tools.ts`), runs it,
 * renews the lease while it runs, and releases the lease when it stops.
 * And the transport that puts every seat in the room's own process. What
 * the actor knows of the room, it learns through three calls (`wire.ts`).
 */

import type { SessionOpener } from '@ambionframework/journal/pi';
import type {
	Agent as PiAgent,
	Session as PiSession,
	StreamFn,
} from '@earendil-works/pi-agent-core';
import { Agent } from '@earendil-works/pi-agent-core';
import type { RunningRoom, Runtime, Transport } from '../host/runtime.ts';
import type { AgentDefinition, Clock, ModelResolver, RoomNotification } from '../types.ts';
import { seatSessionId } from '../types.ts';
import type { ActivationView, SeatPort, SeatRoom, Steer, Wake } from '../wire.ts';
import { Activation, persistTurns } from './activation.ts';
import { renderActivation, renderLine } from './render.ts';
import { binding, toolsFor } from './tools.ts';

// -- the actor ----------------------------------------------------------------

/** What a seat actor needs beside the room: its definition, the clock, and the model call. */
export interface SeatContext {
	readonly clock: Clock;
	/** How many times the seat sends one call to the room before it gives up. */
	readonly call: Runtime['call'];
	/** This seat's room-local definition. */
	readonly definition: AgentDefinition;
	readonly room: string;
	readonly seat: string;
	/** Where the seat's collision-safe audit session opens beside the room's. */
	readonly transcripts: SessionOpener;
	readonly stream: StreamFn;
	readonly model: ModelResolver;
	/** Where in-process events go. Absent across a process boundary. */
	readonly emit?: (event: RoomNotification) => void;
}

/** One activation the actor holds while it runs. */
interface Current {
	id: string;
	activation: Activation;
	/** The activation ran to its end, and its release is in flight. It takes no steer. */
	over: boolean;
	/** Resolves when the room ended the lease: the actor moves on, whatever the run still does. */
	cut: () => void;
	cutOff: Promise<void>;
}

/**
 * The seat's side of the wire. One actor per seat, for as long as the room
 * runs; one activation at a time, named by the wake that started it.
 */
export class SeatActor implements SeatPort {
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
		const activation = new Activation(id, this.context.seat, this.host(id));
		let cut = () => {};
		const cutOff = new Promise<void>((resolve) => {
			cut = resolve;
		});
		const current: Current = { id, activation, over: false, cut, cutOff };
		this.current = current;
		const claimed = await this.claim(id);
		if (claimed !== undefined) {
			const stopRenewing = this.renewUntil(current, claimed.expiresAt);
			try {
				// The cut ends the wait, and never the run: a run that ignores the
				// abort finishes on its own, past a seat that took its next wake.
				await Promise.race([activation.run(), cutOff]);
			} finally {
				stopRenewing();
				// Over, and holding the seat through the release: a wake that lands
				// now runs next, and never beside the activation that is releasing.
				current.over = true;
				await this.release(id, activation);
			}
		}
		this.current = undefined;
		await this.next();
	}

	/**
	 * One call to the room, sent again while it never comes back. A call the
	 * room answers is done, whatever it answers. A call that throws reached
	 * nobody, or its answer was lost, so the seat sends it again, up to the
	 * attempts the runtime names. `undefined` says every attempt was lost.
	 */
	private async calls<T>(send: () => Promise<T>): Promise<T | undefined> {
		for (let attempt = 0; attempt < this.context.call.attempts; attempt += 1) {
			try {
				return await send();
			} catch {
				// The call never came back: sent again.
			}
		}
		return undefined;
	}

	/**
	 * The lease, or nothing: the room refused it, or no attempt at the claim
	 * came back. A claim of an id the room already runs is a renewal, so one
	 * activation starts whichever call reached the room first.
	 */
	private async claim(id: string): Promise<{ expiresAt: number } | undefined> {
		const claimed = await this.calls(() => this.room.lease({ activation: id, operation: 'claim' }));
		return claimed === undefined || 'stale' in claimed ? undefined : claimed.ok;
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
		const { reason } = activation;
		await this.calls(() =>
			this.room.lease({
				activation: id,
				operation: 'release',
				reason,
				readThrough: activation.readThrough,
			}),
		);
	}

	/**
	 * One renewal: the new expiry, `stale` when the room refused it, or
	 * `lost` when it never reached the room.
	 */
	private async renew(activation: Activation): Promise<number | 'stale' | 'lost'> {
		try {
			const renewed = await this.room.lease({
				activation: activation.id,
				operation: 'renew',
				readThrough: activation.readThrough,
			});
			return 'stale' in renewed ? 'stale' : renewed.ok.expiresAt;
		} catch {
			return 'lost';
		}
	}

	/**
	 * Renew at half the expiry, for as long as the activation runs and the
	 * room renews it. A refused renewal cuts the activation now: its lease
	 * ended, so nothing it writes lands. A renewal that moves the expiry
	 * nowhere says the lease reached its deadline, and one that never
	 * reached the room leaves the lease to expire where it stands: the actor
	 * cuts the activation at that expiry, when the room expires the lease.
	 * The cancel stops the loop for good: a renewal in flight when the
	 * activation ends arms nothing when it comes back.
	 */
	private renewUntil(current: Current, firstExpiry: number): () => void {
		const clock = this.context.clock;
		let stopped = false;
		let cancel = () => {};
		const cut = () => {
			if (this.current === current) this.cutCurrent();
		};
		const schedule = (expiry: number) => {
			cancel = clock.alarm(clock.now() + (expiry - clock.now()) / 2, () => void again(expiry));
		};
		const again = async (held: number) => {
			const renewed = await this.renew(current.activation);
			if (stopped) return;
			if (renewed === 'stale') cut();
			else if (renewed === 'lost') cancel = clock.alarm(held, cut);
			else if (renewed <= held) cancel = clock.alarm(renewed, cut);
			else schedule(renewed);
		};
		schedule(firstExpiry);
		return () => {
			stopped = true;
			cancel();
		};
	}

	private host(id: string) {
		const { clock, room, seat, transcripts } = this.context;
		return {
			view: () => this.room.view(id),
			renew: (readThrough: number) =>
				this.room.lease({ activation: id, operation: 'renew', readThrough }),
			build: (view: ActivationView, activation: Activation) => this.build(view, activation),
			persist: (agent: PiAgent) => {
				const open = () => this.openAudit(transcripts, seatSessionId(room, seat), room);
				return persistTurns(open, agent, new Date(clock.now()).toISOString());
			},
			emit: (event: RoomNotification) => this.context.emit?.(event),
			now: () => clock.now(),
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
				tools: toolsFor(view, def, binding(activation, this.room)),
				messages: [],
			},
		});
		return { agent, context: rendered.context };
	}
}

// -- the transport ------------------------------------------------------------

/** Every seat is an actor in this process, holding the room directly. */
export function inProcessTransport(): Transport {
	return {
		connect(room: RunningRoom, seat, runtime) {
			const definition = room.definition(seat);
			if (definition === undefined)
				throw new Error(`Room '${room.name}' has no binding for '${seat}'.`);
			return new SeatActor(room, {
				clock: runtime.clock,
				call: runtime.call,
				definition,
				room: room.name,
				seat,
				transcripts: room.transcripts,
				stream: room.stream,
				model: room.model,
				emit: (event) => room.emit(event),
			});
		},
	};
}
