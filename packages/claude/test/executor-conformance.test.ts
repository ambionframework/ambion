/**
 * The executor suite on the Claude executor. The fixture maps each neutral
 * plan of the suite to a scenario of the fake Claude Code executable.
 */
import { describe, it } from 'vitest';
import { executorConformance } from '../../ambion/src/conformance.ts';
import { claudeExecutorFixture } from '../src/testing.ts';
import { executable } from './support.ts';

describe('claude executor', () => {
	for (const c of executorConformance(claudeExecutorFixture({ executable }))) it(c.name, c.run);
});
