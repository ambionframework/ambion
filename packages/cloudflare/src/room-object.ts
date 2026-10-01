/**
 * The room as one Durable Object. The journal lives in the object's SQLite, the
 * alarm is the room's clock, and a seat is reached over RPC to the seat
 * object that `seatName` names. The name of the room is the name of the
 * object, so the object keeps no copy of it. The constructor resumes an
 * initialized room with the configured definitions unless the metadata
 * records an explicit stop.
 */

import { DurableObject } from 'cloudflare:workers';
import type {
	Attention,
	Clock,
	ExchangeRef,
	Message,
	ReadRoomOptions,
	Room,
	RoomRead,
	Runtime,
	Seq,
	Visit,
} from '@ambionframework/ambion';
import { defineHuman, readRoom, resumeRoom, startRoom } from '@ambionframework/ambion';
import type {
	CommitRequest,
	CommitResult,
	Execution,
	LeaseRequest,
	LeaseResponse,
	RoomProtocol,
	ViewResponse,
} from '@ambionframework/ambion/hosting';
import { runningRoom, visitOf } from '@ambionframework/ambion/hosting';
import type { JournalOpener } from '@ambionframework/journal';
import { configuredAgents, definitionOf, runtimeFor } from './configure.ts';
import type { SeatObject } from './seat-object.ts';
import { seatName } from './seat-object.ts';
import { type MetadataStore, type RoomMetadata, roomMetadata, sqlStorage } from './storage.ts';

export interface Env {
	ROOM: DurableObjectNamespace<RoomObject>;
	SEAT: DurableObjectNamespace<SeatObject>;
}

/** What `start` takes. The stub names the room, so the options carry no name. */
export interface StartOptions {
	summaryWriter?: string;
	definitions?: readonly string[];
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

/**
 * The room reaches a seat over RPC to the seat object named for it. The
 * execution has no kind, so it serves every seat. The seat object runs the
 * execution of its own host, and calls the room back over RPC.
 */
export function rpcExecution(env: Env): Execution {
	return {
		connector: () => ({
			connect(_room, request) {
				const stub = env.SEAT.get(env.SEAT.idFromName(seatName(request.room, request.seat)));
				return {
					wake: (wake) => stub.wake(wake),
					steer: (steer) => stub.steer(steer),
					cut: (activation) => stub.cut(activation),
				};
			},
		}),
	};
}

export class RoomObject extends DurableObject<Env> {
	private readonly runtime: Runtime;
	private readonly name: string;
	protected readonly metadata: MetadataStore<RoomMetadata>;
	protected readonly storage: JournalOpener;
	private room: Room | undefined;
	private starting: Promise<void> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const name = ctx.id.name;
		if (name === undefined) {
			throw new Error('A room object is reached by name: use idFromName.');
		}
		this.name = name;
		this.storage = sqlStorage(ctx);
		this.runtime = runtimeFor({
			storage: this.storage,
			clock: alarmClock(ctx),
			execution: rpcExecution(env),
		});
		this.metadata = roomMetadata(ctx);
		ctx.blockConcurrencyWhile(async () => {
			if (this.metadata.read().stopped === true) return;
			const recorded = await readRoom(name, { runtime: this.runtime, messages: false });
			if (!recorded.initialized) return;
			this.room = await resumeRoom(name, { runtime: this.runtime, agents: configuredAgents() });
		});
	}

	/** Start the room from names the worker configured. The composition lands on the journal. */
	async start(options: StartOptions): Promise<void> {
		if (this.room !== undefined) throw new Error(`Room '${this.room.name}' is running.`);
		this.metadata.change(() => ({ remove: ['stopped'] }));
		this.room = await startRoom({
			name: this.name,
			runtime: this.runtime,
			agents: (options.definitions ?? []).map(definitionOf),
			...(options.summaryWriter === undefined ? {} : { summaryWriter: options.summaryWriter }),
			...(options.seats === undefined ? {} : { seats: options.seats }),
			...(options.goal === undefined ? {} : { goal: options.goal }),
		});
		await this.room.read({ messages: false });
	}

	/** Start the configured room when its durable state has no live room. */
	async ensureStart(options: StartOptions): Promise<void> {
		if (this.room !== undefined) return;
		this.starting ??= this.start(options);
		try {
			await this.starting;
		} finally {
			this.starting = undefined;
		}
	}

