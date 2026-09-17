import { AssertionError } from 'node:assert';
import type { HumanDefinition } from '@ambionframework/ambion';
import { defineEval } from './definition.ts';
import { evidence } from './evidence.ts';
import { toJsonValue } from './json.ts';
import { runSimulation } from './simulation-runner.ts';
import type {
	RoomEval,
	RoomEvalAsEval,
	RoomEvalSetupResult,
	SimulationResult,
} from './simulation-types.ts';
import type { EvalCheck } from './types.ts';

const SIMULATION_EVIDENCE = 'simulation';

class SimulationUnsafeError extends Error {
	readonly unsafeToContinue = true;
	readonly result: SimulationResult;

	constructor(result: SimulationResult) {
		super('The room simulation has unresolved work and cannot continue safely.');
		this.name = 'SimulationUnsafeError';
		this.result = result;
	}
}

interface InternalFixture<Fixture> extends RoomEvalSetupResult<Fixture> {
	result?: SimulationResult;
	pending?: Promise<SimulationResult>;
}

/** Define a declarative room simulation that runs on the existing eval lifecycle. */
export function defineRoomEval<Input, Fixture>(
	definition: RoomEval<Input, Fixture>,
): RoomEvalAsEval<Input, Fixture> {
	validateRoomDefinition(definition);
	const humans = captureHumans(definition.humans);
	const checks = simulationChecks(definition);
	const adapted: RoomEvalAsEval<Input, Fixture> = {
		id: definition.id,
		version: definition.version,
		scope: 'room',
		input: definition.input,
		async setup(context) {
			const prepared = await definition.setup(context);
			assertSetupResult(prepared, definition.id);
			const owned: InternalFixture<Fixture> = { ...prepared };
			context.manage({
				abort: () => owned.room.abort(),
				settle: async () => {
					await owned.pending?.catch(() => undefined);
				},
				dispose: () => owned.room.stop(),
			});
			return owned;
		},
		async run(context) {
			const fixture = context.fixture as InternalFixture<Fixture>;
			fixture.pending = runSimulation({
				room: fixture.room,
				humans,
				simulator: definition.simulator,
				limits: definition.limits,
				signal: context.signal,
				fixture: fixture.fixture,
				deliveryPrefix: context.attemptId,
				beforeAction:
					definition.beforeAction === undefined
						? undefined
						: ({ fixture, action, index, signal }) =>
								definition.beforeAction?.({
									...context,
									fixture: fixture as Fixture,
									action,
									index,
									signal,
								}),
			});
			const result = await fixture.pending;
			fixture.result = result;
			if (result.unsafeToContinue) throw new SimulationUnsafeError(result);
			return result;
		},
		async capture(context) {
			const internal = context.fixture as InternalFixture<Fixture> | undefined;
			const result = (context.output as SimulationResult | undefined) ?? internal?.result;
			const captured =
				context.outcome.unsafeToContinue || result?.unsafeToContinue
					? {}
					: await definition.capture({
							...context,
							fixture: internal?.fixture,
							result,
						});
			const userArtifacts =
				result?.settled === true && !result.unsafeToContinue
					? captured
					: incompleteArtifacts(captured);
			return {
				...userArtifacts,
				[SIMULATION_EVIDENCE]: evidence(
					result === undefined ? null : toJsonValue(result, `${definition.id} simulation result`),
					{
						complete:
							result?.settled === true &&
							!result.unsafeToContinue &&
							!context.outcome.unsafeToContinue,
					},
				),
			};
		},
		checks,
		async teardown(context) {
			await definition.teardown({
				...context,
				fixture: context.fixture?.fixture,
				room: context.fixture?.room,
				result: (context.fixture as InternalFixture<Fixture> | undefined)?.result,
			});
		},
	};
	return defineEval(adapted);
}

function validateRoomDefinition<Input, Fixture>(definition: RoomEval<Input, Fixture>): void {
	if (definition.humans.length === 0) throw new TypeError('A room eval needs at least one human.');
	const names = new Set<string>();
	for (const human of definition.humans) {
		if (human.name.trim() === '') throw new TypeError('A simulation human needs a name.');
		if (names.has(human.name)) throw new TypeError(`Duplicate simulation human '${human.name}'.`);
		names.add(human.name);
	}
	if (!Number.isSafeInteger(definition.limits.maxActions) || definition.limits.maxActions < 1)
		throw new TypeError('Simulation maxActions must be a positive safe integer.');
	if (!Number.isFinite(definition.limits.settleTimeoutMs) || definition.limits.settleTimeoutMs <= 0)
		throw new TypeError('Simulation settleTimeoutMs must be positive and finite.');
}

function incompleteArtifacts(
	artifacts: Awaited<ReturnType<RoomEval<never, never>['capture']>>,
): typeof artifacts {
	return Object.fromEntries(
		Object.entries(artifacts).map(([kind, raw]) => {
			if (
				raw !== null &&
				typeof raw === 'object' &&
				!Array.isArray(raw) &&
				'$evidence' in raw &&
				raw.$evidence === true &&
				'value' in raw
			)
				return [kind, { ...raw, complete: false }];
			return [kind, evidence(toJsonValue(raw, `evidence ${kind}`), { complete: false })];
		}),
	);
}

function simulationChecks<Input, Fixture>(
	definition: RoomEval<Input, Fixture>,
): readonly EvalCheck<SimulationResult>[] {
	const ids = new Set([...definition.checks.map((check) => check.id), definition.judge.id]);
	if (ids.has('simulation-complete'))
		throw new TypeError("Room eval check ID 'simulation-complete' is reserved.");
	return [simulationCompletionCheck(), ...definition.checks, definition.judge];
}

function simulationCompletionCheck(): EvalCheck<SimulationResult> {
	return {
		id: 'simulation-complete',
		requires: [SIMULATION_EVIDENCE],
		async evaluate({ output }) {
			if (output.termination.status !== 'finished')
				throw new AssertionError({ message: `Simulation ended as ${output.termination.status}.` });
			if (output.actions.every((action) => action.kind !== 'say'))
				throw new AssertionError({ message: 'Simulation finished without a human message.' });
		},
	};
}

function captureHumans(humans: readonly HumanDefinition[]): readonly HumanDefinition[] {
	return Object.freeze(
		humans.map((human) =>
			Object.freeze({
				name: human.name,
				identity: human.identity,
				...(human.preferences === undefined ? {} : { preferences: human.preferences }),
			}),
		),
	);
}

function assertSetupResult<Fixture>(
	prepared: RoomEvalSetupResult<Fixture>,
	id: string,
): asserts prepared is RoomEvalSetupResult<Fixture> {
	if (
		prepared === null ||
		typeof prepared !== 'object' ||
		prepared.room === undefined ||
		typeof prepared.room.read !== 'function' ||
		typeof prepared.room.visit !== 'function'
	)
		throw new TypeError(`Room eval '${id}' setup must return { room, fixture }.`);
}
