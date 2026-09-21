import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { team } from '../src/definitions.ts';
import { describeUnavailable, keyVariable, seatFamilies } from '../src/families.ts';
import { openWorkbench, type Workbench } from '../src/workbench.ts';

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

	it('gives each specialist the executor of its family', () => {
		const bundle = (name: string) =>
			({ tools: () => ({ name, guidance: '', tools: [] }) }) as never;
		const built = team(bundle('workspace'), bundle('lab'), bundle('instrument'));
		const executors = Object.fromEntries(
			built.specialists.map((seat) => [seat.name, seat.executor]),
		);
		expect(executors.datasheets).toMatchObject({ kind: 'pi' });
		expect(executors.design).toMatchObject({ kind: 'claude', model: 'claude-sonnet-5' });
		expect(executors.experiments).toMatchObject({
			kind: 'codex',
			model: 'gpt-5.6-luna',
			modelReasoningEffort: 'medium',
		});
	});
});

describe('Workbench with no key', () => {
	const opened: { workbench: Workbench; directory: string }[] = [];

	afterEach(async () => {
		for (const { workbench, directory } of opened.splice(0)) {
			await workbench.close().catch(() => undefined);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('marks every seat, fails an activation with the missing key, and keeps the room running', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-workbench-nokey-'));
		const workbench = await openWorkbench({ directory: join(directory, 'run'), env: {} });
		opened.push({ workbench, directory });
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
