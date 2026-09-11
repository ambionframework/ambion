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
 * `Agent` over it with the hands the view names (`hands.ts`), runs it,
 * renews the lease while it runs, and releases the lease when it stops.
 * And the transport that puts every seat in the room's own process. What
 * the actor knows of the room, it learns through three calls (`wire.ts`).
 */
import type {
	Agent as PiAgent,
	Session as PiSession,
	StreamFn,
} from '@earendil-works/pi-agent-core';
import { Agent } from '@earendil-works/pi-agent-core';
import type { RunningRoom, Transport } from '../host/runtime.ts';
import type {
	AgentDefinition,
	Attention,
	Clock,
	Message,
	ModelResolver,
	SessionEvent,
	SessionOpener,
} from '../types.ts';
import { isClosed, isSpoken } from '../types.ts';
import type { ActivationView, SeatPort, SeatRoom, Wake } from '../wire.ts';
import { Activation, persistTurns } from './activation.ts';
import { hands, handsFor } from './hands.ts';

// -- routing -----------------------------------------------------------------

/** The attention scale, narrowest first. A seat hears what it is wide enough for. */
const WIDTH: Record<Attention, number> = { none: 0, named: 1, broadcast: 2, presence: 3 };

/**
 * How wide a seat's attention has to be for this message to reach it: a
 * directed say reaches the one it names, anything else said reaches the room,
 * and a person arriving or leaving reaches the widest end.
 */
function reachOf(message: Message): Attention {
	if (!isSpoken(message)) return 'presence';
	return message.to === undefined ? 'broadcast' : 'named';
}

/**
 * One rule, read off the scale, in three lines. A seat the message names wakes,
 * however narrowly it is seated: a directed say names the one it addresses, and
 * a seating names the seat it seats. Everybody else wakes when their attention
 * is at least as wide as the message's reach — and a directed say reaches
 * nobody else at all. Rule 1 routes, rule 6 decides who sits out, and a
 * presence message is routed like any other.
 */
export function wakes(
	seat: { name: string; attention: Attention },
	target: string | undefined,
	message: Message,
	fromAssistant: boolean,
): boolean {
	// The room's own close asks a participant nothing. It reaches the assistant
	// the room names on it, and no seat by attention.
	if (isClosed(message)) return false;
	// Nothing the assistant writes wakes anybody, with one exception written
	// into the line: a seating it committed wakes the seat it names. That is the
	// one activation the assistant can cause. The guard is on the author rather
	// than on what it wrote, so it holds for anything else it ever writes, and
	// every seat still reads it.
	if (fromAssistant) return message.kind === 'seated' && seat.name === target;
	if (seat.name === target) return true;
	const reach = reachOf(message);
	if (WIDTH[seat.attention] < WIDTH[reach]) return false;
	return reach !== 'named';
}

// -- the actor ----------------------------------------------------------------

/** What a seat actor needs beside the room: the clock, the catalog, and the model call the room chose. */
export interface SeatContext {
	readonly clock: Clock;
	/** Every definition the seat side resolves by name. */
	readonly catalog: ReadonlyMap<string, AgentDefinition>;
	readonly room: string;
	readonly seat: string;
	/** Where the seat's audit session opens, `<room>:<seat>`, beside the room's. */
	readonly sessions: SessionOpener;
	readonly stream: StreamFn;
	readonly model: ModelResolver;
	/** Where in-process events go. Absent across a process boundary. */
	readonly emit?: (event: SessionEvent) => void;
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
	private current: Current | undefined;
	/** The wakes that arrived while an activation ran, in order. They run next, once each. */
	private readonly queued: string[] = [];
	private audit: Promise<PiSession> | undefined;

	constructor(
		private readonly room: SeatRoom,
		private readonly context: SeatContext,
	) {}

