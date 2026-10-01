/**
 * The policy options of `claude()` reach the SDK. The fake executable logs
 * the arguments the SDK gave it, the initialize request, and each permission
 * answer. A permission request becomes an `approval` step: the application
 * answers it, and the step carries the answer.
 */
import { mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { defineTool } from '@ambionframework/ambion';
import { Type } from 'typebox';
import { expect, it, vi } from 'vitest';
import { segment } from '../src/home.ts';
import {
	claudeOf,
	ENV_ALLOWLIST,
	ENV_PREFIXES,
	PARENT_SESSION,
	type QueryInput,
	queryOptions,
	TOOL_ALIASES,
	toolAliases,
} from '../src/options.ts';
import { open, seat, viewOf } from './support.ts';

async function argvOf(
	options: Parameters<typeof seat>[0] = {},
	host: Readonly<Record<string, string>> = {},
	extra: Parameters<typeof open>[3] = {},
) {
	const run = open({ turns: [[]] }, seat(options), host, extra);
	await run.session.pass({ kind: 'view', view: viewOf() });
	run.session.close?.();
	const lines = run.log();
	const argv = lines.find((line) => 'argv' in line)?.argv as string[];
	const initialize = lines.find((line) => 'initialize' in line)?.initialize as Record<
		string,
		unknown
	>;
	const env = lines.find((line) => 'env' in line)?.env as {
		names: string[];
		entrypoint?: string;
		values: Record<string, string | undefined>;
	};
	return { argv, initialize, env, cwd: lines.find((line) => 'cwd' in line)?.cwd };
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

it('starts the executable outside the Claude Code session of its host', async () => {
	// A host that runs inside Claude Code holds the variables of that session.
	const host = Object.fromEntries(PARENT_SESSION.map((name) => [name, `host-${name}`]));
	const { env } = await argvOf({}, { ...host, AMBION_KEPT: 'yes' });
	// The SDK sets its own entrypoint in place of the host's.
	expect(env.entrypoint).toBe('sdk-ts');
	for (const name of PARENT_SESSION.filter((name) => name !== 'CLAUDE_CODE_ENTRYPOINT'))
		expect(env.names).not.toContain(name);
	expect(env.names).toContain('AMBION_KEPT');
});

/** The options of a seat that runs with `runtime`, over a home that records its use. */
function optionsOf(
	runtime: QueryInput['runtime'] = {},
	options: Parameters<typeof seat>[0] = {},
	names: string[] = [],
) {
	const made: string[] = [];
	const home: QueryInput['home'] = () => {
		made.push('home');
		return { config: '/home/config', work: '/home/work' };
	};
	const result = queryOptions({
		executor: claudeOf(seat(options).executor),
		systemPrompt: '',
		server: {} as QueryInput['server'],
		names,
		canUseTool: async () => ({ behavior: 'deny', message: '' }),
		runtime,
		home,
		stderr: () => {},
	});
	return { ...result, made };
}

it('removes the same variables from the environment of this process when the host passes no env', () => {
	for (const name of PARENT_SESSION) vi.stubEnv(name, `host-${name}`);
	try {
		const options = optionsOf();
		for (const name of PARENT_SESSION) expect(options.env).not.toHaveProperty(name);
		expect(options.env?.PATH).toBe(process.env.PATH);
	} finally {
		vi.unstubAllEnvs();
	}
});

it('gives a seat the allowlisted variables of this process and no other when the host passes no env', () => {
	const prefixed = ENV_PREFIXES.map((prefix) => `${prefix}AMBION_TEST`);
	for (const name of [...ENV_ALLOWLIST, ...prefixed]) vi.stubEnv(name, `host-${name}`);
	vi.stubEnv('AMBION_SECRET', 'hidden');
	vi.stubEnv('GITHUB_TOKEN', 'hidden');
	try {
		const { env } = optionsOf();
		for (const name of [...ENV_ALLOWLIST, ...prefixed]) expect(env?.[name]).toBe(`host-${name}`);
		expect(env).not.toHaveProperty('AMBION_SECRET');
		expect(env).not.toHaveProperty('GITHUB_TOKEN');
	} finally {
		vi.unstubAllEnvs();
	}
});

it('lets an explicit env replace the environment, and sets the two variables of the seat', () => {
	vi.stubEnv('AMBION_SECRET', 'hidden');
	try {
		const { env } = optionsOf({ env: { ONLY: 'this' } });
		expect(env).toEqual({
			ONLY: 'this',
			CLAUDE_CONFIG_DIR: '/home/config',
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		});
	} finally {
		vi.unstubAllEnvs();
	}
});

it('keeps the config home and the traffic setting that an explicit env names, and makes no home for the config', () => {
	const { env, cwd, made } = optionsOf(
		{ env: { CLAUDE_CONFIG_DIR: '/shared', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' } },
		{ allowedTools: ['Read'] },
	);
	expect(env).toEqual({
		CLAUDE_CONFIG_DIR: '/shared',
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0',
	});
	expect(cwd).toBeUndefined();
	expect(made).toEqual([]);
});

it.each([
	{ what: 'a seat with no built-in tool', options: {}, cwd: '/home/work' },
	{ what: 'a seat with no built-in tool that sets a cwd', options: { cwd: '/srv' }, cwd: '/srv' },
	{
		what: 'a seat that only names a room tool',
		options: { allowedTools: ['mcp__x__y'] },
		cwd: '/home/work',
	},
	{ what: 'a seat with a built-in tool', options: { allowedTools: ['Read'] }, cwd: undefined },
	{
		what: 'a seat with a built-in tool and a cwd',
		options: { allowedTools: ['Read'], cwd: '/srv' },
		cwd: '/srv',
	},
])('sets the working directory of $what', ({ options, cwd }) => {
	expect(optionsOf({ env: {} }, options).cwd).toBe(cwd);
});

it.each([
	{ what: 'no tool of the seat', names: [], builtins: [], aliases: {} },
	{
		what: 'a tool with no built-in name',
		names: ['mcp__ambion__say', 'mcp__ambion__lookup'],
		builtins: [],
		aliases: {},
	},
	{
		what: 'one matching tool',
		names: ['mcp__ambion__say', 'mcp__ambion__bash'],
		builtins: [],
		aliases: { Bash: 'mcp__ambion__bash' },
	},
	{
		what: 'every pair of the table',
		names: Object.values(TOOL_ALIASES).map((name) => `mcp__ambion__${name}`),
		builtins: [],
		aliases: Object.fromEntries(
			Object.entries(TOOL_ALIASES).map(([builtin, name]) => [builtin, `mcp__ambion__${name}`]),
		),
	},
	{
		what: 'a built-in tool that the seat holds',
		names: ['mcp__ambion__bash', 'mcp__ambion__read'],
		builtins: ['Bash'],
		aliases: { Read: 'mcp__ambion__read' },
	},
	{
		what: 'a tool of another server',
		names: ['mcp__other__bash'],
		builtins: [],
		aliases: {},
	},
])('maps the built-in names for $what', ({ names, builtins, aliases }) => {
	expect(toolAliases(names, builtins)).toEqual(aliases);
});

it('gives the options no alias map when no alias applies, and skills off always', () => {
	expect(optionsOf({ env: {} }).toolAliases).toBeUndefined();
	expect(optionsOf({ env: {} }).skills).toEqual([]);
	const { toolAliases: aliases } = optionsOf({ env: {} }, {}, ['mcp__ambion__edit']);
	expect(aliases).toEqual({ Edit: 'mcp__ambion__edit' });
});

const bashTool = defineTool({
	name: 'bash',
	description: 'Run a command in the workspace.',
	parameters: Type.Object({ command: Type.String() }),
	execute: () => 'ran',
});

it('starts a seat in its own config home and scratch directory, with skills off and an alias for its tool', async () => {
	const root = mkdtempSync(join(tmpdir(), 'ambion-root-'));
	const { initialize, env, cwd } = await argvOf(
		{ tools: [bashTool] },
		{},
		{
			configRoot: root,
			room: 'lab',
			seat: 'sonnet',
		},
	);
	const home = join(root, segment('lab'), segment('sonnet'));
	expect(env.values.CLAUDE_CONFIG_DIR).toBe(join(home, 'config'));
	expect(env.values.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
	for (const directory of ['config', 'work']) {
		expect(statSync(join(home, directory)).mode & 0o077).toBe(0);
	}
	expect(realpathSync(String(cwd))).toBe(realpathSync(join(home, 'work')));
	expect(initialize.skills).toEqual([]);
	expect(initialize.toolAliases).toEqual({ Bash: 'mcp__ambion__bash' });
});

it('sends no alias and keeps the host cwd for a seat with a built-in tool, and keeps a cwd that the seat sets', async () => {
	const plain = await argvOf({ allowedTools: ['Read'] });
	expect(plain.initialize.toolAliases).toBeUndefined();
	expect(realpathSync(String(plain.cwd))).toBe(realpathSync(process.cwd()));
	const set = await argvOf({ cwd: tmpdir() });
	expect(realpathSync(String(set.cwd))).toBe(realpathSync(tmpdir()));
});

it('gives each seat a config home that it keeps across activations, and gives two seats two homes', async () => {
	const root = mkdtempSync(join(tmpdir(), 'ambion-root-'));
	const homes = async (name: string) => {
		const run = open(
			{ turns: [[], []] },
			seat(),
			{},
			{ configRoot: root, room: 'lab', seat: name },
		);
		await run.session.pass({ kind: 'view', view: viewOf() });
		run.session.close?.();
		const next = run.activate('message:2:sonnet:1');
		await next.pass({ kind: 'view', view: viewOf() });
		next.close?.();
		return run.envs().map((one) => one.values.CLAUDE_CONFIG_DIR);
	};
	const [one, again, other] = [...(await homes('sonnet')), ...(await homes('haiku'))];
	expect(one).toBe(join(root, segment('lab'), segment('sonnet'), 'config'));
	expect(again).toBe(one);
	expect(other).toBe(join(root, segment('lab'), segment('haiku'), 'config'));
});

it('makes a private config home under the temporary directory when the host names no root', async () => {
	const { env } = await argvOf();
	const config = String(env.values.CLAUDE_CONFIG_DIR);
	expect(basename(config)).toBe('config');
	expect(realpathSync(dirname(dirname(config))).startsWith(realpathSync(tmpdir()))).toBe(true);
	expect(basename(dirname(config)).startsWith('ambion-claude-')).toBe(true);
});

it('keeps the config home that an explicit env names', async () => {
	const { env } = await argvOf({}, { CLAUDE_CONFIG_DIR: '/shared/claude' });
	expect(env.values.CLAUDE_CONFIG_DIR).toBe('/shared/claude');
});
