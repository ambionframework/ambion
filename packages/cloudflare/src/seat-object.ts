/**
 * One seat as one Durable Object. A wake stores the activation id and sets
 * an alarm; the alarm claims the lease, reads the view, runs the activation
 * to its end and releases the lease, all inside one alarm handler. A wake
 * that arrives while an activation runs is handed to the runner to queue;
 * steering is forwarded separately to the exact live activation. A cut is
 * handed to the runner the same way. The seat gives the steps of each
 * activation to the logger that `configure` takes. The seat object runs the
 * execution of its own host: it connects the Pi execution once, and the
 * runner and its executor live on the object instance. The executor keeps
 * the seat's Pi harness sessions in a `MemorySessionRepo` there. A seat
 * continues its session inside one exchange while the object stays in
 * memory. An eviction loses the sessions, and the next activation starts
 * fresh.
 */

import { DurableObject } from 'cloudflare:workers';
import type { ActivationEvent } from '@ambionframework/ambion';
import type {
	AgentRunner,
	ExecutionHost,
	RoomProtocol,
	Steer,
	Wake,
} from '@ambionframework/ambion/hosting';
import type { SeatEvent } from './configure.ts';
import { definitionOf, seatEvent, seatExecution, seatHost } from './configure.ts';
import type { Env } from './room-object.ts';
import { seatMetadata } from './storage.ts';

/**
 * What a seat did, flattened for whoever the worker gave the events to.
 *
 * An activation runs inside the seat's object, and the events it raises reach
 * no other object: `emit` is a call in this process. So this line is the only
 * way a reader outside learns that a tool was called. `configure` decides
 * where it goes, and writes it to the logs when the worker says nothing.
 *
 * The core writes nothing to stdout, and the decision is a host's to make.
 */
function seatLine(room: string, seat: string, event: ActivationEvent): SeatEvent {
	return {
		ambion: 'seat',
		room,
		seat,
		activation: event.activation,
		event: event.type,
		...(event.type === 'delivery_error' ? { operation: event.operation } : {}),
		...('name' in event ? { tool: event.name } : {}),
		...('error' in event ? { error: event.error.message } : {}),
		at: new Date().toISOString(),
	};
}

/** The name of the seat object of one seat: its identity, from which the object reads its room and seat. */
export function seatName(room: string, seat: string): string {
	return JSON.stringify(['ambion/seat-object', room, seat]);
}

function seatOfName(name: string | undefined): { room: string; seat: string } {
	let parsed: unknown;
	try {
		parsed = name === undefined ? undefined : JSON.parse(name);
	} catch {
		parsed = undefined;
	}
	if (Array.isArray(parsed) && parsed.length === 3 && parsed[0] === 'ambion/seat-object') {
		const [, room, seat] = parsed;
		if (typeof room === 'string' && typeof seat === 'string') return { room, seat };
	}
	throw new Error('A seat object is reached by the name that seatName gives.');
}