	/** The room journal holds identity and presence. The object keeps no copy of either. */
	async visit(person: Person): Promise<void> {
		await this.running().visit(defineHuman(person));
	}

	/** The visit of a person whom the record holds present. A resumed room takes it from the record. */
	private presentVisit(name: string): Visit | undefined {
		return this.room === undefined ? undefined : visitOf(this.room, name);
	}

	async send(input: {
		from: string;
		to?: string;
		text: string;
		refs?: string[];
		key?: string;
	}): Promise<ExchangeRef> {
		const visit = this.presentVisit(input.from);
		if (visit === undefined) throw new Error(`'${input.from}' has not visited this room.`);
		const exchange = await visit.send({
			text: input.text,
			...(input.refs === undefined ? {} : { refs: input.refs }),
			...(input.to === undefined ? {} : { to: input.to }),
			...(input.key === undefined ? {} : { key: input.key }),
		});
		return exchangeRef(exchange);
	}

	/** A person who is not present has nothing to leave, so a repeated leave does nothing. */
	async leave(name: string): Promise<void> {
		await this.presentVisit(name)?.leave();
	}

	async seat(name: string, options?: { attention?: Attention }): Promise<void> {
		await this.running().seat(name, options);
	}

	async unseat(name: string): Promise<void> {
		await this.running().unseat(name);
	}

	async cancel(): Promise<void> {
		await this.running().cancel();
	}

	/** Dismiss one scheduled say by its seq. True when the room dismissed it now. */
	async dismiss(seq: Seq): Promise<boolean> {
		return await this.running().dismiss(seq);
	}

	/** Post a message as the system, as `Room.post` does. */
	async post(input: {
		to?: string;
		text: string;
		refs?: string[];
		key?: string;
	}): Promise<ExchangeRef> {
		return exchangeRef(await this.running().post(input));
	}

	async stop(): Promise<void> {
		const room = this.running();
		await room.stop();
		this.metadata.change(() => ({ patch: { stopped: true } }));
		this.room = undefined;
	}

	/** Read a detached coherent projection, including stopped records. */
	async read(options: Pick<ReadRoomOptions, 'messages'> = {}): Promise<RoomRead> {
		return readRoom(this.name, { ...options, runtime: this.runtime });
	}

	async exchange(from: Seq) {
		const snapshot = await this.read({ messages: false });
		const exchange = snapshot.exchanges.find((item) => item.from === from);
		return exchange === undefined ? undefined : exchangeRef(exchange);
	}

	async waitForClose(from: Seq): Promise<Message[]> {
		// This convenience waits for a live close. Use read() for a stopped record.
		const exchange = this.running().exchange(from);
		if (exchange === undefined) throw new Error(`Exchange '${from}' is not on the record.`);
		return exchange.waitForClose();
	}

	async waitForSummary(from: Seq) {
		// This convenience waits for a live summary. Use read() for a stopped record.
		const exchange = this.running().exchange(from);
		if (exchange === undefined) throw new Error(`Exchange '${from}' is not on the record.`);
		return exchange.waitForSummary();
	}

	// -- what a seat asks, in wire types --------------------------------------

	async view(activation: string, message?: Seq): Promise<ViewResponse> {
		return this.protocol().view(activation, message);
	}

	async commit(commit: CommitRequest): Promise<CommitResult> {
		return this.protocol().commit(commit);
	}

	async lease(lease: LeaseRequest): Promise<LeaseResponse> {
		return this.protocol().lease(lease);
	}

	/** The room's alarm is its clock: it folds, decides, writes and sends. */
	override async alarm(): Promise<void> {
		await this.room?.reconcile();
	}

	private running(): Room {
		if (this.room === undefined) throw new Error('The room is not started.');
		return this.room;
	}

	private protocol(): RoomProtocol {
		const room = runningRoom(this.runtime, this.running().name);
		if (room === undefined) throw new Error('The room is not running.');
		return room;
	}
}

/** The identity of an exchange that crosses the wire: its start, and its person once one spoke. */
function exchangeRef({ person, from, at }: ExchangeRef): ExchangeRef {
	return { ...(person === undefined ? {} : { person }), from, at };
}
