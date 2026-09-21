/**
 * The default execution of an executor family.
 *
 * The kernel imports no model library, so it cannot build an execution
 * itself. An executor package registers a factory for its `kind` when the
 * host loads it. A room with no `execution` asks this registry for the
 * kind of each seat. The registry holds functions and never enters the
 * journal, a captured definition, or the wire.
 */
import type { Execution } from './runtime.ts';

const factories = new Map<string, () => Execution>();

/**
 * Name the execution that serves seats of `kind` when a host passes none.
 * A second registration for the same kind replaces the first.
 */
export function registerDefaultExecution(kind: string, factory: () => Execution): void {
	factories.set(kind, factory);
}

/** The factory registered for `kind`, or nothing. */
export function defaultExecutionFactory(kind: string): (() => Execution) | undefined {
	return factories.get(kind);
}
