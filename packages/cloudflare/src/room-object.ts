/**
 * The room as one Durable Object. The journal lives in the object's SQLite, the
 * alarm is the room's clock, and a seat is reached over RPC to the seat
 * object named `<room>:<seat>`. The constructor resumes an initialized room
 * unless durable metadata records an explicit stop.
 */

import { DurableObject } from 'cloudflare:workers';
import type {
	Attention,
	ExchangeRef,
	ExchangeView,
	Message,
	ParticipantInfo,
	ReadRoomOptions,
	Room,
	RoomSnapshot,
	Runtime,
	Seq,
	Visit,
} from '@ambionframework/ambion';
import { defineHuman, readRoom, resumeRoom, startRoom } from '@ambionframework/ambion';
import type {
	CommitRequest,
	CommitResult,
	LeaseRequest,
	LeaseResponse,
	SeatContext,
	SeatRoom,
	TaskCreateRequest,
	TaskSayRequest,
	TaskSeatRoom,
	TaskUpdateRequest,
	Transport,
	ViewResponse,
} from '@ambionframework/ambion/transport';
import { runningRoom } from '@ambionframework/ambion/transport';
import type { JournalOpener } from '@ambionframework/journal';
import { definitionOf, runtimeFor } from './configure.ts';
import { RoomClock } from './room-clock.ts';
import type { SeatObject } from './seat-object.ts';
import { type MetadataStore, type RoomMetadata, roomMetadata, sqlStorage } from './storage.ts';

export interface Env {
	ROOM: DurableObjectNamespace<RoomObject>;
	SEAT: DurableObjectNamespace<SeatObject>;
}

export interface StartOptions {
	name: string;
	summary?: string;
	agents?: readonly string[];
	seats?: Record<string, Attention>;
	goal?: string;
}

export interface RoomStatus {
	name: string;
	initialized: boolean;
	goal?: string;
	participants: ParticipantInfo[];
	exchanges: readonly ExchangeView[];
	exchange: ExchangeView | undefined;
	watermark: Seq;
	exchangeState: 'idle' | 'working' | 'completed';
}

export interface Person {
	name: string;
	identity: string;
	preferences?: string;
}

/** The room reaches a seat over RPC to the seat object named for it. */
function rpcTransport(env: Env): Transport {
	return {
		connect(_room, context: SeatContext) {
			const { room: roomName, seat } = context;
			const stub = env.SEAT.get(
				env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', roomName, seat])),
			);
			return {
				wake: (wake) => stub.wake({ ...wake, hostRoom: context.hostRoom ?? roomName }),
				steer: (steer) => stub.steer(steer),
				cut: (activation) => stub.cut(activation),
			};
		},
	};
}

