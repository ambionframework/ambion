/**
 * The executor suite on a real `codex`. A recorded stream proves the
 * mapping of the Codex events, and a real model proves that the executor
 * meets the contract of the pass: the read position, the room tools, the
 * resume, the failure causes, and one error event for each failure.
 */
import { it } from 'vitest';
import { executorConformance } from '../../../ambion/src/conformance.ts';
import { codexExecutorHarness, live } from './support.ts';

live('the executor suite on a real codex', () => {
	for (const c of executorConformance(codexExecutorHarness())) it(c.name, c.run);
});
