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
import type {
	AgentDefinition,
	Clock,
	ModelResolver,
	SessionEvent,
	SessionOpener,
} from '../types.ts';
import type { SeatPort, SeatRoom } from '../wire.ts';

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
	/** One run per name: the rooms running in this runtime. */
	readonly running: Map<string, RunningRoom>;
	/** One workspace handle per name. */
	readonly taken: Set<string>;
	/** Every agent definition a room in this runtime was started with, by name. */
	readonly catalog: Map<string, AgentDefinition>;
	readonly clock: Clock;
	readonly sessions: SessionOpener;
	/** How the room reaches a seat. Absent, every seat is an actor in this process. */
	readonly transport?: Transport;
	/** The model call every seat in this runtime makes, unless a room overrides it. */
	readonly stream: StreamFn;
	readonly model: ModelResolver;
}

export interface CreateRuntimeOptions {
	clock?: Clock;
	transport?: Transport;
	/** Where the rooms' Pi sessions open. `repo` is the shorthand for `sessionsOver(repo)`. */
	sessions?: SessionOpener;
	repo?: SessionRepoLike<SessionMetadata, SessionCreateOptions>;
	/**
	 * The model call. A scripted stream makes every room deterministic; the
	 * model then resolves to a stub, because a custom stream never reads it.
	 */
	stream?: StreamFn;
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
	const sessions = options.sessions ?? sessionsOver(options.repo ?? new InMemorySessionRepo());
	return {
		running: new Map(),
		taken: new Set(),
		catalog: new Map(),
		clock: options.clock ?? systemClock(),
		sessions,
		...(options.transport === undefined ? {} : { transport: options.transport }),
		stream: options.stream ?? registryStream,
		model: options.stream ? stubModel : registryModel,
	};
}

/** What a host gets when it passes no runtime: one process-wide value. */
export const defaultRuntime: Runtime = createRuntime();
