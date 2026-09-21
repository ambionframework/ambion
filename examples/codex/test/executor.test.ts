/**
 * The executor over the fake `codex`: the room tools path end to end, the
 * events it emits, and the freshness rule.
 */
import { describe, expect, it } from 'vitest';
import { open, viewOf } from './support.ts';

describe('the executor on the fake codex', () => {
	it('cites the paths of a file change on the next say', async () => {
		const run = open({ turns: [[{ change: ['/work/plan.md'] }, { say: 'Plan written.' }]] });
		const result = await run.session.pass({ kind: 'view', view: viewOf() });
		expect(result).toEqual({ failed: false });
		expect(run.commits[0]?.intent).toMatchObject({ kind: 'said', refs: ['/work/plan.md'] });
		run.session.close?.();
	});

	it('reads through the view when the turn starts, and through the say after it lands', async () => {
		const run = open({ turns: [[{ say: 'Saturday.' }]] });
		expect(run.session.readThrough).toBe(0);
		await run.session.pass({ kind: 'view', view: viewOf() });
		expect(run.commits[0]?.readThrough).toBe(1);
		expect(run.session.readThrough).toBe(2);
		expect(run.session.shouldRefresh(2)).toBe(false);
		expect(run.session.shouldRefresh(3)).toBe(true);
		run.session.close?.();
	});

	it('gives a room tool no tool event, and a tool step of its own', async () => {
		const run = open({ turns: [[{ say: 'Saturday.' }]] });
		await run.session.pass({ kind: 'view', view: viewOf() });
		expect(run.events.filter((event) => event.type.startsWith('tool_execution'))).toEqual([]);
		expect(run.steps.filter((step) => step.type === 'tool_call')).toMatchObject([{ name: 'say' }]);
		run.session.close?.();
	});

	it('emits a tool event for a command', async () => {
		const run = open({ turns: [[{ change: ['/work/a'] }]] });
		await run.session.pass({ kind: 'view', view: viewOf() });
		expect(run.events).toMatchObject([
			{ type: 'tool_execution_start', toolName: 'file_change' },
			{ type: 'tool_execution_end', toolName: 'file_change' },
		]);
		run.session.close?.();
	});

	it('reports a failed turn as an error event and a failed result', async () => {
		const run = open({ turns: [[{ fail: { text: 'unexpected status 401 Unauthorized' } }]] });
		const result = await run.session.pass({ kind: 'view', view: viewOf() });
		expect(result).toMatchObject({ failed: true, cause: 'permanent' });
		expect(run.events).toMatchObject([{ type: 'error', cause: 'permanent' }]);
		run.session.close?.();
	});

	it('has no steer, so the driver holds a steered line for the record', () => {
		const run = open({ turns: [] });
		expect(run.session.steer).toBeUndefined();
		run.session.close?.();
	});

	it('runs a second pass on the same thread with the delta', async () => {
		const run = open({ turns: [[{ say: 'One.' }], [{ say: 'Two.' }]] });
		await run.session.pass({ kind: 'view', view: viewOf() });
		const next = viewOf();
		const result = await run.session.pass({
			kind: 'delta',
			since: 2,
			view: {
				...next,
				through: 3,
				context: {
					...next.context,
					messages: [
						...next.context.messages,
						{ kind: 'said', seq: 3, at: new Date(0).toISOString(), from: 'priya', text: 'More.' },
					],
				},
			},
		});
		expect(result).toEqual({ failed: false });
		expect(run.commits.map((commit) => commit.readThrough)).toEqual([1, 3]);
		run.session.close?.();
	});
});
