/**
 * The room as one Durable Object. The log lives in the object's SQLite, the
 * alarm is the room's clock, and a seat is reached over RPC to the seat
 * object named `<room>:<seat>`. The constructor resumes the room the
 * storage names, so an evicted room comes back where it stopped.
 */

import { DurableObject } from 'cloudflare:workers';
import type {
	Attention,
	Clock,
	Commit,
	CommitResponse,
	Lease,
	LeaseResponse,
	Message,
	RunningRoom,
	Runtime,
	SeatInfo,
	Seq,
	Session,
	Transport,
	ViewResponse,
	Visit,
} from '@ambionframework/ambion';
import {
	defineHuman,
	resumeSession,
	seated,
	startSession,
	stopSession,
	visitSession,
} from '@ambionframework/ambion';
import { definitionOf, runtimeFor } from './configure.ts';
import type { SeatObject } from './seat-object.ts';
import { sqlSessions } from './storage.ts';

export interface Env {
	ROOM: DurableObjectNamespace<RoomObject>;
	SEAT: DurableObjectNamespace<SeatObject>;
}

/** One seat in a composition, by name. */
export type SeatSpec = string | { name: string; attention: Attention };

export interface StartOptions {
	name: string;
	assistant: string;
	agents?: SeatSpec[];
	available?: SeatSpec[];
	goal?: string;
}

export interface Person {
	name: string;
	identity: string;
	preferences?: string;
}

/** The clock over the object's alarm. The alarm handler runs `reconcile`, so `fire` is never held. */
/**
 * The object's alarm as the room's clock. An object holds one alarm, so the
 * cancel deletes whatever stands: the room arms one alarm at a time, and it
 * cancels the one it holds before it arms the next. A second caller in this
 * object would take the first one's alarm away.
 */
function alarmClock(state: DurableObjectState): Clock {
	return {
		now: () => Date.now(),
		alarm(at) {
			void state.storage.setAlarm(at);
			return () => void state.storage.deleteAlarm();
		},
	};
}

/** The room reaches a seat over RPC to the seat object named for it. */
function rpcTransport(env: Env): Transport {
	return {
		connect(room, seat) {
			const stub = env.SEAT.get(env.SEAT.idFromName(`${room.name}:${seat}`));
			return { wake: (wake) => stub.wake(wake), cut: (activation) => stub.cut(activation) };
		},
	};
}

export class RoomObject extends DurableObject<Env> {
	private readonly runtime: Runtime;
	private room: Session | undefined;
	private readonly visits = new Map<string, Visit>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.runtime = runtimeFor({
			sessions: sqlSessions(ctx),
			clock: alarmClock(ctx),
			transport: rpcTransport(env),
		});
		ctx.blockConcurrencyWhile(async () => {
			const name = await ctx.storage.get<string>('name');
			if (name !== undefined) this.room = await resumeSession(name, { runtime: this.runtime });
		});
	}

	/** Start the room from names the worker configured. The composition lands on the log. */
	async start(options: StartOptions): Promise<void> {
		if (this.room !== undefined) throw new Error(`Room '${this.room.name}' is running.`);
		await this.ctx.storage.put('name', options.name);
		this.room = startSession({
			name: options.name,
			runtime: this.runtime,
			assistant: definitionOf(options.assistant),
			agents: (options.agents ?? []).map(placed),
			available: (options.available ?? []).map(placed),
			...(options.goal === undefined ? {} : { goal: options.goal }),
		});
		await this.room.messages();
	}

	async visit(person: Person): Promise<void> {
		await this.ctx.storage.put(`person:${person.name}`, person);
		await this.visitOf(person.name);
	}

	/** The handle a person delivers through. A room that came back holds none, and visits again: presence folds. */
	private async visitOf(name: string): Promise<Visit> {
		const known = this.visits.get(name);
		if (known !== undefined) return known;
		const person = await this.ctx.storage.get<Person>(`person:${name}`);
		if (person === undefined) throw new Error(`'${name}' has not visited this room.`);
		const visit = await visitSession(this.running(), defineHuman(person));
		this.visits.set(name, visit);
		return visit;
	}

	async deliver(input: { from: string; to?: string; text: string; key?: string }): Promise<void> {
		const visit = await this.visitOf(input.from);
		const to = input.to === undefined ? undefined : this.participant(input.to);
		await visit.deliver({
			text: input.text,
			...(to ? { to } : {}),
			...(input.key ? { key: input.key } : {}),
		});
	}

	private participant(name: string) {
		const seat = this.running()
			.seats()
			.find((s) => s.name === name);
		if (seat?.kind === 'human') {
			return defineHuman({ name: seat.name, identity: seat.identity });
		}
		return definitionOf(name);
	}

	async leave(name: string): Promise<void> {
		const visit = await this.visitOf(name);
		await visit.leave();
		this.visits.delete(name);
	}

	async seat(spec: SeatSpec): Promise<void> {
		await this.running().seat(placed(spec));
	}

	async unseat(name: string): Promise<void> {
		await this.running().unseat(definitionOf(name));
	}

	async abort(): Promise<void> {
		this.running().abort();
	}

	async stop(): Promise<void> {
		await stopSession(this.running());
		this.room = undefined;
		this.visits.clear();
		await this.ctx.storage.delete('name');
	}

	async messages(since?: Seq): Promise<Message[]> {
		return this.running().messages(since === undefined ? {} : { since });
	}

	async seats(): Promise<SeatInfo[]> {
		return this.running().seats();
	}

	async exchange() {
		return this.running().exchange();
	}

	// -- what a seat asks, in wire types --------------------------------------

	async view(activation: string): Promise<ViewResponse> {
		return this.seatRoom().view(activation);
	}

	async commit(commit: Commit): Promise<CommitResponse> {
		return this.seatRoom().commit(commit);
	}

	async lease(lease: Lease): Promise<LeaseResponse> {
		return this.seatRoom().lease(lease);
	}

	/** The room's alarm is its clock: it folds, decides, writes and sends. */
	override async alarm(): Promise<void> {
		await this.room?.reconcile();
	}

	private running(): Session {
		if (this.room === undefined) throw new Error('The room is not started.');
		return this.room;
	}

	private seatRoom(): RunningRoom {
		const room = this.runtime.running.get(this.running().name);
		if (room === undefined) throw new Error('The room is not running.');
		return room;
	}
}

function placed(spec: SeatSpec) {
	return typeof spec === 'string'
		? definitionOf(spec)
		: seated(definitionOf(spec.name), spec.attention);
}
