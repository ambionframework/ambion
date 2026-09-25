/**
 * The room as one Durable Object. The journal lives in the object's SQLite, the
 * alarm is the room's clock, and a seat is reached over RPC to the seat
 * object named `<room>:<seat>`. The constructor resumes an initialized room
 * unless durable metadata records an explicit stop.
 */

import { DurableObject } from 'cloudflare:workers';
import type {
	Attention,
	Clock,
	ExchangeRef,
	Message,
	PendingSay,
	ReadRoomOptions,
	Room,
	RoomRead,
	Runtime,
	Seq,
	Visit,
} from '@ambionframework/ambion';
import { defineHuman, readRoom, resumeRoom, startRoom } from '@ambionframework/ambion';
import type {
	AgentExecutionContext,
	CommitRequest,
	CommitResult,
	LeaseRequest,
	LeaseResponse,
	RoomProtocol,
	Transport,
	ViewRange,
	ViewResponse,
} from '@ambionframework/ambion/hosting';
import { reconcileRoom, runningRoom } from '@ambionframework/ambion/hosting';
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
	summary?: string;
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
export function rpcTransport(env: Env): Transport {
	return {
		connect(_room, context: AgentExecutionContext) {
			const { room: roomName, seat } = context;
			const stub = env.SEAT.get(
				env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', roomName, seat])),
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
	private starting: Promise<void> | undefined;
	private readonly visits = new Map<string, Visit>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.storage = sqlStorage(ctx);
		this.runtime = runtimeFor({
			storage: this.storage,
			clock: alarmClock(ctx),
			transport: rpcTransport(env),
		});
		this.metadata = roomMetadata(ctx);
		ctx.blockConcurrencyWhile(async () => {
			const { name, agents, stopped } = this.metadata.read();
			if (name === undefined || stopped === true) return;
			if (agents === undefined)
				throw new Error(`Room '${name}' has no definitions in its metadata.`);
			const recorded = await readRoom(name, { runtime: this.runtime, messages: false });
			if (!recorded.initialized) return;
			const room = await resumeRoom(name, {
				runtime: this.runtime,
				agents: agents.map(definitionOf),
			});
			this.room = room;
			// Rebuild only live handles. The journal already contains each
			// admitted identity (and private preferences); this idempotent core
			// call does not append another arrival for a person already present.
			const snapshot = await room.read({ messages: false });
			for (const participant of snapshot.participants.filter(
				(participant) => participant.kind === 'human' && participant.presence === 'present',
			)) {
				const visit = await room.visit(
					defineHuman({ name: participant.name, identity: participant.identity }),
				);
				this.visits.set(participant.name, visit);
			}
		});
	}

	/** Start the room from names the worker configured. The composition lands on the journal. */
	async start(options: StartOptions): Promise<void> {
		if (this.room !== undefined) throw new Error(`Room '${this.room.name}' is running.`);
		this.metadata.change(() => ({
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
		// The room journal is the authority for identity and presence. In
		// particular, do not cache or persist the adapter value before core has
		// admitted it: a rejected visit must not poison a later send or restart.
		const human = defineHuman(person);
		const visit = await this.running().visit(human);
		this.visits.set(human.name, visit);
	}

	/** The live visit for a person. A resumed room reconstructs it from durable presence. */
	private visitOf(name: string): Visit {
		const known = this.visits.get(name);
		if (known !== undefined) return known;
		throw new Error(`'${name}' has not visited this room.`);
	}

	async send(input: {
		from: string;
		to?: string;
		text: string;
		refs?: string[];
		key?: string;
	}): Promise<ExchangeRef> {
		const visit = this.visitOf(input.from);
		const exchange = await visit.send({
			text: input.text,
			...(input.refs === undefined ? {} : { refs: input.refs }),
			...(input.to === undefined ? {} : { to: input.to }),
			...(input.key === undefined ? {} : { key: input.key }),
		});
		return { owner: exchange.owner, from: exchange.from, at: exchange.at };
	}

	async leave(name: string): Promise<void> {
		const visit = this.visits.get(name);
		if (visit === undefined) return;
		await visit.leave();
		// A deliberate reentry may install a new handle while the old departure
		// is awaiting its journal acknowledgement. Never remove that new handle.
		if (this.visits.get(name) === visit) this.visits.delete(name);
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

	/** Dismiss one scheduled say by its handle. True when the room dismissed it now. */
	async dismiss(handle: Seq): Promise<boolean> {
		return await this.running().dismiss(handle);
	}

	/**
	 * The scheduled says that wait to return, including those of a stopped
	 * record. Workers keep the name `scheduled` for the cron handler, and RPC
	 * does not expose it, so this method has a name of its own.
	 */
	async scheduledSays(): Promise<PendingSay[]> {
		return [...(await this.read({ messages: false })).scheduled];
	}

	async stop(): Promise<void> {
		const room = this.running();
		await room.stop();
		this.metadata.change(() => ({ patch: { stopped: true } }));
		this.room = undefined;
		this.visits.clear();
	}

	/** Read a detached coherent projection, including stopped records. */
	async read(options: Pick<ReadRoomOptions, 'messages'> = {}): Promise<RoomRead> {
		const name = this.metadata.read().name;
		if (name === undefined) throw new Error('The room is not started.');
		return readRoom(name, { ...options, runtime: this.runtime });
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

	async view(activation: string, range?: ViewRange): Promise<ViewResponse> {
		return this.protocol().view(activation, range);
	}

	async commit(commit: CommitRequest): Promise<CommitResult> {
		return this.protocol().commit(commit);
	}

	async lease(lease: LeaseRequest): Promise<LeaseResponse> {
		return this.protocol().lease(lease);
	}

	/** The room's alarm is its clock: it folds, decides, writes and sends. */
	override async alarm(): Promise<void> {
		if (this.room !== undefined) await reconcileRoom(this.runtime, this.room.name);
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
