/**
 * What the objects need beyond their storage: the definitions they resolve
 * by name, and the model call they make. A worker configures it once at
 * module scope, and every object in the isolate reads it.
 */
import type { AgentDefinition, CreateRuntimeOptions, Runtime } from '@ambionframework/ambion';
import { createRuntime } from '@ambionframework/ambion';

export interface ConfigureOptions {
	/** Every definition a room in this worker may seat, by name. */
	agents: readonly AgentDefinition[];
	/** The model call. Defaults to Pi's registry, keyed from the environment. */
	stream?: CreateRuntimeOptions['stream'];
	wake?: CreateRuntimeOptions['wake'];
	retry?: CreateRuntimeOptions['retry'];
}

let settings: ConfigureOptions | undefined;

export function configure(options: ConfigureOptions): void {
	settings = options;
}

/** A runtime over this object's storage and clock, with the worker's catalog and model call. */
export function runtimeFor(
	options: Pick<CreateRuntimeOptions, 'sessions' | 'clock' | 'transport'>,
): Runtime {
	if (settings === undefined) {
		throw new Error('Call configure() at module scope before an object runs.');
	}
	return createRuntime({
		agents: settings.agents,
		...(settings.stream === undefined ? {} : { stream: settings.stream }),
		...(settings.wake === undefined ? {} : { wake: settings.wake }),
		...(settings.retry === undefined ? {} : { retry: settings.retry }),
		...options,
	});
}

export function definitionOf(name: string): AgentDefinition {
	const def = settings?.agents.find((agent) => agent.name === name);
	if (def === undefined) throw new Error(`'${name}' is not configured in this worker.`);
	return def;
}
