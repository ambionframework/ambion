/**
 * The policy options of `claude()` reach the SDK. The fake executable logs
 * the arguments the SDK gave it, the initialize request, and each permission
 * answer. A permission request becomes an `approval` step: the application
 * answers it, and the step carries the answer.
 */
import { expect, it } from 'vitest';
import { open, seat, viewOf } from './support.ts';

async function argvOf(options: Parameters<typeof seat>[0] = {}) {
	const run = open({ turns: [[]] }, seat(options));
	await run.session.pass({ kind: 'view', view: viewOf() });
	run.session.close?.();
	const lines = run.log();
	const argv = lines.find((line) => 'argv' in line)?.argv as string[];
	const initialize = lines.find((line) => 'initialize' in line)?.initialize as Record<
		string,
		unknown
	>;
	return { argv, initialize, cwd: lines.find((line) => 'cwd' in line)?.cwd };
}

const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

it('passes the policy options to the SDK, reads no settings source, and names the built-in tools of the policy only', async () => {
	const { argv, cwd } = await argvOf({
		permissionMode: 'acceptEdits',
		allowedTools: ['Read', 'Bash(git status:*)'],
		disallowedTools: ['WebFetch'],
		maxBudgetUsd: 2,
		effort: 'high',
		cwd: '/tmp',
		additionalDirectories: ['/var'],
	});
	expect(flagValue(argv, '--permission-mode')).toBe('acceptEdits');
	expect(flagValue(argv, '--allowedTools')).toBe('Read,Bash(git status:*)');
	expect(flagValue(argv, '--disallowedTools')).toBe('WebFetch');
	expect(flagValue(argv, '--max-budget-usd')).toBe('2');
	expect(flagValue(argv, '--effort')).toBe('high');
	expect(flagValue(argv, '--add-dir')).toBe('/var');
	expect(flagValue(argv, '--model')).toBe('claude-fake');
	expect(String(cwd)).toMatch(/tmp$/);
	expect(flagValue(argv, '--tools')).toBe('Read,Bash');
	for (const flag of [
		'--add-dir',
		'--setting-sources=',
		'--strict-mcp-config',
		'--no-session-persistence',
		'--replay-user-messages',
		'--include-partial-messages',
	])
		expect(argv).toContain(flag);
});

it('gives the model no built-in tool when the policy names none, and sets the system prompt from the room', async () => {
	const { argv, initialize } = await argvOf();
	expect(flagValue(argv, '--tools')).toBe('');
	expect(argv).not.toContain('--allowedTools');
	expect(JSON.stringify(initialize.systemPrompt)).toContain('Answer once.');
});

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

it('answers for a room tool without an approval step, and denies a request when the application gave no canUseTool', async () => {
	const say = { tool: 'mcp__ambion__say', input: { text: 'hello' } };
	const run = open({ turns: [[{ permission: say }, { permission: bash }]] });
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
