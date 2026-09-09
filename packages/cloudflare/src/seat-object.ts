/**
 * One seat as one Durable Object. A wake stores the activation id and sets
 * an alarm; the alarm claims the lease, reads the view, runs the activation
 * to its end and releases the lease, all inside one alarm handler. A wake
 * that arrives while an activation runs is handed to the actor, which
 * steers it in, and a cut is handed to it the same way. The seat's audit
 * session lives in the object's own SQLite.
 */

import { DurableObject } from 'cloudflare:workers';
import type { SeatRoom, Wake } from '@ambionframework/ambion';
import { SeatActor, systemClock } from '@ambionframework/ambion';
import { runtimeFor } from './configure.ts';
import type { Env } from './room-object.ts';
import { sqlSessions } from './storage.ts';

type Phase = 'pending' | 'running';

export class SeatObject extends DurableObject<Env> {
	private actor: SeatActor | undefined;

	/**
	 * A wake for the activation the object holds, or for a fresh one when it
	 * holds none, sets the alarm. A wake for a different activation while one
	 * runs goes to the actor, which steers a message in; while one is pending
	 * it is ignored, and the room sends it again.
	 */
	async wake(wake: Wake): Promise<void> {
		const held = await this.ctx.storage.get<string>('activation');
		if (held !== undefined && held !== wake.activation) {
			if (this.actor !== undefined) await this.actor.wake(wake);
			return;
		}
		const wakes = (await this.ctx.storage.get<number>('wakes')) ?? 0;
		await this.ctx.storage.put({
			room: wake.room,
			seat: wake.seat,
			activation: wake.activation,
			phase: (await this.ctx.storage.get<Phase>('phase')) ?? 'pending',
			wakes: wakes + 1,
		});
		if (!(await this.ctx.storage.get<boolean>('hold'))) await this.ctx.storage.setAlarm(Date.now());
	}

	/** The room ended this activation's lease: the actor stops it, when it runs here. */
	async cut(activation: string): Promise<void> {
		await this.actor?.cut(activation);
	}

	/**
	 * A seat on hold keeps the wakes it is sent and runs nothing: the room
	 * sends them again until the hold lifts, and the lift takes the one it
	 * holds. A host drains a seat this way before it moves it.
	 */
	async hold(on: boolean): Promise<void> {
		await this.ctx.storage.put('hold', on);
		if (!on && (await this.ctx.storage.get<string>('activation')) !== undefined) {
			await this.ctx.storage.setAlarm(Date.now());
		}
	}

	/** How many wakes this seat has taken. The tests read it. */
	async wakes(): Promise<number> {
		return (await this.ctx.storage.get<number>('wakes')) ?? 0;
	}

	override async alarm(): Promise<void> {
		const activation = await this.ctx.storage.get<string>('activation');
		const room = await this.ctx.storage.get<string>('room');
		const seat = await this.ctx.storage.get<string>('seat');
		if (activation === undefined || room === undefined || seat === undefined) return;
		const stub = this.env.ROOM.get(this.env.ROOM.idFromName(room));
		const seatRoom: SeatRoom = {
			view: (id) => stub.view(id),
			commit: (commit) => stub.commit(commit),
			lease: (lease) => stub.lease(lease),
		};
		if ((await this.ctx.storage.get<Phase>('phase')) === 'running') {
			// A run that never came back: the object was evicted mid-activation.
			await seatRoom.lease({ activation, phase: 'ended', reason: 'failed' });
			await this.clear();
			return;
		}
		await this.ctx.storage.put('phase', 'running');
		const runtime = runtimeFor({ sessions: sqlSessions(this.ctx), clock: systemClock() });
		this.actor = new SeatActor(seatRoom, {
			runtime,
			room,
			seat,
			sessions: runtime.sessions,
			stream: runtime.stream,
			model: runtime.model,
		});
		try {
			await this.actor.run(activation);
		} finally {
			this.actor = undefined;
			await this.clear();
		}
	}

	private async clear(): Promise<void> {
		await this.ctx.storage.delete(['activation', 'phase']);
	}
}
