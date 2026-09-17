import { makeError } from './errors.ts';
import type { Cleanup, EvalPhase, EvaluationError, ManagedResource } from './types.ts';

interface PhaseSuccess<T> {
	readonly ok: true;
	readonly value: T;
}

export interface PhaseFailure {
	readonly ok: false;
	readonly error: EvaluationError;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly unsafeToContinue: boolean;
}

type PhaseResult<T> = PhaseSuccess<T> | PhaseFailure;

export async function phase<T>(
	phaseName: EvalPhase,
	timeoutMs: number,
	parentSignal: AbortSignal | undefined,
	phases: Record<EvalPhase, number> | undefined,
	task: (signal: AbortSignal) => Promise<T>,
): Promise<PhaseResult<T>> {
	if (parentSignal?.aborted) return abortedPhase(phaseName, parentSignal.reason);
	const controller = new AbortController();
	const started = Date.now();
	const race = await racePhase(controller, parentSignal, timeoutMs, task);
	if (phases !== undefined) phases[phaseName] += Date.now() - started;
	return resolvePhaseRace(phaseName, parentSignal, controller, race);
}

type PhaseCallbackResult<T> =
	{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

type PhaseWinner<T> = PhaseCallbackResult<T> | 'timeout' | 'aborted';

async function racePhase<T>(
	controller: AbortController,
	parentSignal: AbortSignal | undefined,
	timeoutMs: number,
	task: (signal: AbortSignal) => Promise<T>,
): Promise<{ winner: PhaseWinner<T>; settled: boolean }> {
	let abortResolve: ((value: 'aborted') => void) | undefined;
	const externalAbort = new Promise<'aborted'>((resolve) => {
		abortResolve = resolve;
	});
	const onAbort = () => {
		controller.abort(parentSignal?.reason);
		abortResolve?.('aborted');
	};
	parentSignal?.addEventListener('abort', onAbort, { once: true });
	let settled = false;
	const callbackResult: Promise<PhaseCallbackResult<T>> = Promise.resolve()
		.then(() => task(controller.signal))
		.then(
			(value) => {
				settled = true;
				return { ok: true as const, value };
			},
			(error: unknown) => {
				settled = true;
				return { ok: false as const, error };
			},
		);
	let timer: NodeJS.Timeout | undefined;
	const timeout =
		Number.isFinite(timeoutMs) && timeoutMs >= 0
			? new Promise<'timeout'>((resolve) => {
					timer = setTimeout(() => resolve('timeout'), timeoutMs);
				})
			: new Promise<'timeout'>(() => undefined);
	const winner = await Promise.race([callbackResult, timeout, externalAbort]);
	if (timer !== undefined) clearTimeout(timer);
	parentSignal?.removeEventListener('abort', onAbort);
	return { winner, settled };
}

function abortedPhase(phaseName: EvalPhase, reason: unknown): PhaseFailure {
	return {
		ok: false,
		error: makeError(phaseName, reason),
		timedOut: false,
		aborted: true,
		unsafeToContinue: false,
	};
}

function resolvePhaseRace<T>(
	phaseName: EvalPhase,
	parentSignal: AbortSignal | undefined,
	controller: AbortController,
	race: { winner: PhaseWinner<T>; settled: boolean },
): PhaseResult<T> {
	if (race.winner === 'timeout') {
		controller.abort(new Error(`${phaseName} deadline exceeded`));
		return {
			ok: false,
			error: makeError(phaseName, new PhaseTimeoutError(`${phaseName} deadline exceeded`)),
			timedOut: true,
			aborted: false,
			unsafeToContinue: !race.settled,
		};
	}
	if (race.winner === 'aborted') {
		return {
			ok: false,
			error: makeError(
				phaseName,
				parentSignal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
			),
			timedOut: false,
			aborted: true,
			unsafeToContinue: !race.settled,
		};
	}
	if (race.winner.ok) return race.winner;
	return {
		ok: false,
		error: makeError(phaseName, race.winner.error),
		timedOut: false,
		aborted: controller.signal.aborted || parentSignal?.aborted === true,
		unsafeToContinue: unsafeFailure(race.winner.error),
	};
}

/** An adapter may detect unresolved work beneath an otherwise completed callback. */
function unsafeFailure(error: unknown): boolean {
	return error instanceof Error && 'unsafeToContinue' in error && error.unsafeToContinue === true;
}

export async function settleResources(
	resources: readonly ManagedResource[],
	timeoutMs: number,
	parentSignal: AbortSignal | undefined,
	phases: Record<EvalPhase, number>,
	abortFirst: boolean,
): Promise<{ errors: EvaluationError[]; timedOut: boolean; unsafeToContinue: boolean }> {
	const errors: EvaluationError[] = [];
	let timedOut = false;
	let unsafeToContinue = false;
	const result = await phase('settle', timeoutMs, parentSignal, phases, async (signal) => {
		for (const resource of resources) {
			if (abortFirst && resource.abort !== undefined) await resource.abort(signal);
			if (resource.settle !== undefined) await resource.settle(signal);
		}
	});
	if (!result.ok) {
		errors.push(result.error);
		timedOut = result.timedOut;
		unsafeToContinue = result.unsafeToContinue;
	}
	return { errors, timedOut, unsafeToContinue };
}

export async function cleanupDeferred(
	callbacks: readonly Cleanup[],
	timeoutMs: number,
	parentSignal: AbortSignal | undefined,
	phases: Record<EvalPhase, number>,
): Promise<{ errors: EvaluationError[]; timedOut: boolean; unsafeToContinue: boolean }> {
	const errors: EvaluationError[] = [];
	let timedOut = false;
	let unsafeToContinue = false;
	for (const cleanup of [...callbacks].reverse()) {
		const result = await phase('cleanup', timeoutMs, parentSignal, phases, (signal) =>
			Promise.resolve(cleanup(signal)),
		);
		if (!result.ok) {
			errors.push(result.error);
			timedOut ||= result.timedOut;
			unsafeToContinue ||= result.unsafeToContinue;
		}
	}
	return { errors, timedOut, unsafeToContinue };
}

export async function cleanupManaged(
	resources: readonly ManagedResource[],
	timeoutMs: number,
	parentSignal: AbortSignal | undefined,
	phases: Record<EvalPhase, number>,
): Promise<{ errors: EvaluationError[]; timedOut: boolean; unsafeToContinue: boolean }> {
	const errors: EvaluationError[] = [];
	let timedOut = false;
	let unsafeToContinue = false;
	for (const resource of [...resources].reverse()) {
		const dispose = resource.dispose ?? resource.close;
		if (dispose === undefined) continue;
		const result = await phase('cleanup', timeoutMs, parentSignal, phases, (signal) =>
			Promise.resolve(dispose.call(resource, signal)),
		);
		if (!result.ok) {
			errors.push(result.error);
			timedOut ||= result.timedOut;
			unsafeToContinue ||= result.unsafeToContinue;
		}
	}
	return { errors, timedOut, unsafeToContinue };
}

export function emptyPhases(): Record<EvalPhase, number> {
	return { setup: 0, run: 0, settle: 0, capture: 0, check: 0, teardown: 0, cleanup: 0, persist: 0 };
}

class PhaseTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PhaseTimeoutError';
	}
}
