/**
 * The runtime: what a host owns and every room in it shares.
 *
 * An application holds a `Runtime` as an opaque token: a clock, and a place
 * to store the record. `startRoom` and `readRoom` take one and pass it on;
 * neither reads anything else off it. Behind the token sits one state
 * object, and each reader sees a part of it. `hostingOf` gives a host the
 * `Hosting` part: the journal namespace, the limits, the executions, and
 * `evict`. `runtimeStateOf` gives the core the whole `RuntimeState`.
 *
 * `Runtime`'s brand blocks a hand-written literal at compile time: nothing
 * outside this file can name the key it carries, so a value assembled from
 * scratch never type-checks as one. It does not follow a value through a
 * spread, because the key names no runtime property to copy; what actually
 * refuses a value that did not come from `createRuntime` is the `stateFor`
 * lookup below, so a spread copy fails at the first call that reaches it.
 *
 * The clock is an interface so a test can move time by hand, and so a host
 * on a platform with its own alarms maps `alarm` to them. A journal opener
 * opens the record. The kernel names no model library: the host supplies an
 * `Execution`, built by an executor package such as `@ambionframework/pi`.
 */

import { type JournalOpener, namespaced } from '@ambionframework/journal';
import type { ActivationOpener, TraceOpener } from '../execution/contract.ts';
import type { AgentPort, RoomProtocol } from '../protocol.ts';
import type { ScheduleLimits } from '../scheduling.ts';
import type { ActivationEvent, AgentDefinition, Clock, TraceLogger } from '../types.ts';
import { systemClock } from './clock.ts';

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
 * What the runtime hands an execution: the clock, the host's native
 * storage, the limits, and the logger.
 */
export interface ExecutionHost {
	readonly clock: Clock;
	readonly storage: JournalOpener;
	readonly limits: Limits;
	/** Where the steps of each activation go. Absent, the trace drops them. */
	readonly logger?: TraceLogger;
}

/**
 * The execution side of a room, as a value. An executor package builds one
 * with `localExecution`, such as `piExecution()`. A remote host builds one
 * whose ports cross to the host that runs the seat. `startRoom` and
 * `createRuntime` take it. The kernel reads its `kind` and calls its
 * connector.
 */
export interface Execution<Port extends AgentPort = AgentPort> {
	/** The executor kind of the seats that it serves. Absent, it serves a seat of every kind. */
	readonly kind?: string;
	connector(host: ExecutionHost): ExecutionConnector<Port>;
}

/** Every bound the runtime sets, by what it bounds. One value for every room in the runtime. */
export interface Limits {
	/** How long a wake stays unanswered before the room sends it again. */
	readonly port: { readonly resend: number };
	/**
	 * How long a lease lasts from each claim or renewal (`ttl`), and how long
	 * an activation may run from its first claim (`deadline`): the room renews
	 * no lease past the deadline, so an activation that runs on expires and
	 * counts as an attempt.
	 */
	readonly lease: { readonly ttl: number; readonly deadline: number };
	/** How many attempts the room makes at one due activation, and how long it waits before each retry. */
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
	 * The room applies it to every seat. The default is 200. `Infinity` is
	 * unbounded.
	 */
	readonly context: { readonly messages: number };
	/**
	 * The most UTF-8 bytes one said message or summary text carries. The room
	 * refuses a longer text with `message_too_large`. `Infinity` is unbounded.
	 */
	readonly message: { readonly bytes: number };
	/**
	 * The bounds on a scheduled say: `delaySeconds` from `minDelaySeconds` to
	 * `maxDelaySeconds`, and at most `waiting` says of one seat that wait to
	 * return. `maxDelaySeconds` and `waiting` may be `Infinity`.
	 */
	readonly schedule: ScheduleLimits;
	/**
	 * How many bytes of tool output and of `input` text a step keeps, and how
	 * many steps one pass keeps.
	 */
	readonly trace: {
		readonly toolOutputBytes: number;
		readonly inputBytes: number;
		readonly stepsPerPass: number;
	};
}

/** What the trace keeps of a step, and how many steps one pass keeps, by default. */
export const DEFAULT_TRACE_LIMITS: Limits['trace'] = Object.freeze({
	toolOutputBytes: 65_536,
	inputBytes: 1_048_576,
	stepsPerPass: 1_000,
});

/**
 * What a host needs beyond the application view: the execution host, the
 * journal namespace, the executions of the runtime, and `evict`. `hostingOf` is the
 * one way to reach it from a `Runtime` value.
 */
export interface Hosting extends ExecutionHost {
	readonly journals: JournalOpener;
	/** The executions that every room in this runtime uses after its own. */
	readonly executions: readonly Execution[];
	/** Drop a running room from memory and write nothing. The record keeps everything. */
	evict(name: string): void;
}

/**
 * The one state of a runtime. The core reads all of it. A host reads the
 * `Hosting` part, and an execution reads the `ExecutionHost` part.
 */
export interface RuntimeState extends Hosting {
	/** The rooms that run in this runtime, by name. */
	readonly running: Map<string, RunningRoom>;
	/** Free the name of a room, when this run is the room that holds it. */
	release(name: string, room: RunningRoom): void;
}

const stateFor = new WeakMap<Runtime, RuntimeState>();

/** The whole state of a runtime, for the core. */
export function runtimeStateOf(runtime: Runtime): RuntimeState {
	const found = stateFor.get(runtime);
	if (found === undefined) throw new Error('Runtime must come from createRuntime.');
	return found;
}

