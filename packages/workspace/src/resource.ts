/** The stable name a backend uses for one calling agent. */
export interface WorkspaceAgent {
	readonly name: string;
}

/** The minimal environment the resource owner can clean up. Every binding's env extends it. */
export interface ResourceEnv {
	cleanup(): Promise<void>;
}

/** Storage operations beneath one workspace resource owner. */
export interface ResourceBackend<Env extends ResourceEnv = ResourceEnv> {
	connect(agent: WorkspaceAgent, signal?: AbortSignal): Promise<Env>;
	/** Release host-local resources without deleting the persisted workspace. */
	dispose?(): Promise<void>;
}

/** A workspace resource and its single lifecycle and coordination owner. */
export interface WorkspaceResource<Env extends ResourceEnv = ResourceEnv> {
	readonly name: string;
	use<T>(
		agent: WorkspaceAgent,
		operation: (env: Env) => Promise<T> | T,
		signal?: AbortSignal,
	): Promise<T>;
	dispose(): Promise<void>;
}

type Phase = 'active' | 'disposing' | 'disposed';

const CLOSED = 'Workspace is no longer available.';

/**
 * Open one owner over one backend. The owner serializes complete operations,
 * including connection and callback work, so every agent sharing it observes
 * one explicit ordering policy.
 */
export function openResource<Env extends ResourceEnv = ResourceEnv>(options: {
	name: string;
	backend: ResourceBackend<Env>;
}): WorkspaceResource<Env> {
	if (!/^[a-z][a-z0-9-]*$/.test(options.name)) {
		throw new Error(
			`Invalid workspace name '${options.name}': names are lowercase, alphanumeric plus dashes.`,
		);
	}
	if (typeof options.backend?.connect !== 'function') {
		throw new Error(`Workspace '${options.name}' needs a backend with connect.`);
	}

	let phase: Phase = 'active';
	let tail = Promise.resolve();
	let disposePromise: Promise<void> | undefined;

	const ensureUsable = (signal?: AbortSignal): void => {
		if (phase !== 'active') throw new Error(CLOSED);
		if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
	};

	const use = <T>(
		agent: WorkspaceAgent,
		operation: (env: Env) => Promise<T> | T,
		signal?: AbortSignal,
	): Promise<T> => {
		try {
			ensureUsable(signal);
		} catch (error) {
			return Promise.reject(error);
		}
		const run = async () => {
			ensureUsable(signal);
			const env = await options.backend.connect(agent, signal);
			try {
				ensureUsable(signal);
				return await operation(env);
			} finally {
				await env.cleanup();
			}
		};
		const task = tail.then(run, run);
		// Keep the queue usable after either an operation succeeds or fails.
		tail = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	};

	const disposePrecondition = (): Promise<void> | undefined =>
		phase === 'disposed' ? Promise.resolve() : undefined;

	const completeDispose = async (): Promise<void> => {
		await tail;
		try {
			await options.backend.dispose?.();
			phase = 'disposed';
		} catch (error) {
			phase = 'active';
			throw error;
		}
	};

	const dispose = async (): Promise<void> => {
		const precondition = disposePrecondition();
		if (precondition) return precondition;
		if (disposePromise) return disposePromise;
		phase = 'disposing';
		const task = completeDispose();
		disposePromise = task;
		try {
			await task;
		} finally {
			if (disposePromise === task) disposePromise = undefined;
		}
	};

	return Object.freeze({ name: options.name, use, dispose });
}
