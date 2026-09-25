/**
 * The runtime: what a host owns and every room in it shares.
 *
 * An application holds a `Runtime` as an opaque token: a clock, and a place
 * to store the record. `startRoom` and `readRoom` take one and pass it on;
 * neither reads anything else off it. Everything else a host or the
 * kernel's own internals need — the journal namespace, the transport, the
 * limits, and the room lifecycle registry — lives behind `hostingOf`.
 *
 * `Runtime`'s brand blocks a hand-written literal at compile time: nothing
 * outside this file can name the key it carries, so a value assembled from
 * scratch never type-checks as one. It does not follow a value through a
 * spread, because the key names no runtime property to copy; what actually
 * refuses a value that did not come from `createRuntime` is the same check
 * `hostingOf` always made, the `stateFor` lookup below, so a spread copy
 * still fails, at the first call that reaches it, exactly as it did before
 * the brand existed.
 *
 * The clock is an interface so a test can move time by hand, and so a host
 * on a platform with its own alarms maps `alarm` to them. A journal opener
 * opens the record. The kernel names no model library: the host supplies an
 * `Execution`, built by an executor package such as `@ambionframework/pi`.
 */

import { type JournalOpener, memoryJournals, namespaced } from '@ambionframework/journal';
import type { Executor } from '../execution/executor.ts';
import type { TraceOpener } from '../execution/trace.ts';
import type { AgentPort, RoomProtocol } from '../protocol.ts';
import type {
	AgentDefinition,
	Clock,
	ExecutionEvent,
	ScheduleLimits,
	TraceLogger,
} from '../types.ts';
import { systemClock } from './clock.ts';
import { defaultExecutionFactory } from './defaults.ts';

/** A key nobody outside this file can name. `createRuntime` is the one place that casts past it. */
declare const RUNTIME: unique symbol;

/** What an application holds and passes on. Nothing else reaches through it. */
export interface Runtime {
	readonly [RUNTIME]: true;
	readonly clock: Clock;
	/** The host's native storage. The runtime derives its room journals from it. */
	readonly storage: JournalOpener;
}

/**
 * What the runtime hands an execution composition: the clock, the host's
 * native storage, the limits, the logger, and the transport.
 */
export interface ExecutionHost {
	readonly clock: Clock;
	readonly storage: JournalOpener;
	readonly limits: Limits;
	/** Where the steps of each activation go. Absent, the trace drops them. */
	readonly logger?: TraceLogger;
	/** Absent, every seat is an actor in this process. */
	readonly transport?: Transport;
}

/**
 * The execution side of a room, as a value. An executor package builds one,
 * such as `piExecution()`. `startRoom` and `createRuntime` take it; the
 * kernel never reads what is inside.
 */
export interface Execution {
	connector(host: ExecutionHost): ExecutionConnector;
}

/**
 * One execution for a room whose seats run on different executor families.
 * It routes each seat to the execution named for the `kind` of its executor,
 * such as `{ pi: piExecution(), claude: claudeExecution() }`. A seat of
 * another kind fails when the room connects it.
 */
export function composeExecutions(byKind: Readonly<Record<string, Execution>>): Execution {
	return {
		connector(host) {
			const connectors = new Map(
				Object.entries(byKind).map(([kind, execution]) => [kind, execution.connector(host)]),
			);
			return {
				connect(room, request) {
					const kind = request.definition.executor.kind;
					const connector = connectors.get(kind);
					if (connector === undefined) {
						const known = [...connectors.keys()].join(', ');
						throw new Error(
							`No execution serves seat '${request.seat}' of kind '${kind}'. Known kinds: ${known}.`,
						);
					}
					return connector.connect(room, request);
				},
			};
		},
	};
}

