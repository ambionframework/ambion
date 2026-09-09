/**
 * The runtime: what a host owns and every room in it shares.
 *
 * A room needs a clock, a place to open Pi sessions, a model call, and a
 * register of what is running. Until now each of those was a module-level
 * value, so two hosts in one process shared them whether they wanted to or
 * not. A `Runtime` holds them as one value: `startSession`, `readSession`
 * and `defineWorkspace` take one, and `defaultRuntime` is the value they
 * take when a host passes none.
 *
 * The clock is an interface so a test can move time by hand, and so a host
 * on a platform with its own alarms maps `alarm` to them. The opener is an
 * interface so a host supplies whatever Pi's repository needs to create a
 * session, which an in-memory repository needs nothing for and a JSONL
 * repository needs a working directory for.
 */
import type {
	Session as PiSession,
	SessionCreateOptions,
	SessionMetadata,
	StreamFn,
} from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { SeatActor, type SeatContext } from './seat.ts';
import type { AgentDefinition, SessionEvent } from './types.ts';
import type { SeatPort, SeatRoom } from './wire.ts';

/** The one clock a room reads, and the one alarm it sets. */
export interface Clock {
	/** Milliseconds since the epoch. */
	now(): number;
	/** Arrange one call of `fire` at `at`. Returns the cancel. */
	alarm(at: number, fire: () => void): () => void;
}

/** Opens one Pi session by id, and creates it on the first open. */
export interface SessionOpener {
	open(id: string, parentId?: string): Promise<PiSession>;
}

/** Resolves an agent's `provider/model-id` to the model Pi's loop runs. */
export type ModelResolver = (id: string, agent: string) => Model<Api>;

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
	readonly sessions: SessionOpener;
	emit(event: SessionEvent): void;
	/** Drop the room from memory. The record keeps everything. */
	evict(): void;
}

/**
 * How a room reaches a seat. In process, a port is the seat's own actor over
 * a direct handle on the room; across a boundary, a port carries the wake
 * and the steer over, and the seat reaches back through the same boundary.
 */
export interface Transport {
	connect(room: RunningRoom, seat: string, runtime: Runtime): SeatPort;
}

/** Every seat is an actor in this process, holding the room directly. */
export function inProcessTransport(): Transport {
	return {
		connect(room, seat, runtime) {
			const context: SeatContext = {
				runtime,
				room: room.name,
				seat,
				sessions: room.sessions,
				stream: room.stream,
				model: room.model,
				emit: (event) => room.emit(event),
			};
			return new SeatActor(room, context);
		},
	};
}

export interface Runtime {
	/** One run per name: the rooms running in this runtime. */
	readonly running: Map<string, RunningRoom>;
	/** One workspace handle per name. */
	readonly taken: Set<string>;
	/** Every agent definition a room in this runtime was started with, by name. */
	readonly catalog: Map<string, AgentDefinition>;
	readonly clock: Clock;
	readonly sessions: SessionOpener;
	readonly transport: Transport;
	/** The model call every seat in this runtime makes, unless a room overrides it. */
	readonly stream: StreamFn;
	readonly model: ModelResolver;
	/** How long a wake stays unanswered before the room sends it again, and how long a lease lasts. */
	readonly wake: { readonly resend: number; readonly expiry: number };
	/** How many times the room retries a failed summary, and how long it waits before each retry. */
	readonly retry: { readonly attempts: number; readonly backoff: (attempt: number) => number };
	/** Drop a running room from memory and write nothing. The record keeps everything. */
	evict(name: string): void;
}

export interface CreateRuntimeOptions {
	clock?: Clock;
	transport?: Transport;
	/** Definitions the catalog starts with. `resumeSession` resolves a room's names through it. */
	agents?: readonly AgentDefinition[];
	/** Where the rooms' Pi sessions open. `repo` is the shorthand for `sessionsOver(repo)`. */
	sessions?: SessionOpener;
	repo?: SessionRepoLike<SessionMetadata, SessionCreateOptions>;
	/**
	 * The model call. A scripted stream makes every room deterministic; the
	 * model then resolves to a stub, because a custom stream never reads it.
	 */
	stream?: StreamFn;
	wake?: Partial<Runtime['wake']>;
	retry?: Partial<Runtime['retry']>;
}

/** What `sessionsOver` needs of a Pi repository: list, open, create. */
export interface SessionRepoLike<
	TMetadata extends SessionMetadata,
	TCreate extends SessionCreateOptions,
> {
	list(): Promise<TMetadata[]>;
	open(metadata: TMetadata): Promise<PiSession<TMetadata>>;
	create(options: TCreate): Promise<PiSession<TMetadata>>;
}

/**
 * Open an id into its Pi session in `repo`, creating it on the first open.
 * `create` carries what the repository's `create` needs beyond the id: a
 * JSONL repository needs a `cwd`, an in-memory one needs nothing.
 */
export function sessionsOver<
	TMetadata extends SessionMetadata,
	TCreate extends SessionCreateOptions,
>(
	repo: SessionRepoLike<TMetadata, TCreate>,
	create?: Omit<TCreate, keyof SessionCreateOptions>,
): SessionOpener {
	return {
		async open(id, parentId) {
			const known = (await repo.list()).find((metadata) => metadata.id === id);
			if (known) return repo.open(known);
			const options = { ...(create ?? {}), id } as TCreate;
			if (parentId !== undefined) options.parentSessionId = parentId;
			return repo.create(options);
		},
	};
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
	const sessions = options.sessions ?? sessionsOver(options.repo ?? new InMemorySessionRepo());
	return {
		running,
		taken: new Set(),
		catalog: new Map((options.agents ?? []).map((def) => [def.name, def])),
		clock: options.clock ?? systemClock(),
		sessions,
		transport: options.transport ?? inProcessTransport(),
		stream: options.stream ?? registryStream,
		model: options.stream ? stubModel : registryModel,
		wake: { resend: 5_000, expiry: 60_000, ...options.wake },
		retry: { attempts: 3, backoff: (attempt) => attempt * 30_000, ...options.retry },
		evict(name) {
			const room = running.get(name);
			running.delete(name);
			room?.evict();
		},
	};
}

/** What a host gets when it passes no runtime: one process-wide value. */
export const defaultRuntime: Runtime = createRuntime();
