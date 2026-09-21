/**
 * A permission request becomes an `approval` step. The application answers
 * it, and the step carries the answer.
 */
import { expect, it } from 'vitest';
import { open, seat, viewOf } from './support.ts';

const read = { tool: 'Read', input: { file_path: 'plan.md' } };
const bash = { tool: 'Bash', input: { command: 'rm -rf /' } };

const approvals = (steps: readonly { type: string }[]) =>
	steps.filter((step) => step.type === 'approval');

it('records one approval step for each request, with the answer of canUseTool', async () => {
	const asked: string[] = [];
	const definition = seat({
		canUseTool: async (name, input) => {
			asked.push(name);
			return name === 'Read'
				? { behavior: 'allow', updatedInput: input }
				: { behavior: 'deny', message: 'No shell.' };
		},
	});
	const run = open({ turns: [[{ permission: read }, { permission: bash }]] }, definition);
	await run.session.pass({ kind: 'view', view: viewOf() });
	expect(asked).toEqual(['Read', 'Bash']);
	expect(approvals(run.steps)).toEqual([
		{ type: 'approval', call: expect.any(String), name: 'Read', decision: 'allow' },
		{ type: 'approval', call: expect.any(String), name: 'Bash', decision: 'deny' },
	]);
	const results = run.steps.filter((step) => step.type === 'tool_result');
	expect(results.map((step) => 'error' in step)).toEqual([false, true]);
	expect(run.log().filter((line) => 'permission' in line)).toHaveLength(2);
	run.session.close?.();
});

it('denies a request when the application gave no canUseTool', async () => {
	const run = open({ turns: [[{ permission: bash }]] });
	await run.session.pass({ kind: 'view', view: viewOf() });
	expect(approvals(run.steps)).toEqual([
		{ type: 'approval', call: expect.any(String), name: 'Bash', decision: 'deny' },
	]);
	run.session.close?.();
});

it('denies a request when canUseTool throws', async () => {
	const definition = seat({
		canUseTool: async () => {
			throw new Error('The policy is down.');
		},
	});
	const run = open({ turns: [[{ permission: read }]] }, definition);
	await run.session.pass({ kind: 'view', view: viewOf() });
	expect(approvals(run.steps)).toMatchObject([{ name: 'Read', decision: 'deny' }]);
	run.session.close?.();
});

it('answers for a room tool without an approval step', async () => {
	const run = open({
		turns: [[{ permission: { tool: 'mcp__ambion__say', input: { text: 'hello' } } }]],
	});
	await run.session.pass({ kind: 'view', view: viewOf() });
	expect(approvals(run.steps)).toEqual([]);
	run.session.close?.();
});