export class RoomObject extends DurableObject<Env> {
	private readonly runtime: Runtime;
	private readonly clock: RoomClock;
	protected readonly metadata: MetadataStore<RoomMetadata>;
	protected readonly storage: JournalOpener;
	private room: Room | undefined;
	private starting: Promise<void> | undefined;
	private readonly visits = new Map<string, Visit>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.storage = sqlStorage(ctx);
		this.clock = new RoomClock(ctx.storage, (work) => ctx.waitUntil(work));
		this.runtime = runtimeFor({
			storage: this.storage,
			clock: this.clock,
			transport: rpcTransport(env),
		});
		this.metadata = roomMetadata(this.storage);
		ctx.blockConcurrencyWhile(async () => {
			const { name, agents, stopped } = await this.metadata.read();
			if (name !== undefined && stopped !== true) {
				if (agents === undefined) throw new Error(`Room '${name}' has no catalog in its metadata.`);
				const recorded = await readRoom(name, { runtime: this.runtime, messages: false });
				if (!recorded.initialized) return;
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
				agents: [...(options.agents ?? [])],
				stopped: false,
			},
		}));
		this.room = await startRoom({
			name: options.name,
			runtime: this.runtime,
			agents: (options.agents ?? []).map(definitionOf),
			...(options.summary === undefined ? {} : { summary: options.summary }),
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

	async send(input: {
		from: string;
		to?: string;
		text: string;
		key?: string;
	}): Promise<ExchangeRef> {
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
		await this.running().abort();
	}

	async stop(): Promise<void> {
		const room = this.running();
		await room.stop();
		await this.metadata.change(() => ({ patch: { stopped: true } }));
		this.room = undefined;
		this.visits.clear();
	}

	async messages(since?: Seq): Promise<Message[]> {
		const snapshot = await this.read(since === undefined ? {} : { messages: { since } });
		return [...snapshot.messages];
	}

	async participants(): Promise<ParticipantInfo[]> {
		const snapshot = await this.read({ messages: false });
		return [...snapshot.participants];
	}

	/** Read a detached coherent projection, including stopped records. */
	async read(options: Pick<ReadRoomOptions, 'messages'> = {}): Promise<RoomSnapshot> {
		const name = (await this.metadata.read()).name;
		if (name === undefined) throw new Error('The room is not started.');
		return readRoom(name, { ...options, runtime: this.runtime });
	}

	/** Read the current room and the state of one exchange without changing it. */
	async status(from?: Seq): Promise<RoomStatus> {
		const snapshot = await this.read({ messages: false });
		const exchange =
			from === undefined
				? snapshot.exchange
				: snapshot.exchanges.find((item) => item.from === from);
		if (from !== undefined && exchange === undefined)
			throw new Error(`Exchange '${from}' is not on the record.`);
		return {
			name: snapshot.name,
			initialized: snapshot.initialized,
			...(snapshot.goal === undefined ? {} : { goal: snapshot.goal }),
			participants: [...snapshot.participants],
			exchanges: [...snapshot.exchanges],
			exchange,
			watermark: snapshot.watermark,
			exchangeState:
				from === undefined
					? snapshot.exchange === undefined
						? 'idle'
						: 'working'
					: exchange?.status === 'open'
						? 'working'
						: 'completed',
		};
	}

	async exchange(from: Seq) {
		const snapshot = await this.read({ messages: false });
		const exchange = snapshot.exchanges.find((item) => item.from === from);
		return exchange === undefined
			? undefined
			: { owner: exchange.owner, from: exchange.from, at: exchange.at };
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

	async view(activation: string, room?: string): Promise<ViewResponse> {
		return this.seatRoom(room).view(activation);
	}

	async commit(commit: CommitRequest, room?: string): Promise<CommitResult> {
		return this.seatRoom(room).commit(commit);
	}

	async lease(lease: LeaseRequest, room?: string): Promise<LeaseResponse> {
		return this.seatRoom(room).lease(lease);
	}

	async task(request: TaskCreateRequest, room?: string) {
		return this.taskRoom(room).task(request);
	}

	async taskUpdate(request: TaskUpdateRequest, room?: string) {
		return this.taskRoom(room).taskUpdate(request);
	}

	async taskSay(request: TaskSayRequest, room?: string) {
		return this.taskRoom(room).taskSay(request);
	}

	/** The room's alarm is its clock: it folds, decides, writes and sends. */
	override async alarm(): Promise<void> {
		await this.clock.fire();
		await this.room?.reconcile();
		await this.clock.settled();
	}

	private running(): Room {
		if (this.room === undefined) throw new Error('The room is not started.');
		return this.room;
	}

	private seatRoom(name: string = this.running().name): SeatRoom {
		const room = runningRoom(this.runtime, name);
		if (room === undefined) throw new Error('The room is not running.');
		return room;
	}

	private taskRoom(name?: string): TaskSeatRoom {
		const room = this.seatRoom(name);
		if (!('task' in room) || !('taskUpdate' in room) || !('taskSay' in room)) {
			throw new Error('The room does not support Task operations.');
		}
		return room as TaskSeatRoom;
	}
}
