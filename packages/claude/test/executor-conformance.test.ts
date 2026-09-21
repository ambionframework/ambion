/**
 * The executor suite on the Claude executor. The harness maps each neutral
 * plan of the suite to a scenario of the fake Claude Code executable.
 */
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { executorConformance } from '../../ambion/src/conformance.ts';
import { claudeExecutorHarness } from '../src/testing.ts';

const executable = fileURLToPath(new URL('./fake/claude-executable.mjs', import.meta.url));

for (const memory of ['activation', 'seat'] as const) {
	describe(`claude executor with ${memory} memory`, () => {
		for (const c of executorConformance(claudeExecutorHarness({ executable, memory })))
			it(c.name, c.run);
	});
}
