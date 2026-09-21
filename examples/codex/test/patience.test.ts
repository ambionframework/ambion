/**
 * The harness waits longer than the suite default. A case of two turns
 * starts four Node processes, and a CI runner took over 5 seconds for it.
 */
import { describe, expect, it } from 'vitest';
import { CODEX_PATIENCE, codexExecutorHarness } from '../src/testing.ts';
import config from '../vitest.config.ts';

describe('codex harness patience', () => {
	it('exceeds the suite default of 5 seconds', () => {
		expect(codexExecutorHarness({ executable: 'codex' }).patience).toBe(CODEX_PATIENCE);
		expect(CODEX_PATIENCE).toBeGreaterThanOrEqual(15_000);
	});

	it('ends before the test timeout, so a stall names what it waited for', () => {
		expect(CODEX_PATIENCE).toBeLessThan(config.test?.testTimeout ?? 0);
	});
});