export class SeatObject extends DurableObject<Env> {
	/** The runner of the activation that runs in this object now. */
	private runner: AgentRunner | undefined;
	/** The port of the seat and its executor, connected once while the object stays in memory. */
	private port: { readonly key: string; readonly runner: AgentRunner } | undefined;
	/** The host of the seat: its clock, its limits, and its logger. */
	private host: ExecutionHost | undefined;
	/** Whether an alarm runs in this object now. */
	private alarming = false;
	private readonly metadata;
	/** The room and the seat this object serves, from its name. */
	private readonly identity: { room: string; seat: string };

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.identity = seatOfName(ctx.id.name);
		this.metadata = seatMetadata(ctx);
	}

	/**
	 * A wake for the activation the object holds, or for a fresh one when it
	 * holds none, sets the alarm. A wake for a different activation while one
	 * runs is queued by the runner.
	 */
	async wake(wake: Wake): Promise<void> {
		const next = this.metadata.change((current) =>
			current.activation !== undefined && current.activation !== wake.activation
				? undefined
				: {
						patch: {
							activation: wake.activation,
							phase: current.phase ?? 'pending',
						},
					},
		);
		if (next.activation !== wake.activation) {
			if (this.runner !== undefined) await this.runner.wake(wake);
			return;
		}
		if (!next.hold) await this.ctx.storage.setAlarm(Date.now());
	}

	/** Forward steering to a live runner without changing durable wake state. */
	async steer(steer: Steer): Promise<void> {
		await this.runner?.steer(steer);
	}

	/**
	 * The room ended this activation's lease: the runner stops it, when it runs
	 * here. A cut for an activation this object holds but has not started
	 * reaches no runner, and the alarm that starts it is refused its claim.
	 */
	async cut(activation: string): Promise<void> {
		await this.runner?.cut(activation);
	}

	/**
	 * A seat on hold keeps the wakes it is sent and runs nothing: the room
	 * sends them again until the hold lifts, and the lift takes the one it
	 * holds. A host drains a seat this way before it moves it.
	 */
	async hold(on: boolean): Promise<void> {
		const next = this.metadata.change(() => ({ patch: { hold: on } }));
		if (!on && next.activation !== undefined) {
			await this.ctx.storage.setAlarm(Date.now());
		}
	}

	/**
	 * Run the activation this seat holds. A second call while a run is live
	 * in this object returns at once: the live run owns the activation. The
	 * flag lives in memory, so an object that was evicted mid-activation has
	 * none, and its next alarm releases the run that never came back.
	 */
	override async alarm(): Promise<void> {
		if (this.alarming) return;
		this.alarming = true;
		try {
			await this.runHeld();
		} finally {
			this.alarming = false;
		}
	}

	private async runHeld(): Promise<void> {
		const state = this.metadata.read();
		const { activation } = state;
		if (activation === undefined) return;
		const { room, seat } = this.identity;
		if (state.phase === 'running') {
			// A run that never came back: the object was evicted mid-activation.
			// The runner of the seat releases it as failed.
			try {
				await this.portOf(room, seat).recover(activation);
			} finally {
				await this.clear(activation);
			}
			return;
		}
		this.metadata.change(() => ({ patch: { phase: 'running' } }));
		this.runner = this.portOf(room, seat);
		try {
			await this.runner.run(activation);
		} finally {
			this.runner = undefined;
			await this.clear(activation);
		}
	}

	/** The host of the seat, built once while the object stays in memory. */
	private hostOf(): ExecutionHost {
		this.host ??= seatHost();
		return this.host;
	}

	/**
	 * The port of the seat: the one this object holds, or one that the
	 * execution of this host connects. The execution builds the executor once
	 * for each connect.
	 */
	private portOf(room: string, seat: string): AgentRunner {
		const key = JSON.stringify([room, seat]);
		if (this.port?.key === key) return this.port.runner;
		const calls: RoomProtocol = {
			view: (id, message) => this.roomFor(room).view(id, message),
			commit: (commit) => this.roomFor(room).commit(commit),
			lease: (lease) => this.roomFor(room).lease(lease),
		};
		const runner = seatExecution()
			.connector(this.hostOf())
			.connect(calls, {
				room,
				seat,
				definition: definitionOf(seat),
				emit: (event: ActivationEvent) => seatEvent(seatLine(room, seat, event)),
			});
		this.port = { key, runner };
		return runner;
	}

	/** The three calls this seat makes on its room, each over a stub of its own. */
	private roomFor(room: string): RoomProtocol {
		return {
			view: (id, message) => this.roomStub(room).view(id, message),
			commit: (commit) => this.roomStub(room).commit(commit),
			lease: (lease) => this.roomStub(room).lease(lease),
		};
	}

	/**
	 * A stub for the room, taken for one call. A stub dies with the object it
	 * names, so an activation that held one across an eviction lost the room
	 * and wrote nothing: the commit threw, the release threw after it, and the
	 * lease it holds sat live until it expired. A stub taken per call reaches
	 * the room that holds the name now, and builds it again when none does.
	 */
	private roomStub(room: string) {
		return this.env.ROOM.get(this.env.ROOM.idFromName(room));
	}

	private async clear(activation: string): Promise<void> {
		this.metadata.change((current) =>
			current.activation === activation ? { remove: ['activation', 'phase'] } : undefined,
		);
	}
}
