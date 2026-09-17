/**
 * The runtime: what a host owns and every room in it shares.
 *
 * A room needs a clock, storage, a model call,
 * and a register of running rooms. A `Runtime` holds them as one value.
 * `startRoom` and `readRoom` take one.
 *
 * The clock is an interface so a test can move time by hand, and so a host
 * on a platform with its own alarms maps `alarm` to them. A journal opener
 * opens the record. A transcript opener opens Pi audit sessions.
 */

import { type JournalOpener, memoryJournals, namespaced } from '@ambionframework/journal';
import type { SessionOpener } from '@ambionframework/pi-journal';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createExecutionServices } from '../execution/services.ts';
import type { SeatPort, SeatRoom } from '../protocol.ts';
import type { AgentDefinition, Clock, ModelResolver, RoomNotification } from '../types.ts';

interface RuntimeState {
	running: Map<string, RunningRoom>;
}

const stateFor = new WeakMap<Runtime, RuntimeState>();

function state(runtime: Runtime): RuntimeState {
	const found = stateFor.get(runtime);
	if (found === undefined) throw new Error('Runtime must come from createRuntime.');
	return found;
}

export const runningRoom = (runtime: Runtime, name: string): SeatRoom | undefined =>
	state(runtime).running.get(name)?.calls;

/** The host's lifecycle record, for the room facade's own live fast paths. */
export const registeredRoom = (runtime: Runtime, name: string): RunningRoom | undefined =>
	state(runtime).running.get(name);

export function registerRoom(runtime: Runtime, room: RunningRoom): void {
	state(runtime).running.set(room.name, room);
}

export function releaseRoom(runtime: Runtime, name: string, room: RunningRoom): void {
	const running = state(runtime).running;
	if (running.get(name) === room) running.delete(name);
}

/** The dependencies that one in-process seat needs for one captured definition. */
export interface SeatContext {
	readonly clock: Clock;
	readonly call: { readonly attempts: number; readonly timeout: number };
	readonly definition: AgentDefinition;
	readonly room: string;
	readonly seat: string;
	readonly transcripts: SessionOpener;
	readonly stream: StreamFn;
	readonly model: ModelResolver;
	readonly emit?: (event: RoomNotification) => void;
}

/** A room the runtime keeps in its lifecycle registry. */
export interface RunningRoom {
	readonly name: string;
	readonly calls: SeatRoom;
	/** Drop the room from memory. The record keeps everything. */
	evict(): void;
}

/**
 * How a room reaches a seat. In process, a port is the seat's own actor over
 * a direct handle on the room (`inProcessTransport` in `execution/runner.ts`);
 * across a boundary, a port carries the wake over, and the seat reaches
 * back through the same boundary.
 */
export interface Transport {
	connect(room: SeatRoom, context: SeatContext): SeatPort;
}

/** The collaboration host's narrow request for one configured seat port. */
export interface ExecutionConnector {
	connect(
		room: SeatRoom,
		request: {
			readonly room: string;
			readonly seat: string;
			readonly definition: AgentDefinition;
			readonly emit: (event: RoomNotification) => void;
		},
	): SeatPort;
}

export interface Runtime {
	readonly clock: Clock;
	/** The host's native storage. The runtime derives its room and Pi views from it. */
	readonly storage: JournalOpener;
	readonly journals: JournalOpener;
	readonly transcripts: SessionOpener;
	/** How the room reaches a seat. Absent, every seat is an actor in this process. */
	readonly transport?: Transport;
	/** The model call every seat in this runtime makes, unless a room overrides it. */
	readonly stream: StreamFn;
	readonly model: ModelResolver;
	/**
	 * How long a wake stays unanswered before the room sends it again, how
	 * long a lease lasts between renewals, and how long an activation may run
	 * from its claim: the room renews no lease past the deadline, so an
	 * activation that runs on expires and counts as an attempt.
	 */
	readonly wake: { readonly resend: number; readonly expiry: number; readonly deadline: number };
	/** How many times the room retries a failed summary, and how long it waits before each retry. */
	readonly retry: { readonly attempts: number; readonly backoff: (attempt: number) => number };
	/**
	 * `timeout` bounds each executor call to the room, in milliseconds.
	 * `attempts` bounds claim and release retries. Defaults: 10,000 ms and two attempts.
	 * The journal remains authoritative when a timed out call may have reached the room.
	 * These limits are separate from execution retries, which can repeat model work.
	 */
	readonly call: { readonly attempts: number; readonly timeout: number };
	/** Drop a running room from memory and write nothing. The record keeps everything. */
	evict(name: string): void;
}

/** Collaboration services that a room host may use. */
export interface RoomRuntime {
	readonly clock: Clock;
	readonly journals: JournalOpener;
	readonly wake: Runtime['wake'];
	readonly retry: Runtime['retry'];
	release(room: RunningRoom): void;
}

export function roomRuntime(runtime: Runtime, name: string): RoomRuntime {
	return {
		clock: runtime.clock,
		journals: runtime.journals,
		wake: runtime.wake,
		retry: runtime.retry,
		release: (room) => releaseRoom(runtime, name, room),
	};
}

export interface CreateRuntimeOptions {
	clock?: Clock;
	transport?: Transport;
	/** Where the runtime opens room journals and Pi transcript sessions. */
	storage?: JournalOpener;
	/**
	 * The model call. A scripted stream makes every room deterministic; the
	 * model then resolves to a stub, because a custom stream never reads it.
	 */
	stream?: StreamFn;
	wake?: Partial<Runtime['wake']>;
	retry?: Partial<Runtime['retry']>;
	call?: Partial<Runtime['call']>;
}

export { systemClock } from './clock.ts';

export function createRuntime(options: CreateRuntimeOptions = {}): Runtime {
	const running = new Map<string, RunningRoom>();
	const storage = options.storage ?? memoryJournals();
	const journals = namespaced(storage, 'ambion/room');
	const services = createExecutionServices({
		storage,
		clock: options.clock,
		call: options.call,
		stream: options.stream,
	});
	const runtime: Runtime = {
		clock: services.clock,
		storage,
		journals,
		transcripts: services.transcripts,
		...(options.transport === undefined ? {} : { transport: options.transport }),
		stream: services.stream,
		model: services.model,
		wake: { resend: 5_000, expiry: 60_000, deadline: 600_000, ...options.wake },
		retry: { attempts: 3, backoff: (attempt) => attempt * 30_000, ...options.retry },
		call: services.call,
		evict(name) {
			const room = running.get(name);
			running.delete(name);
			room?.evict();
		},
	};
	stateFor.set(runtime, { running });
	return runtime;
}

/** What a host gets when it passes no runtime: one process-wide value. */
export const defaultRuntime: Runtime = createRuntime();
