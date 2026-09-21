/**
 * The harness switch of the live tier. `AMBION_HARNESS` names one of three
 * executor families, and a bad value fails at import with a clear message.
 * No key and no network: the test builds definitions and calls no model.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function harnessWith(value: string | undefined) {
	vi.resetModules();
	vi.stubEnv('AMBION_HARNESS', value ?? '');
	return import('./live/support/harness.ts');
}

afterEach(() => vi.unstubAllEnvs());

describe('the live harness switch', () => {
	it('defaults to pi', async () => {
		const harness = await harnessWith(undefined);
		expect(harness.HARNESS).toBe('pi');
		expect(harness.executorFor({ instructions: 'x' }).kind).toBe('pi');
	});

	it('selects claude with the Anthropic key', async () => {
		const harness = await harnessWith('claude');
		expect(harness.HARNESS).toBe('claude');
		expect(harness.KEY_VAR).toBe('ANTHROPIC_API_KEY');
		expect(harness.executorFor({ instructions: 'x' }).kind).toBe('claude');
	});

	it('selects codex with its model, effort, no native tools, and its key', async () => {
		const harness = await harnessWith('codex');
		expect(harness.HARNESS).toBe('codex');
		expect(harness.KEY_VAR).toBe('CODEX_API_KEY');
		expect(harness.MODEL).toBe('gpt-5.6-luna');
		expect(harness.REPORTS_COST).toBe(false);
		expect(harness.executorFor({ instructions: 'x' })).toMatchObject({
			kind: 'codex',
			model: 'gpt-5.6-luna',
			modelReasoningEffort: 'medium',
			nativeTools: 'none',
		});
	});

	it('throws on a value that names no harness', async () => {
		await expect(harnessWith('gemini')).rejects.toThrow(
			"AMBION_HARNESS is 'gemini'. Use 'pi', 'claude' or 'codex'.",
		);
	});
});
