import type { ExecutionEnv } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';

/** The stable identity a backend uses for one calling agent. */
export interface WorkspaceAgent {
	readonly name: string;
	readonly identity: string;
}

/** Storage operations beneath one workspace resource owner. */
export interface ResourceBackend {
	connect(agent: WorkspaceAgent, signal?: AbortSignal): Promise<ExecutionEnv>;
	destroy(): Promise<void>;
	/** Release host-local resources without deleting the persisted workspace. */
	dispose?(): Promise<void>;
}

/** A workspace resource and its single lifecycle and coordination owner. */
export interface WorkspaceResource {
	readonly name: string;
	use<T>(
		agent: WorkspaceAgent,
		operation: (env: ExecutionEnv) => Promise<T> | T,
		signal?: AbortSignal,
	): Promise<T>;
	dispose(): Promise<void>;
	destroy(): Promise<void>;
}

type Phase = 'active' | 'disposing' | 'destroying' | 'disposed' | 'destroyed';

const CLOSED = 'Workspace is no longer available.';

/**
 * Open one owner over one backend. The owner serializes complete operations,
 * including connection and callback work, so every agent sharing it observes
 * one explicit ordering policy.
 */
export function openResource(options: {
	name: string;
	backend: ResourceBackend;
}): WorkspaceResource {
	if (!/^[a-z][a-z0-9-]*$/.test(options.name)) {
		throw new Error(
			`Invalid workspace name '${options.name}': names are lowercase, alphanumeric plus dashes.`,
		);
	}
	if (
		typeof options.backend?.connect !== 'function' ||
		typeof options.backend?.destroy !== 'function'
	) {
		throw new Error(`Workspace '${options.name}' needs a backend with connect and destroy.`);
	}

	let phase: Phase = 'active';
	let tail = Promise.resolve();
	let destroyPromise: Promise<void> | undefined;
	let disposePromise: Promise<void> | undefined;

	const ensureUsable = (signal?: AbortSignal): void => {
		if (phase !== 'active') throw new Error(CLOSED);
		if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
	};

	const use = <T>(
		agent: WorkspaceAgent,
		operation: (env: ExecutionEnv) => Promise<T> | T,
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
				await env.cleanup(BACKGROUND_CONTEXT);
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

	const completeDestroy = async (): Promise<void> => {
		await tail;
		try {
			await options.backend.destroy();
			phase = 'destroyed';
		} catch (error) {
			phase = 'active';
			throw error;
		}
	};

	const destroyPrecondition = (): Promise<void> | undefined => {
		switch (phase) {
			case 'destroyed':
				return Promise.resolve();
			case 'disposed':
				return Promise.reject(new Error('Workspace has been disposed.'));
			case 'disposing':
				return Promise.reject(new Error('Workspace disposal is in progress.'));
			default:
				return undefined;
		}
	};

	const destroy = async (): Promise<void> => {
		const precondition = destroyPrecondition();
		if (precondition) return precondition;
		if (destroyPromise) return destroyPromise;
		phase = 'destroying';
		const task = completeDestroy();
		destroyPromise = task;
		try {
			await task;
		} finally {
			if (destroyPromise === task) destroyPromise = undefined;
		}
	};

	const disposePrecondition = (): Promise<void> | undefined => {
		switch (phase) {
			case 'disposed':
			case 'destroyed':
				return Promise.resolve();
			case 'destroying':
				return destroyPromise ?? Promise.resolve();
			default:
				return undefined;
		}
	};

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

	return Object.freeze({ name: options.name, use, dispose, destroy });
}
