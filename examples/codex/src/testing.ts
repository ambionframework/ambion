/**
 * The tools that test a room on the Codex executor without a model: the
 * harness that runs the executor suite of `@ambionframework/ambion/conformance`
 * against a fake `codex` executable.
 *
 * The SDK spawns the fake for each turn. The fake reads its scenario from
 * the `AMBION_FAKE` environment variable: a JSON object with one list of
 * actions for each turn. The harness maps each plan of the suite to such a
 * scenario.
 */
import type { ExecutorHarness, ExecutorPlan } from '@ambionframework/ambion/conformance';
import { codex } from './define.ts';
import { createCodexExecutor } from './executor.ts';

/** One thing the fake does in a turn. `test/fake/codex` lists them. */
export type FakeAction = Record<string, unknown>;

/** What the fake plays: one list of actions for each turn. */
export interface FakeScenario {
	readonly turns: readonly (readonly FakeAction[])[];
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
			// Codex takes no steer into a turn, so the harness declares no live steer.
			return { turns: [[{ say: plan.text }]] };
		case 'usage':
			return { turns: [[{ usage: { ...plan.usage } }, { say: plan.text }]] };
		case 'fail':
			return {
				turns: [
					[
						{
							fail:
								plan.cause === 'permanent'
									? { text: 'unexpected status 401 Unauthorized: invalid api key' }
									: { text: 'stream error: 529 overloaded_error: try again later' },
						},
					],
				],
			};
	}
}

/** Where the fake executable is, and what it runs with. */
export interface CodexHarnessOptions {
	/** The path of the fake `codex` executable. */
	readonly executable: string;
	/** Extra environment for the fake. */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The harness that runs the executor suite on the Codex executor. It
 * declares usage and permanent failure, because Codex reports its tokens
 * and names a refusal. It declares no steer, because Codex takes no message
 * into a turn.
 */
export function codexExecutorHarness(options: CodexHarnessOptions): ExecutorHarness {
	return {
		open: (plan, definition) =>
			createCodexExecutor({
				// The suite names a neutral executor. The seat runs on a Codex one.
				definition: { ...definition, executor: codex({ instructions: '', model: 'fake' }) },
				codexPath: options.executable,
				env: { ...process.env, ...options.env, AMBION_FAKE: JSON.stringify(scenarioOf(plan)) },
			}),
		can: { steer: false, usage: true, permanentFailure: true },
	};
}
