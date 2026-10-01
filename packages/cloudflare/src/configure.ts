/**
 * What the objects need beyond their storage: the definitions they resolve
 * by name, and the model call they make. A worker configures it once at
 * module scope, and every object in the isolate reads it.
 */
import type {
	ActivationEvent,
	AgentDefinition,
	CreateRuntimeOptions,
	Runtime,
	TraceLogger,
} from '@ambionframework/ambion';
import { createRuntime } from '@ambionframework/ambion';
import type { AgentRunner, Execution, ExecutionHost } from '@ambionframework/ambion/hosting';
import { hostingOf } from '@ambionframework/ambion/hosting';
import { type PiExecutionOptions, piExecution } from '@ambionframework/pi';

/**
 * One event a seat raised inside its own object, flat enough to be a journal
 * line. The three names say which activation raised it, and `ambion` marks
 * the line for a query that reads the logs back.
 */
export interface SeatEvent {
	ambion: 'seat';
	room: string;
	seat: string;
	activation: string;
	event: ActivationEvent['type'];
	operation?: Extract<ActivationEvent, { type: 'delivery_error' }>['operation'];
	tool?: string;
	error?: string;
	at: string;
}

export interface ConfigureOptions {
	/** Every definition a room in this worker may seat, by name. */
	agents: readonly AgentDefinition[];
	/** The model call. Defaults to Pi's registry, keyed from the environment. */
	stream?: PiExecutionOptions['stream'];
	limits?: CreateRuntimeOptions['limits'];
	/**
	 * The token estimators an agent may name in `estimateTokens`. The room
	 * object runs the estimator of a seat, so the definition carries the name
	 * alone. Every runtime also holds `length`.
	 */
	estimators?: CreateRuntimeOptions['estimators'];
	/**
	 * What to do with an event a seat raised. An activation runs inside the
	 * seat's own object and its events reach no other, so this is the only way
	 * a reader outside that object learns a tool was called. It writes one
	 * structured log line by default, because Cloudflare indexes the fields of
	 * an object given to `console.log`. Pass a function to send them elsewhere,
	 * or one that does nothing to keep them out of the logs.
	 */
	onSeatEvent?: (event: SeatEvent) => void;
	/**
	 * Where the steps of each activation go. Absent, the seat drops them. Pass
	 * `(record) => console.log({ ambion: 'step', ...record })` to send them to
	 * Workers Logs.
	 */
	logger?: TraceLogger;
}

let settings: ConfigureOptions | undefined;

export function configure(options: ConfigureOptions): void {
	const agents = Object.freeze([...options.agents]);
	const names = new Set<string>();
	for (const agent of agents) {
		if (names.has(agent.name)) throw new Error(`Worker definitions repeat agent '${agent.name}'.`);
		names.add(agent.name);
	}
	settings = { ...options, agents };
}

/** Give a seat's event to whatever the worker configured, or to the logs. */
export function seatEvent(event: SeatEvent): void {
	const take = settings?.onSeatEvent ?? ((line: SeatEvent) => console.log(line));
	take(event);
}

/** The settings that `configure` took, or an error when a worker never called it. */
function configured(): ConfigureOptions {
	if (settings === undefined) {
		throw new Error('Call configure() at module scope before an object runs.');
	}
	return settings;
}

/** A runtime over this object's storage and clock, on the execution that reaches each seat. */
export function runtimeFor(
	options: Pick<CreateRuntimeOptions, 'storage' | 'clock' | 'execution'>,
): Runtime {
	const { limits, estimators } = configured();
	return createRuntime({
		...(limits === undefined ? {} : { limits }),
		...(estimators === undefined ? {} : { estimators }),
		...options,
	});
}

/**
 * The execution of a seat object: the Pi execution with the worker's model
 * call. An object has no local disk, so the seat keeps its sessions in
 * memory for as long as the connector lives.
 */
export function seatExecution(): Execution<AgentRunner> {
	const { stream } = configured();
	return piExecution({ sessions: 'memory', ...(stream === undefined ? {} : { stream }) });
}

/** The host of a seat object: the system clock, and the worker's limits and logger. */
export function seatHost(): ExecutionHost {
	const { limits, logger } = configured();
	const hosting = hostingOf(createRuntime({ ...(limits === undefined ? {} : { limits }) }));
	return {
		clock: hosting.clock,
		storage: hosting.storage,
		limits: hosting.limits,
		...(logger === undefined ? {} : { logger }),
	};
}

/** Every definition the worker configured. A resume resolves the names of a record from them. */
export function configuredAgents(): readonly AgentDefinition[] {
	return configured().agents;
}

export function definitionOf(name: string): AgentDefinition {
	const def = settings?.agents.find((agent) => agent.name === name);
	if (def === undefined) throw new Error(`'${name}' is not configured in this worker.`);
	return def;
}