/** Every bound the runtime sets, by what it bounds. One value for every room in the runtime. */
export interface Limits {
	/** How long a wake stays unanswered before the room sends it again. */
	readonly delivery: { readonly resend: number };
	/**
	 * How long a lease lasts from each claim or renewal (`ttl`), and how long
	 * an activation may run from its first claim (`deadline`): the room renews
	 * no lease past the deadline, so an activation that runs on expires and
	 * counts as an attempt.
	 */
	readonly lease: { readonly ttl: number; readonly deadline: number };
	/** How many attempts the room makes at one wake or one draft, and how long it waits before each retry. */
	readonly activation: { readonly attempts: number; readonly backoff: (attempt: number) => number };
	/**
	 * `timeout` bounds each executor call to the room, in milliseconds.
	 * `attempts` bounds claim and release retries. The journal remains
	 * authoritative when a timed out call may have reached the room. These
	 * bounds are separate from activation attempts, which can repeat model work.
	 */
	readonly call: { readonly attempts: number; readonly timeout: number };
	/**
	 * The most messages one activation's view holds beyond the open exchange.
	 * The room applies it to every seat. `Infinity` is unbounded.
	 */
	readonly context: { readonly messages: number };
	/**
	 * The most UTF-8 bytes one spoken message or summary text carries. The room
	 * refuses a longer text with `message_too_large`. `Infinity` is unbounded.
	 */
	readonly message: { readonly bytes: number };
	/**
	 * The bounds on a scheduled say: `after` from `minAfter` to `maxAfter`
	 * seconds, and at most `pending` says of one seat that wait to return.
	 * `maxAfter` and `pending` may be `Infinity`.
	 */
	readonly schedule: ScheduleLimits;
	/** How many bytes of tool output a step keeps, and how many steps one pass keeps. */
	readonly trace: { readonly toolOutputBytes: number; readonly stepsPerPass: number };
}

/** What the trace keeps of a step, and how many steps one pass keeps, by default. */
export const DEFAULT_TRACE_LIMITS: Limits['trace'] = Object.freeze({
	toolOutputBytes: 65_536,
	stepsPerPass: 1_000,
});

/**
 * What a host, or the kernel's own internals, need beyond the application
 * view: the journal namespace, the transport, the limits, the default
 * execution, and the room lifecycle registry. `hostingOf` is the one way to
 * reach it from a `Runtime` value.
 */
export interface Hosting {
	readonly journals: JournalOpener;
	/** How the room reaches a seat. Absent, every seat is an actor in this process. */
	readonly transport?: Transport;
	/** The execution every room in this runtime uses, unless a room names its own. */
	readonly execution?: Execution;
	readonly limits: Limits;
	/** Drop a running room from memory and write nothing. The record keeps everything. */
	evict(name: string): void;
}

interface RuntimeState extends Hosting {
	running: Map<string, RunningRoom>;
	/** One connector per executor kind, built on first use from the registered default. */
	readonly defaults: Map<string, ExecutionConnector | undefined>;
	readonly clock: Clock;
	readonly storage: JournalOpener;
	readonly logger?: TraceLogger;
}

const stateFor = new WeakMap<Runtime, RuntimeState>();

function state(runtime: Runtime): RuntimeState {
	const found = stateFor.get(runtime);
	if (found === undefined) throw new Error('Runtime must come from createRuntime.');
	return found;
}

/** Everything beyond the application view: a host's, or the kernel's own, escape hatch. */
export function hostingOf(runtime: Runtime): Hosting {
	const found = state(runtime);
	return {
		journals: found.journals,
		...(found.transport === undefined ? {} : { transport: found.transport }),
		...(found.execution === undefined ? {} : { execution: found.execution }),
		limits: found.limits,
		evict: found.evict,
	};
}

export const runningRoom = (runtime: Runtime, name: string): RoomProtocol | undefined =>
	state(runtime).running.get(name)?.calls;

/** Reconcile a running room. Nothing happens when no room by that name runs. */
export const reconcileRoom = (runtime: Runtime, name: string): Promise<void> =>
	state(runtime).running.get(name)?.reconcile() ?? Promise.resolve();

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

