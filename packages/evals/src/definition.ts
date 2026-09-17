import type { Eval, EvalCheck, EvalTimeouts, RunEvalsOptions } from './types.ts';

export const defaultEvalTimeouts: EvalTimeouts = {
	setup: 90_000,
	run: 90_000,
	settle: 90_000,
	capture: 10_000,
	check: 30_000,
	teardown: 10_000,
	cleanup: 10_000,
};

export function defineEval<Input, Fixture, Output>(
	definition: Eval<Input, Fixture, Output>,
): Eval<Input, Fixture, Output> {
	return definition;
}

export function validateSuite(evals: readonly Eval<unknown, unknown, unknown>[]): void {
	if (evals.length === 0) throw new TypeError('At least one eval is required.');
	const ids = new Set<string>();
	for (const definition of evals) {
		validateEvalIdentity(definition, ids);
		ids.add(definition.id);
		validateChecks(definition);
	}
}

function validateEvalIdentity(
	definition: Eval<unknown, unknown, unknown>,
	ids: ReadonlySet<string>,
): void {
	if (definition.id.length === 0 || ids.has(definition.id))
		throw new TypeError(`Eval ID is empty or duplicated: ${definition.id}`);
	if (!Number.isInteger(definition.version) || definition.version < 1)
		throw new TypeError(`Eval ${definition.id} has an invalid version.`);
	if (definition.checks.length === 0)
		throw new TypeError(`Eval ${definition.id} needs at least one check.`);
}

function validateChecks(definition: Eval<unknown, unknown, unknown>): void {
	const checkIds = new Set<string>();
	for (const check of definition.checks) {
		if (check.id.length === 0 || checkIds.has(check.id))
			throw new TypeError(`Eval ${definition.id} has a duplicate check ID.`);
		checkIds.add(check.id);
		validateCheckRequirements(check);
	}
}

function validateCheckRequirements(check: EvalCheck<unknown>): void {
	if (check.requires.length === 0)
		throw new TypeError(`Check ${check.id} must require at least one evidence collection.`);
	if (check.requires.some((kind) => kind.length === 0))
		throw new TypeError(`Check ${check.id} has an empty evidence requirement.`);
}

export function sampleCount(
	definition: Eval<unknown, unknown, unknown>,
	options: RunEvalsOptions,
): number {
	const configured = options.samplesPerEval;
	const value =
		typeof configured === 'function'
			? configured(definition)
			: (configured ?? options.samples ?? 1);
	if (!Number.isInteger(value) || value < 1)
		throw new TypeError(`Invalid sample count for ${definition.id}.`);
	return value;
}