/** The part of the state that a host reads, and that an execution reads as an `ExecutionHost`. */
export function hostingOf(runtime: Runtime): Hosting {
	return runtimeStateOf(runtime);
}

export const runningRoom = (runtime: Runtime, name: string): RoomProtocol | undefined =>
	runtimeStateOf(runtime).running.get(name)?.calls;

/** The dependencies that one in-process seat needs for one captured definition. */
export interface SeatContext {
	readonly clock: Clock;
	readonly call: Limits['call'];
	readonly definition: AgentDefinition;
	readonly room: string;
	readonly seat: string;
	/** The opener of the seat: a function that opens one running activation per activation. */
	readonly opener: ActivationOpener;
	readonly emit?: (event: ActivationEvent) => void;
	/** Opens the trace sink of each activation. The driver closes it. */
	readonly trace: TraceOpener;
}

/** A room the runtime keeps in its lifecycle registry. */
export interface RunningRoom {
	readonly name: string;
	readonly calls: RoomProtocol;
	/** Drop the room from memory. The record keeps everything. */
	evict(): void;
}

/** The collaboration host's narrow request for one configured seat port. */
export interface ConnectorRequest {
	readonly room: string;
	readonly seat: string;
	readonly definition: AgentDefinition;
	readonly emit: (event: ActivationEvent) => void;
}

/**
 * How a room reaches a seat. In process, a port is the seat's own
 * `AgentRunner` over a direct handle on the room. Across a boundary, a port
 * carries the wake over, and the seat reaches back through the same
 * boundary.
 */
export interface ExecutionConnector<Port extends AgentPort = AgentPort> {
	connect(room: RoomProtocol, request: ConnectorRequest): Port;
}

export interface CreateRuntimeOptions {
	clock?: Clock;
	/** Where the runtime opens room journals. */
	storage: JournalOpener;
	/**
	 * The execution every room in this runtime uses, such as `piExecution()`
	 * from `@ambionframework/pi`, or one execution for each executor kind. A
	 * room may name its own, and the room's serve first. A seat of a kind that
	 * no supplied execution serves fails with a permanent `no_execution`
	 * error event.
	 */
	execution?: Execution | readonly Execution[];
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
		['schedule.minDelaySeconds', limits.schedule.minDelaySeconds],
		['schedule.maxDelaySeconds', limits.schedule.maxDelaySeconds],
		['schedule.waiting', limits.schedule.waiting],
	] as const) {
		if (value !== Number.POSITIVE_INFINITY && !(Number.isSafeInteger(value) && value > 0)) {
			throw new Error(`Runtime limits.${name} must be a positive integer or Infinity.`);
		}
	}
}

/** A scheduled say waits a finite least time, and the most is at least the least. */
function validateSchedule({ minDelaySeconds, maxDelaySeconds }: ScheduleLimits): void {
	if (!Number.isFinite(minDelaySeconds))
		throw new Error('Runtime limits.schedule.minDelaySeconds must be a positive integer.');
	if (maxDelaySeconds < minDelaySeconds)
		throw new Error(
			'Runtime limits.schedule.maxDelaySeconds must be at least limits.schedule.minDelaySeconds.',
		);
}

/**
 * The default wait before a retry: 30 s after the first attempt that came
 * to nothing, doubled after each next one, and never more than one hour.
 * Eight attempts span about 63 minutes of outage.
 */
function retryBackoff(attempt: number): number {
	return Math.min(30_000 * 2 ** (attempt - 1), 3_600_000);
}

export function createRuntime(options: CreateRuntimeOptions): Runtime {
	const running = new Map<string, RunningRoom>();
	const storage = options.storage;
	const journals = namespaced(storage, 'ambion/room');
	const clock = options.clock ?? systemClock();
	const given = options.limits ?? {};
	const limits: Limits = {
		port: { resend: 5_000, ...given.port },
		lease: { ttl: 60_000, deadline: 600_000, ...given.lease },
		activation: {
			attempts: 8,
			backoff: retryBackoff,
			...given.activation,
		},
		call: callLimits(given.call),
		context: { messages: 200, ...given.context },
		message: { bytes: Number.POSITIVE_INFINITY, ...given.message },
		schedule: { minDelaySeconds: 60, maxDelaySeconds: 604_800, waiting: 4, ...given.schedule },
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
		'port.resend': limits.port.resend,
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
		journals,
		clock,
		storage,
		executions: executionsOf(options.execution),
		...(options.logger === undefined ? {} : { logger: options.logger }),
		limits,
		evict(name) {
			const room = running.get(name);
			running.delete(name);
			room?.evict();
		},
		release(name, room) {
			if (running.get(name) === room) running.delete(name);
		},
	});
	return runtime;
}

/** The executions that an option names, in order. */
export function executionsOf(
	execution: Execution | readonly Execution[] | undefined,
): readonly Execution[] {
	if (execution === undefined) return [];
	return Object.freeze(isList(execution) ? [...execution] : [execution]);
}

function isList(execution: Execution | readonly Execution[]): execution is readonly Execution[] {
	return Array.isArray(execution);
}

/** The executor call bounds, checked once for every room in the runtime. */
function callLimits(given: Partial<Limits['call']> | undefined): Limits['call'] {
	const attempts = given?.attempts ?? 2;
	const timeout = given?.timeout ?? 10_000;
	if (!Number.isSafeInteger(attempts) || attempts < 1)
		throw new Error('Room call attempts must be a positive safe integer.');
	if (!Number.isFinite(timeout) || timeout <= 0)
		throw new Error('Room call timeout must be a finite positive number.');
	return { attempts, timeout };
}
