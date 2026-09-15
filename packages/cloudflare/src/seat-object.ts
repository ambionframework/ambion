/**
 * One seat as one Durable Object. A wake stores the activation id and sets
 * an alarm; the alarm claims the lease, reads the view, runs the activation
 * to its end and releases the lease, all inside one alarm handler. A wake
 * that arrives while an activation runs is handed to the actor, which
 * steers it in, and a cut is handed to it the same way. The seat's audit
 * session lives in the object's own SQLite.
 */

import { DurableObject } from 'cloudflare:workers';
import type { SessionEvent } from '@ambionframework/ambion';
import { systemClock } from '@ambionframework/ambion';
import type { SeatRoom, Wake } from '@ambionframework/ambion/transport';
import { SeatActor } from '@ambionframework/ambion/transport';
import type { SeatEvent } from './configure.ts';
import { definitionOf, runtimeFor, seatEvent } from './configure.ts';
import type { Env } from './room-object.ts';
import { seatMetadata, sqlStorage } from './storage.ts';

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
function seatLine(room: string, seat: string, activation: string, event: SessionEvent): SeatEvent {
	return {
		ambion: 'seat',
		room,
		seat,
		activation,
		event: event.type,
		...('toolName' in event ? { tool: event.toolName } : {}),
		...(event.type === 'error' ? { error: event.error.message } : {}),
		at: new Date().toISOString(),
	};
}

export class SeatObject extends DurableObject<Env> {
	private actor: SeatActor | undefined;
	private readonly metadata;
	private readonly storage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.storage = sqlStorage(ctx);
		this.metadata = seatMetadata(this.storage);
	}

	/**
	 * A wake for the activation the object holds, or for a fresh one when it
	 * holds none, sets the alarm. A wake for a different activation while one
	 * runs goes to the actor, which steers a message in; while one is pending
	 * it is ignored, and the room sends it again.
	 */
	async wake(wake: Wake): Promise<void> {
		const next = await this.metadata.change((current) =>
			current.activation !== undefined && current.activation !== wake.activation
				? undefined
				: {
						patch: {
							room: wake.room,
							seat: wake.seat,
							activation: wake.activation,
							phase: current.phase ?? 'pending',
							wakes: (current.wakes ?? 0) + 1,
						},
					},
		);
		if (next.activation !== wake.activation) {
			if (this.actor !== undefined) await this.actor.wake(wake);
			return;
		}
		if (!next.hold) await this.ctx.storage.setAlarm(Date.now());
	}

	/**
	 * The room ended this activation's lease: the actor stops it, when it runs
	 * here. A cut for an activation this object holds but has not started
	 * reaches no actor, and the alarm that starts it is refused its claim.
	 */
	async cut(activation: string): Promise<void> {
		await this.metadata.change((current) => ({ patch: { cuts: (current.cuts ?? 0) + 1 } }));
		await this.actor?.cut(activation);
	}

	/**
	 * A seat on hold keeps the wakes it is sent and runs nothing: the room
	 * sends them again until the hold lifts, and the lift takes the one it
	 * holds. A host drains a seat this way before it moves it.
	 */
	async hold(on: boolean): Promise<void> {
		const next = await this.metadata.change(() => ({ patch: { hold: on } }));
		if (!on && next.activation !== undefined) {
			await this.ctx.storage.setAlarm(Date.now());
		}
	}

	/** How many wakes this seat has taken. The tests read it. */
	async wakes(): Promise<number> {
		return (await this.metadata.read()).wakes ?? 0;
	}

	/** How many cuts the room has sent this seat. The tests read it. */
	async cuts(): Promise<number> {
		return (await this.metadata.read()).cuts ?? 0;
	}

	override async alarm(): Promise<void> {
		const state = await this.metadata.read();
		const { activation, room, seat } = state;
		if (activation === undefined || room === undefined || seat === undefined) return;
		const seatRoom = this.roomFor(room);
		if (state.phase === 'running') {
			// A run that never came back: the object was evicted mid-activation.
			await seatRoom.lease({ activation, operation: 'release', reason: 'failed', readThrough: 0 });
			await this.clear();
			return;
		}
		await this.metadata.change(() => ({ patch: { phase: 'running' } }));
		const runtime = runtimeFor({
			storage: this.storage,
			clock: systemClock(),
		});
		this.actor = new SeatActor(seatRoom, {
			clock: runtime.clock,
			call: runtime.call,
			definition: definitionOf(seat),
			room,
			seat,
			transcripts: runtime.transcripts,
			stream: runtime.stream,
			model: runtime.model,
			emit: (event) => seatEvent(seatLine(room, seat, activation, event)),
		});
		try {
			await this.actor.run(activation);
		} finally {
			this.actor = undefined;
			await this.clear();
		}
	}

	/** The three calls this seat makes on its room, each over a stub of its own. */
	private roomFor(room: string): SeatRoom {
		return {
			view: (id) => this.roomStub(room).view(id),
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

	private async clear(): Promise<void> {
		await this.metadata.change(() => ({ remove: ['activation', 'phase'] }));
	}
}
