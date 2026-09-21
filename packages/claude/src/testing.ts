/**
 * The tools that test a room on the Claude executor without a model: the
 * harness that runs the executor suite of `@ambionframework/ambion/conformance`
 * against a fake Claude Code executable.
 *
 * The fake is a script the SDK spawns through `pathToClaudeCodeExecutable`.
 * It reads its scenario from the `AMBION_FAKE` environment variable: a
 * JSON object with one list of actions for each turn. The harness maps each
 * plan of the suite to such a scenario.
 */
import type { ExecutorHarness, ExecutorPlan } from '@ambionframework/ambion/conformance';
import { claude } from './define.ts';
import { createClaudeExecutor } from './executor.ts';

/** One thing the fake does in a turn. `test/fake/claude-executable.mjs` lists them. */
export type FakeAction = Record<string, unknown>;

/** What the fake plays: one list of actions for each turn. */
export interface FakeScenario {
	readonly turns: readonly (readonly FakeAction[])[];
	/** A file that takes one JSON line for each fact the fake records. */
	readonly log?: string;
}

/** The scenario that performs one plan of the suite. */
export function scenarioOf(plan: ExecutorPlan): FakeScenario {
	switch (plan.kind) {
		case 'sayOnce':
			return { turns: [[{ say: plan.text }]] };
		case 'holdSay':
		case 'missThenResay':
			// A `missed` answer leaves the seat a second say.
			return { turns: [[{ sayUntilLanded: plan.text }]] };
		case 'sayEachPass':
			return { turns: [[{ say: plan.text }], [{ say: plan.text }]] };
		case 'awaitSteer':
			return { turns: [[{ awaitUser: 2 }, { say: plan.text }]] };
		case 'usage':
			return { turns: [[{ usage: { ...plan.usage } }, { say: plan.text }]] };
		case 'fail':
			return {
				turns: [
					[
						{
							fail:
								plan.cause === 'permanent'
									? { status: 401, text: 'API Error: 401 authentication_error: invalid x-api-key' }
									: { status: 529, text: 'API Error: 529 overloaded_error: try again later' },
						},
					],
				],
			};
	}
}

/** Where the fake executable is, and what it runs with. */
export interface ClaudeHarnessOptions {
	/** The path of the fake Claude Code executable. */
	readonly executable: string;
	/** Extra environment for the fake. */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The harness that runs the executor suite on the Claude executor. It
 * declares steering, usage and permanent failure, because the SDK takes a
 * message during a run, reports its spend, and names a refusal.
 */
export function claudeExecutorHarness(options: ClaudeHarnessOptions): ExecutorHarness {
	return {
		open: (plan, definition) =>
			createClaudeExecutor({
				// The suite names a neutral executor. The seat runs on a Claude one.
				definition: { ...definition, executor: claude({ instructions: '', model: 'fake' }) },
				pathToClaudeCodeExecutable: options.executable,
				env: { ...process.env, ...options.env, AMBION_FAKE: JSON.stringify(scenarioOf(plan)) },
			}),
		can: { steer: true, usage: true, permanentFailure: true },
	};
}
