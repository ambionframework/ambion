/**
 * The runtime: what a host owns and every room in it shares.
 *
 * A room needs a clock, storage, a model call,
 * and a register of running rooms. A `Runtime` holds them as one value.
 * `startSession` and `readSession` take one.
 *
 * The clock is an interface so a test can move time by hand, and so a host
 * on a platform with its own alarms maps `alarm` to them. A journal opener
 * opens the record. A transcript opener opens Pi audit sessions.
 */

import { type JournalOpener, memoryJournals, namespaced } from '@ambionframework/journal';
import { piSessions, type SessionOpener } from '@ambionframework/journal/pi';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { AgentDefinition, Clock, ModelResolver, SessionEvent } from '../types.ts';
import type { SeatPort, SeatRoom } from '../wire.ts';

interface RuntimeState {
	running: Map<string, RunningRoom>;
}

const stateFor = new WeakMap<Runtime, RuntimeState>();

function state(runtime: Runtime): RuntimeState {
	const found = stateFor.get(runtime);
	if (found === undefined) throw new Error('Runtime must come from createRuntime.');
	return found;
}

export const runningRoom = (runtime: Runtime, name: string): RunningRoom | undefined =>
	state(runtime).running.get(name);

export function registerRoom(runtime: Runtime, room: RunningRoom): void {
	state(runtime).running.set(room.name, room);
}

export function releaseRoom(runtime: Runtime, name: string, room: RunningRoom): void {
	const running = state(runtime).running;
	if (running.get(name) === room) running.delete(name);
}

/**
 * A room the runtime holds while it runs, as the transport sees it: the
 * seat's three calls, plus what an in-process seat is handed beside them.
 * `session.ts` implements it.
 */
export interface RunningRoom extends SeatRoom {
	readonly name: string;
	readonly stream: StreamFn;
	readonly model: ModelResolver;
	/** Where the room's sessions open: a seat's audit session opens beside them. */
	readonly transcripts: SessionOpener;
	definition(seat: string): AgentDefinition | undefined;
	emit(event: SessionEvent): void;
	/** Drop the room from memory. The record keeps everything. */
	evict(): void;
}

/**
 * How a room reaches a seat. In process, a port is the seat's own actor over
 * a direct handle on the room (`inProcessTransport` in `seat/seat.ts`);
 * across a boundary, a port carries the wake over, and the seat reaches
 * back through the same boundary.
 */
export interface Transport {
	connect(room: RunningRoom, seat: string, runtime: Runtime): SeatPort;
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
	 * How many times a seat sends one call to the room before it gives up. A
	 * call the room answers is done, whatever it answers; a call that never
	 * comes back is sent again, because the wire lost the call or the answer.
	 *
	 * This is its own policy, beside `retry`. An attempt at an activation
	 * costs a model call and waits a backoff; an attempt at a call costs one
	 * message and waits for nothing. One number over both would move each
	 * when a host tuned the other.
	 */
	readonly call: { readonly attempts: number };
	/** How many entries the journal takes past the last checkpoint before the room writes the next one. */
	readonly checkpoint: { readonly entries: number };
	/** Drop a running room from memory and write nothing. The record keeps everything. */
	evict(name: string): void;
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
	checkpoint?: Partial<Runtime['checkpoint']>;
}

/** The system clock, and one timer that never holds the process open. */
export function systemClock(): Clock {
	return {
		now: () => Date.now(),
		alarm(at, fire) {
			const timer = setTimeout(fire, Math.max(0, at - Date.now()));
			timer.unref?.();
			return () => clearTimeout(timer);
		},
	};
}

/** Pi's model registry, built once on first use. It loads every provider SDK. */
let builtinRegistry: ReturnType<typeof builtinModels> | undefined;
const registry = () => (builtinRegistry ??= builtinModels());

/** The default model call: Pi's builtin registry, keyed from the provider's env var. */
const registryStream: StreamFn = (model, context, streamOptions) => {
	const envKey = process.env[`${model.provider.toUpperCase().replace(/-/g, '_')}_API_KEY`];
	const resolved =
		streamOptions?.apiKey || !envKey ? streamOptions : { ...streamOptions, apiKey: envKey };
	return registry().streamSimple(model, context, resolved);
};

/** `provider/model-id` through Pi's catalog. */
const registryModel: ModelResolver = (id, agent) => {
	const slash = id.indexOf('/');
	if (slash > 0) {
		const model = registry().getModel(id.slice(0, slash), id.slice(slash + 1));
		if (model) return model;
	}
	throw new Error(`Unknown model '${id}' for agent '${agent}': expected 'provider/model-id'.`);
};

/** A custom stream never reads the model; a stub keeps Pi's loop satisfied. */
export const stubModel: ModelResolver = (id) =>
	({ id, name: id, api: 'scripted', provider: 'scripted' }) as unknown as Model<Api>;

export function createRuntime(options: CreateRuntimeOptions = {}): Runtime {
	const running = new Map<string, RunningRoom>();
	const storage = options.storage ?? memoryJournals();
	const journals = namespaced(storage, 'ambion/room');
	const transcripts = piSessions(storage);
	const runtime: Runtime = {
		clock: options.clock ?? systemClock(),
		storage,
		journals,
		transcripts,
		...(options.transport === undefined ? {} : { transport: options.transport }),
		stream: options.stream ?? registryStream,
		model: options.stream ? stubModel : registryModel,
		wake: { resend: 5_000, expiry: 60_000, deadline: 600_000, ...options.wake },
		retry: { attempts: 3, backoff: (attempt) => attempt * 30_000, ...options.retry },
		call: { attempts: 2, ...options.call },
		checkpoint: { entries: 256, ...options.checkpoint },
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
