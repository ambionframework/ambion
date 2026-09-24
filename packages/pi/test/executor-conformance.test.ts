/**
 * The executor suite on the Pi executor. The harness maps each neutral plan
 * of the suite to a scripted stream, so the suite runs with no key.
 */
import { describe, it } from 'vitest';
import { executorConformance } from '../../ambion/src/conformance.ts';
import { piExecutorHarness } from '../src/testing.ts';

describe('pi executor', () => {
	for (const c of executorConformance(piExecutorHarness())) it(c.name, c.run);
});