/** What an execution composition reads from a runtime. */
export function executionHostOf(runtime: Runtime): ExecutionHost {
	const found = state(runtime);
	return {
		clock: found.clock,
		storage: found.storage,
		limits: found.limits,
		...(found.logger === undefined ? {} : { logger: found.logger }),
		...(found.transport === undefined ? {} : { transport: found.transport }),
	};
}

/**
 * The connector of the default execution for `kind`, built once per runtime.
 * Nothing when no executor package registered a default for the kind.
 */
export function defaultConnectorOf(runtime: Runtime, kind: string): ExecutionConnector | undefined {
	const found = state(runtime);
	if (!found.defaults.has(kind)) {
		const factory = defaultExecutionFactory(kind);
		found.defaults.set(kind, factory?.().connector(executionHostOf(runtime)));
	}
	return found.defaults.get(kind);
}

/** The dependencies that one in-process seat needs for one captured definition. */
export interface AgentExecutionContext {
	readonly clock: Clock;
	readonly call: Limits['call'];
	readonly definition: AgentDefinition;
	readonly room: string;
	readonly seat: string;
	/** Opens one session per activation. Pi today; a later model family gets its own. */
	readonly executor: Executor;
	readonly emit?: (event: ExecutionEvent) => void;
	/** Opens the trace sink of each activation. The driver closes it. */
	readonly trace: TraceOpener;
}

/** A room the runtime keeps in its lifecycle registry. */
export interface RunningRoom {
	readonly name: string;
	readonly calls: RoomProtocol;
	/** Drop the room from memory. The record keeps everything. */
	evict(): void;
	/** Fold the journal and act on what is due. */
	reconcile(): Promise<void>;
}

/**
 * How a room reaches a seat. In process, a port is the seat's own actor over
 * a direct handle on the room (`inProcessTransport` in `execution/runner.ts`);
 * across a boundary, a port carries the wake over, and the seat reaches
 * back through the same boundary.
 */
export interface Transport {
	connect(room: RoomProtocol, context: AgentExecutionContext): AgentPort;
}

/** The collaboration host's narrow request for one configured seat port. */
export interface ConnectorRequest {
	readonly room: string;
	readonly seat: string;
	readonly definition: AgentDefinition;
	readonly emit: (event: ExecutionEvent) => void;
}

export interface ExecutionConnector {
	connect(room: RoomProtocol, request: ConnectorRequest): AgentPort;
}

/** Collaboration services that a room host may use. */
export interface RoomRuntime {
	readonly clock: Clock;
	readonly journals: JournalOpener;
	readonly limits: Limits;
	release(room: RunningRoom): void;
}

export function roomRuntime(runtime: Runtime, name: string): RoomRuntime {
	const hosting = state(runtime);
	return {
		clock: runtime.clock,
		journals: hosting.journals,
		limits: hosting.limits,
		release: (room) => releaseRoom(runtime, name, room),
	};
}

export interface CreateRuntimeOptions {
	clock?: Clock;
	transport?: Transport;
	/** Where the runtime opens room journals. */
	storage?: JournalOpener;
	/**
	 * The execution every room in this runtime uses, such as `piExecution()`
	 * from `@ambionframework/pi`. A room may name its own. Absent, each seat
	 * runs on the default execution of its executor kind, when the executor
	 * package supplies one. A seat of a kind with no default fails with an
	 * error event.
	 */
	execution?: Execution;
	/**
	 * Where the steps of each activation go, such as the host's log. Absent,
	 * the trace drops them. The kernel writes nothing to stdout.
	 */
	logger?: TraceLogger;
	/** Any field of any group. An omitted field keeps its default. */
	limits?: { readonly [Group in keyof Limits]?: Partial<Limits[Group]> };
}

export { systemClock } from './clock.ts';

/** A cap is a positive integer, or Infinity for no cap. */
function validateCaps(limits: Limits): void {
	for (const [name, value] of [
		['context.messages', limits.context.messages],
		['message.bytes', limits.message.bytes],
		['schedule.minAfter', limits.schedule.minAfter],
		['schedule.maxAfter', limits.schedule.maxAfter],
		['schedule.pending', limits.schedule.pending],
	] as const) {
		if (value !== Number.POSITIVE_INFINITY && !(Number.isSafeInteger(value) && value > 0)) {
			throw new Error(`Runtime limits.${name} must be a positive integer or Infinity.`);
		}
	}
}

