/**
 * What the objects need beyond their storage: the definitions they resolve
 * by name, and the model call they make. A worker configures it once at
 * module scope, and every object in the isolate reads it.
 */
import type {
	AgentDefinition,
	CreateRuntimeOptions,
	RoomNotification,
	Runtime,
} from '@ambionframework/ambion';
import { createRuntime } from '@ambionframework/ambion';
import { createExecutionServices } from '@ambionframework/ambion/transport';

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
	event: RoomNotification['type'];
	tool?: string;
	error?: string;
	at: string;
}

export interface ConfigureOptions {
	/** Every definition a room in this worker may seat, by name. */
	agents: readonly AgentDefinition[];
	/** The model call. Defaults to Pi's registry, keyed from the environment. */
	stream?: CreateRuntimeOptions['stream'];
	wake?: CreateRuntimeOptions['wake'];
	retry?: CreateRuntimeOptions['retry'];
	/**
	 * What to do with an event a seat raised. An activation runs inside the
	 * seat's own object and its events reach no other, so this is the only way
	 * a reader outside that object learns a tool was called. It writes one
	 * structured log line by default, because Cloudflare indexes the fields of
	 * an object given to `console.log`. Pass a function to send them elsewhere,
	 * or one that does nothing to keep them out of the logs.
	 */
	onSeatEvent?: (event: SeatEvent) => void;
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

/** A runtime over this object's storage and clock, with the worker's model call. */
export function runtimeFor(
	options: Pick<CreateRuntimeOptions, 'storage' | 'clock' | 'transport'>,
): Runtime {
	if (settings === undefined) {
		throw new Error('Call configure() at module scope before an object runs.');
	}
	return createRuntime({
		...(settings.stream === undefined ? {} : { stream: settings.stream }),
		...(settings.wake === undefined ? {} : { wake: settings.wake }),
		...(settings.retry === undefined ? {} : { retry: settings.retry }),
		...options,
	});
}

/** Compose model and transcript services for a seat object over its own storage. */
export function executionFor(
	options: Pick<Parameters<typeof createExecutionServices>[0], 'storage' | 'clock'>,
): ReturnType<typeof createExecutionServices> {
	if (settings === undefined) {
		throw new Error('Call configure() at module scope before an object runs.');
	}
	return createExecutionServices({
		...options,
		...(settings.stream === undefined ? {} : { stream: settings.stream }),
	});
}

export function definitionOf(name: string): AgentDefinition {
	const def = settings?.agents.find((agent) => agent.name === name);
	if (def === undefined) throw new Error(`'${name}' is not configured in this worker.`);
	return def;
}
