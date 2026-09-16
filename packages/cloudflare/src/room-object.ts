/**
 * The room as one Durable Object. The journal lives in the object's SQLite, the
 * alarm is the room's clock, and a seat is reached over RPC to the seat
 * object named `<room>:<seat>`. The constructor resumes the room the
 * storage names, so an evicted room comes back where it stopped.
 */

import { DurableObject } from 'cloudflare:workers';
import type {
	Attention,
	Clock,
	Exchange,
	Message,
	Room,
	Runtime,
	SeatInfo,
	Seq,
	Visit,
} from '@ambionframework/ambion';
import { defineHuman, resumeRoom, startRoom } from '@ambionframework/ambion';
import type {
	CommitRequest,
	CommitResult,
	LeaseRequest,
	LeaseResponse,
	RunningRoom,
	Transport,
	ViewResponse,
} from '@ambionframework/ambion/transport';
import { runningRoom } from '@ambionframework/ambion/transport';
import type { JournalOpener } from '@ambionframework/journal';
import { definitionOf, runtimeFor } from './configure.ts';
import type { SeatObject } from './seat-object.ts';
import { type MetadataStore, type RoomMetadata, roomMetadata, sqlStorage } from './storage.ts';

export interface Env {
	ROOM: DurableObjectNamespace<RoomObject>;
	SEAT: DurableObjectNamespace<SeatObject>;
}

export interface StartOptions {
	name: string;
	assistant?: string;
	agents?: readonly string[];
	seats?: Record<string, Attention>;
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
			const stub = env.SEAT.get(
				env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', room.name, seat])),
			);
			return {
				wake: (wake) => stub.wake(wake),
				steer: (steer) => stub.steer(steer),
				cut: (activation) => stub.cut(activation),
			};
		},
	};
}

export class RoomObject extends DurableObject<Env> {
	private readonly runtime: Runtime;
	protected readonly metadata: MetadataStore<RoomMetadata>;
	protected readonly storage: JournalOpener;
	private room: Room | undefined;
	private readonly visits = new Map<string, Visit>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.storage = sqlStorage(ctx);
		this.runtime = runtimeFor({
			storage: this.storage,
			clock: alarmClock(ctx),
			transport: rpcTransport(env),
		});
		this.metadata = roomMetadata(this.storage);
		ctx.blockConcurrencyWhile(async () => {
			const { name, agents } = await this.metadata.read();
			if (name !== undefined) {
				if (agents === undefined) throw new Error(`Room '${name}' has no catalog in its metadata.`);
				this.room = await resumeRoom(name, {
					runtime: this.runtime,
					agents: agents.map(definitionOf),
				});
			}
		});
	}

	/** Start the room from names the worker configured. The composition lands on the journal. */
	async start(options: StartOptions): Promise<void> {
		if (this.room !== undefined) throw new Error(`Room '${this.room.name}' is running.`);
		await this.metadata.change(() => ({
			patch: {
				name: options.name,
				agents: [
					...(options.agents ?? []),
					...(options.assistant === undefined ? [] : [options.assistant]),
				],
			},
		}));
		this.room = await startRoom({
			name: options.name,
			runtime: this.runtime,
			agents: (options.agents ?? []).map(definitionOf),
			...(options.assistant === undefined ? {} : { assistant: definitionOf(options.assistant) }),
			...(options.seats === undefined ? {} : { seats: options.seats }),
			...(options.goal === undefined ? {} : { goal: options.goal }),
		});
		await this.room.messages();
	}

	async visit(person: Person): Promise<void> {
		await this.metadata.change((current) => ({
			patch: { people: { ...current.people, [person.name]: person } },
		}));
		await this.visitOf(person.name);
	}

	/** The live visit for a person. A resumed room reconstructs it from durable presence. */
	private async visitOf(name: string): Promise<Visit> {
		const known = this.visits.get(name);
		if (known !== undefined) return known;
		const people = (await this.metadata.read()).people;
		const person =
			people !== undefined && Object.hasOwn(people, name) ? (people[name] as Person) : undefined;
		if (person === undefined) throw new Error(`'${name}' has not visited this room.`);
		const visit = await this.running().visit(defineHuman(person));
		this.visits.set(name, visit);
		return visit;
	}

	async send(input: { from: string; to?: string; text: string; key?: string }): Promise<Exchange> {
		const visit = await this.visitOf(input.from);
		const exchange = await visit.send({
			text: input.text,
			...(input.to === undefined ? {} : { to: input.to }),
			...(input.key ? { key: input.key } : {}),
		});
		return { owner: exchange.owner, from: exchange.from, at: exchange.at };
	}

	async leave(name: string): Promise<void> {
		const visit = await this.visitOf(name);
		await visit.leave();
		this.visits.delete(name);
	}

	async seat(name: string, options?: { attention?: Attention }): Promise<void> {
		await this.running().seat(name, options);
	}

	async unseat(name: string): Promise<void> {
		await this.running().unseat(name);
	}

	async abort(): Promise<void> {
		this.running().abort();
	}

	async stop(): Promise<void> {
		await this.running().stop();
		this.room = undefined;
		this.visits.clear();
		await this.metadata.change(() => ({ remove: ['name'] }));
	}

	async messages(since?: Seq): Promise<Message[]> {
		return this.running().messages(since === undefined ? {} : { since });
	}

	async participants(): Promise<SeatInfo[]> {
		return this.running().participants();
	}

	async exchange(from: Seq) {
		const exchange = this.running().exchange(from);
		return exchange === undefined
			? undefined
			: { owner: exchange.owner, from: exchange.from, at: exchange.at };
	}

	async exchangeMessages(from: Seq): Promise<Message[]> {
		const exchange = this.running().exchange(from);
		if (exchange === undefined) throw new Error(`Exchange '${from}' is not on the record.`);
		return exchange.messages();
	}

	async response(from: Seq) {
		const exchange = this.running().exchange(from);
		if (exchange === undefined) throw new Error(`Exchange '${from}' is not on the record.`);
		return exchange.response();
	}

	// -- what a seat asks, in wire types --------------------------------------

	async view(activation: string): Promise<ViewResponse> {
		return this.seatRoom().view(activation);
	}

	async commit(commit: CommitRequest): Promise<CommitResult> {
		return this.seatRoom().commit(commit);
	}

	async lease(lease: LeaseRequest): Promise<LeaseResponse> {
		return this.seatRoom().lease(lease);
	}

	/** The room's alarm is its clock: it folds, decides, writes and sends. */
	override async alarm(): Promise<void> {
		await this.room?.reconcile();
	}

	private running(): Room {
		if (this.room === undefined) throw new Error('The room is not started.');
		return this.room;
	}

	private seatRoom(): RunningRoom {
		const room = runningRoom(this.runtime, this.running().name);
		if (room === undefined) throw new Error('The room is not running.');
		return room;
	}
}
