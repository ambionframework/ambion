/**
 * The executor suite on the scripted executor. The harness maps each neutral
 * plan of the suite to a script.
 */
import { describe, it } from 'vitest';
import {
	type ExecutorHarness,
	type ExecutorPlan,
	executorConformance,
} from '../src/conformance.ts';
import {
	quiet,
	type Script,
	ScriptedFailure,
	scriptedExecutor,
	speak,
	spend,
} from '../src/testing.ts';

/** The script that performs one plan. A script runs once for each step of a pass. */
function scriptOf(plan: ExecutorPlan): Script {
	switch (plan.kind) {
		case 'sayOnce':
			return ({ results }) => (results.length === 0 ? speak(plan.text) : quiet());
		case 'holdSay':
		case 'missThenResay':
			// A `missed` answer leaves the seat a second say.
			return ({ results }) =>
				results.length === 0 || results.at(-1)?.text === 'missed' ? speak(plan.text) : quiet();
		case 'sayEachPass':
			return ({ view, results }) =>
				results.length === 0 || (results.length === 1 && view.through > 1)
					? speak(plan.text)
					: quiet();
		case 'usage':
			return ({ results }) => {
				if (results.length === 0) return spend(plan.usage);
				return results.length === 1 ? speak(plan.text) : quiet();
			};
		case 'fail':
			return () => {
				throw new ScriptedFailure(plan.cause, `The plan failed as ${plan.cause}.`);
			};
		case 'awaitSteer':
			return () => quiet();
	}
}

const harness: ExecutorHarness = {
	open: (plan, definition) => scriptedExecutor(scriptOf(plan), definition),
	can: { steer: false, usage: true, permanentFailure: true },
};

describe('scriptedExecutor', () => {
	for (const c of executorConformance(harness)) it(c.name, c.run);
});
