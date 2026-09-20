/**
 * The runtime: what a host owns and every room in it shares.
 *
 * An application holds a `Runtime` as an opaque token: a clock, and a place
 * to store the record. `startRoom` and `readRoom` take one and pass it on;
 * neither reads anything else off it. Everything else a host or the
 * kernel's own internals need — the journal namespace, transcript storage,
 * the model call, wake and retry policy, and the room lifecycle registry —
 * lives behind `hostingOf`. Only `createRuntime` can produce the brand
 * `hostingOf` looks up, so a hand-built value can never stand in for one.
 *
 * The clock is an interface so a test can move time by hand, and so a host
 * on a platform with its own alarms maps `alarm` to them. A journal opener
 * opens the record. A transcript opener opens Pi audit sessions.
 */

import { type JournalOpener, memoryJournals, namespaced } from '@ambionframework/journal';
import type { SessionOpener } from '@ambionframework/pi-journal';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Executor } from '../execution/executor.ts';
import { createExecutionServices } from '../execution/services.ts';
import type { SeatPort, SeatRoom } from '../protocol.ts';
import type { AgentDefinition, Clock, ModelResolver, RoomNotification } from '../types.ts';

/** A key nobody outside this file can write: `createRuntime` is the one place that casts through it. */
declare const RUNTIME: unique symbol;

/** What an application holds and passes on. Nothing else reaches through it. */
export interface Runtime {
	readonly [RUNTIME]: true;
	readonly clock: Clock;
	/** The host's native storage. The runtime derives its room and Pi views from it. */
	readonly storage: JournalOpener;
}

/**
 * What a host, or the kernel's own internals, need beyond the application
 * view: the journal namespace, transcript storage, the model call, wake and
 * retry policy, and the room lifecycle registry. `hostingOf` is the one way
 * to reach it from a `Runtime` value.
 */
export interface Hosting {
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

interface RuntimeState extends Hosting {
	running: Map<string, RunningRoom>;
}

const stateFor = new WeakMap<Runtime, RuntimeState>();

function state(runtime: Runtime): RuntimeState {
	const found = stateFor.get(runtime);
	if (found === undefined) throw new Error('Runtime must come from createRuntime.');
	return found;
}

/** Everything beyond the application view: a host's, or the kernel's own, escape hatch. */
export function hostingOf(runtime: Runtime): Hosting {
	return state(runtime);
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
	/** Opens one session per activation. Pi today; a later model family gets its own. */
	readonly executor: Executor;
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

/** Collaboration services that a room host may use. */
export interface RoomRuntime {
	readonly clock: Clock;
	readonly journals: JournalOpener;
	readonly wake: Hosting['wake'];
	readonly retry: Hosting['retry'];
	release(room: RunningRoom): void;
}

export function roomRuntime(runtime: Runtime, name: string): RoomRuntime {
	const hosting = state(runtime);
	return {
		clock: runtime.clock,
		journals: hosting.journals,
		wake: hosting.wake,
		retry: hosting.retry,
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
	wake?: Partial<Hosting['wake']>;
	retry?: Partial<Hosting['retry']>;
	call?: Partial<Hosting['call']>;
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
	const retry = { attempts: 3, backoff: (attempt: number) => attempt * 30_000, ...options.retry };
	const wake = { resend: 5_000, expiry: 60_000, deadline: 600_000, ...options.wake };
	// The runtime establishes these bounds here, once, for every room it runs.
	// The pass writes an activation off at the cap, so a cap below one would
	// write every activation off before its first attempt. The verified
	// `leaseExpiry` requires each wake interval to be at least one
	// millisecond, so a resend and a claim always wait.
	if (!Number.isInteger(retry.attempts) || retry.attempts < 1) {
		throw new Error(
			'Runtime retry.attempts must be a positive integer: the room makes at least one attempt.',
		);
	}
	for (const [name, value] of Object.entries(wake)) {
		if (!Number.isFinite(value) || value < 1) {
			throw new Error(`Runtime wake.${name} must be at least one millisecond.`);
		}
	}
	// The application view: an opaque token nobody outside this file can produce.
	const runtime = { clock: services.clock, storage } as unknown as Runtime;
	stateFor.set(runtime, {
		running,
		journals,
		transcripts: services.transcripts,
		...(options.transport === undefined ? {} : { transport: options.transport }),
		stream: services.stream,
		model: services.model,
		wake,
		retry,
		call: services.call,
		evict(name) {
			const room = running.get(name);
			running.delete(name);
			room?.evict();
		},
	});
	return runtime;
}

let singleton: Runtime | undefined;

/** What a host gets when it passes no runtime: one process-wide value, created on first use. */
export function defaultRuntime(): Runtime {
	if (singleton === undefined) singleton = createRuntime();
	return singleton;
}
