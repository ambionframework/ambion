/**
 * The executor kind switch of the live tier. `AMBION_EXECUTOR` names one of three
 * executor kinds, and a bad value fails at import with a clear message.
 * No key and no network: the test builds definitions and calls no model.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function liveWith(value: string | undefined) {
	vi.resetModules();
	vi.stubEnv('AMBION_EXECUTOR', value ?? '');
	return import('./live/support/kind.ts');
}

afterEach(() => vi.unstubAllEnvs());

describe('the live executor kind switch', () => {
	it('defaults to pi', async () => {
		const live = await liveWith(undefined);
		expect(live.LIVE_KIND).toBe('pi');
		expect(live.executorFor({ instructions: 'x' }).kind).toBe('pi');
	});

	it('selects claude with the Anthropic key', async () => {
		const live = await liveWith('claude');
		expect(live.LIVE_KIND).toBe('claude');
		expect(live.KEY_VAR).toBe('ANTHROPIC_API_KEY');
		expect(live.executorFor({ instructions: 'x' }).kind).toBe('claude');
	});

	it('selects codex with its model, effort, and its key', async () => {
		const live = await liveWith('codex');
		expect(live.LIVE_KIND).toBe('codex');
		expect(live.KEY_VAR).toBe('CODEX_API_KEY');
		expect(live.MODEL).toBe('gpt-5.6-luna');
		expect(live.REPORTS_COST).toBe(false);
		expect(live.executorFor({ instructions: 'x' })).toMatchObject({
			kind: 'codex',
			model: 'gpt-5.6-luna',
			modelReasoningEffort: 'medium',
		});
	});

	it('throws on a value that names no executor kind', async () => {
		await expect(liveWith('gemini')).rejects.toThrow(
			"AMBION_EXECUTOR is 'gemini'. Use 'pi', 'claude' or 'codex'.",
		);
	});
});
