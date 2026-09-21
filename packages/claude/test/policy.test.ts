/**
 * The policy options of `claude()` reach the SDK. The fake executable logs
 * the arguments the SDK gave it and the initialize request.
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

it('passes the policy options to the SDK', async () => {
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
	expect(argv).toContain('--add-dir');
	expect(flagValue(argv, '--add-dir')).toBe('/var');
	expect(flagValue(argv, '--model')).toBe('claude-fake');
	expect(String(cwd)).toMatch(/tmp$/);
});

it('reads no settings source, and names the built-in tools of the policy only', async () => {
	const { argv } = await argvOf({ allowedTools: ['Read', 'Bash(git status:*)'] });
	expect(argv).toContain('--setting-sources=');
	expect(argv).toContain('--strict-mcp-config');
	expect(argv).toContain('--no-session-persistence');
	expect(flagValue(argv, '--tools')).toBe('Read,Bash');
	expect(argv).toContain('--replay-user-messages');
	expect(argv).toContain('--include-partial-messages');
});

it('gives the model no built-in tool when the policy names none', async () => {
	const { argv } = await argvOf();
	expect(flagValue(argv, '--tools')).toBe('');
	expect(argv).not.toContain('--allowedTools');
});

it('sets the system prompt from the room: the mechanism, then the seat', async () => {
	const { initialize } = await argvOf();
	const prompt = JSON.stringify(initialize.systemPrompt);
	expect(prompt).toContain('Answer once.');
});