/** A scheduled say waits a finite least time, and the most is at least the least. */
function validateSchedule({ minAfter, maxAfter }: ScheduleLimits): void {
	if (!Number.isFinite(minAfter))
		throw new Error('Runtime limits.schedule.minAfter must be a positive integer.');
	if (maxAfter < minAfter)
		throw new Error('Runtime limits.schedule.maxAfter must be at least limits.schedule.minAfter.');
}

export function createRuntime(options: CreateRuntimeOptions = {}): Runtime {
	const running = new Map<string, RunningRoom>();
	const storage = options.storage ?? memoryJournals();
	const journals = namespaced(storage, 'ambion/room');
	const clock = options.clock ?? systemClock();
	const given = options.limits ?? {};
	const limits: Limits = {
		delivery: { resend: 5_000, ...given.delivery },
		lease: { ttl: 60_000, deadline: 600_000, ...given.lease },
		activation: {
			attempts: 3,
			backoff: (attempt: number) => attempt * 30_000,
			...given.activation,
		},
		call: callLimits(given.call),
		context: { messages: Number.POSITIVE_INFINITY, ...given.context },
		message: { bytes: Number.POSITIVE_INFINITY, ...given.message },
		schedule: { minAfter: 60, maxAfter: 604_800, pending: 4, ...given.schedule },
		trace: { ...DEFAULT_TRACE_LIMITS, ...given.trace },
	};
	// The runtime establishes these bounds here, once, for every room it runs.
	// The pass writes an activation off at the cap, so a cap below one would
	// write every activation off before its first attempt. The verified
	// `leaseExpiry` requires each wake interval to be at least one
	// millisecond, so a resend and a claim always wait.
	if (!Number.isInteger(limits.activation.attempts) || limits.activation.attempts < 1) {
		throw new Error(
			'Runtime limits.activation.attempts must be a positive integer: the room makes at least one attempt.',
		);
	}
	validateCaps(limits);
	validateSchedule(limits.schedule);
	const intervals = {
		'delivery.resend': limits.delivery.resend,
		'lease.ttl': limits.lease.ttl,
		'lease.deadline': limits.lease.deadline,
	};
	for (const [name, value] of Object.entries(intervals)) {
		if (!Number.isFinite(value) || value < 1) {
			throw new Error(`Runtime limits.${name} must be at least one millisecond.`);
		}
	}
	// The application view: an opaque token nobody outside this file can produce.
	const runtime = { clock, storage } as unknown as Runtime;
	stateFor.set(runtime, {
		running,
		defaults: new Map(),
		journals,
		clock,
		storage,
		...optional({
			transport: options.transport,
			execution: options.execution,
			logger: options.logger,
		}),
		limits,
		evict(name) {
			const room = running.get(name);
			running.delete(name);
			room?.evict();
		},
	});
	return runtime;
}

/** The fields of an object that hold a value. */
function optional<T extends object>(fields: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	) as Partial<T>;
}

/** The executor call bounds, checked once for every room in the runtime. */
export function callLimits(given: Partial<Limits['call']> | undefined): Limits['call'] {
	const attempts = given?.attempts ?? 2;
	const timeout = given?.timeout ?? 10_000;
	if (!Number.isSafeInteger(attempts) || attempts < 1)
		throw new Error('Room call attempts must be a positive safe integer.');
	if (!Number.isFinite(timeout) || timeout <= 0)
		throw new Error('Room call timeout must be a finite positive number.');
	return { attempts, timeout };
}

let singleton: Runtime | undefined;

/** What a host gets when it passes no runtime: one process-wide value, created on first use. */
export function defaultRuntime(): Runtime {
	if (singleton === undefined) singleton = createRuntime();
	return singleton;
}
