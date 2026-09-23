import { describe, expect, it, vi } from 'vitest';
import { describeUnavailable, keyVariable, seatFamilies } from '../src/families.ts';
import { openHost } from './hosting.ts';

describe('Workbench executor families', () => {
	it('assigns each seat to a family', () => {
		expect(seatFamilies).toEqual({
			assistant: 'pi',
			datasheets: 'pi',
			design: 'claude',
			experiments: 'codex',
		});
	});

	it('names the key of each family', () => {
		expect(keyVariable('pi', {})).toBe('ANTHROPIC_API_KEY');
		expect(keyVariable('pi', { AMBION_MODEL: 'openai-codex/gpt-5' })).toBe('OPENAI_CODEX_API_KEY');
		expect(keyVariable('claude', {})).toBe('ANTHROPIC_API_KEY');
		expect(keyVariable('codex', {})).toBe('CODEX_API_KEY');
	});

	it('says which seat cannot run and why, and lists only the seats without a key', () => {
		expect(describeUnavailable({ ANTHROPIC_API_KEY: 'k' })).toEqual([
			"Seat 'experiments' cannot run: CODEX_API_KEY is not set, and the codex family needs it.",
		]);
		expect(describeUnavailable({ ANTHROPIC_API_KEY: 'k', CODEX_API_KEY: 'k' })).toEqual([]);
		expect(describeUnavailable({})).toHaveLength(4);
	});
});

describe('Workbench with no key', () => {
	it('marks every seat, fails an activation with the missing key, and keeps the room running', async () => {
		const workbench = await openHost({ env: {}, stream: undefined, executions: undefined });
		expect((await workbench.read('sensing', 0)).unavailable).toEqual([
			'assistant',
			'datasheets',
			'design',
			'experiments',
		]);
		await workbench.join('sensing', 'theo');
		await workbench.send('sensing', 'theo', 'nokey-1', 'Plan a test.');
		await vi.waitFor(async () => {
			const view = await workbench.read('sensing', 0);
			const errors = view.activity.filter((item) => item.type === 'error');
			expect(errors.map((item) => item.text).join('\n')).toContain(
				"Seat 'assistant' cannot run: ANTHROPIC_API_KEY is not set",
			);
			expect(view.status).toBe('running');
		});
	});
});