	/**
	 * A wake starts an activation when none runs. While one runs, a wake a
	 * message caused is steered into it (rule 2), and any other wake runs
	 * next. An activation that is over takes no steer: it reads nothing
	 * more, so what landed runs as an activation of its own.
	 */
	async wake(wake: Wake): Promise<void> {
		if (this.current === undefined) {
			void this.run(wake.activation);
			return;
		}
		if (this.current.id === wake.activation) return;
		if (wake.steer === undefined || this.current.over) {
			this.enqueue(wake.activation);
			return;
		}
		this.current.activation.steer(wake.steer.seq, wake.steer.line);
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
		// flight reaches the activation and not the floor.
		const activation = new Activation(id, this.context.seat, this.host(id));
		let cut = () => {};
		const cutOff = new Promise<void>((resolve) => {
			cut = resolve;
		});
		const current: Current = { id, activation, over: false, cut, cutOff };
		this.current = current;
		const claimed = await this.claim(id);
		if (claimed !== undefined) {
			const stopRenewing = this.renewUntil(current, claimed.expiry);
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
	 * The lease, or nothing: the room refused it, or the claim never came
	 * back twice. A claim the seat never heard back on is asked again once:
	 * a claim of an id the room already runs is a renewal, so one activation
	 * starts whichever call reached the room first.
	 */
	private async claim(id: string): Promise<{ expiry: number } | undefined> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const claimed = await this.room.lease({ activation: id, phase: 'running' });
				return 'stale' in claimed ? undefined : claimed.ok;
			} catch {
				// The claim never came back: asked again, once.
			}
		}
		return undefined;
	}

	/** The next wake that queued, to its end. */
	private async next(): Promise<void> {
		const queued = this.queued.shift();
		if (queued !== undefined) await this.take(queued);
	}

	/**
	 * The lease is released, however the activation went. A release the seat
	 * never heard back on is asked again once; a lease that ended answers
	 * stale, and that is fine. A release lost twice leaves the room to end
	 * the lease on its side.
	 */
	private async release(id: string, activation: Activation): Promise<void> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				await this.room.lease({ activation: id, phase: 'ended', reason: activation.reason });
				return;
			} catch {
				// The release never came back: asked again, once.
			}
		}
	}

	/**
	 * One renewal: the new expiry, `stale` when the room refused it, or
	 * `lost` when it never reached the room.
	 */
	private async renew(activation: Activation): Promise<number | 'stale' | 'lost'> {
		try {
			const renewed = await this.room.lease({ activation: activation.id, phase: 'running' });
			return 'stale' in renewed ? 'stale' : renewed.ok.expiry;
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
		const { clock, room, seat, sessions } = this.context;
		return {
			view: () => this.room.view(id),
			renew: () => this.room.lease({ activation: id, phase: 'running' }),
			build: (view: ActivationView, activation: Activation) => this.build(view, activation),
			persist: (agent: PiAgent) => {
				this.audit ??= sessions.open(`${room}:${seat}`, room);
				return persistTurns(this.audit, agent, new Date(clock.now()).toISOString());
			},
			emit: (event: SessionEvent) => this.context.emit?.(event),
			now: () => clock.now(),
		};
	}

	/**
	 * The model over the view: the prompt the room rendered, the model the
	 * definition names, the hands. The stream function tells the activation
	 * when the model is asked, so a steer never joins the request it lands during.
	 */
	private build(view: ActivationView, activation: Activation): PiAgent {
		const def = this.context.catalog.get(view.seat);
		if (def === undefined) throw new Error(`'${view.seat}' is not in the runtime's catalog.`);
		const stream = this.context.stream;
		return new Agent({
			streamFn: (model, context, options) => {
				activation.asked();
				return stream(model, context, options);
			},
			initialState: {
				systemPrompt: view.systemPrompt,
				model: this.context.model(view.model, def.name),
				thinkingLevel: 'off',
				tools: handsFor(view, def, hands(activation, this.room)),
				messages: [],
			},
		});
	}
}

// -- the transport ------------------------------------------------------------

/** Every seat is an actor in this process, holding the room directly. */
export function inProcessTransport(): Transport {
	return {
		connect(room: RunningRoom, seat, runtime) {
			return new SeatActor(room, {
				clock: runtime.clock,
				catalog: runtime.catalog,
				room: room.name,
				seat,
				sessions: room.sessions,
				stream: room.stream,
				model: room.model,
				emit: (event) => room.emit(event),
			});
		},
	};
}
