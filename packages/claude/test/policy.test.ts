/**
 * What a Claude seat gets from the executor. A seat has no built-in tool. The
 * fake executable logs the arguments the SDK gave it, the initialize request,
 * its working directory, and its environment. The tests read those logs and
 * the options that `queryOptions` builds.
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
	SEAT_SETTINGS,
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

it('gives the SDK a seat with no built-in tool, a list of its own tools, and no permission callback', async () => {
	const { argv, initialize, cwd } = await argvOf({ maxBudgetUsd: 2, effort: 'high' });
	expect(flagValue(argv, '--tools')).toBe('');
	expect(flagValue(argv, '--permission-mode')).toBe('dontAsk');
	// The list holds the room tools of the seat and no built-in name.
	expect(flagValue(argv, '--allowedTools')?.split(',')).toEqual(
		expect.arrayContaining(['mcp__ambion__say', 'mcp__ambion__schedule']),
	);
	expect(
		flagValue(argv, '--allowedTools')
			?.split(',')
			.every((name) => name.startsWith('mcp__ambion__')),
	).toBe(true);
	expect(argv).not.toContain('--permission-prompt-tool');
	expect(argv).not.toContain('--disallowedTools');
	expect(argv).not.toContain('--add-dir');
	expect(flagValue(argv, '--max-budget-usd')).toBe('2');
	expect(flagValue(argv, '--effort')).toBe('high');
	expect(flagValue(argv, '--model')).toBe('claude-fake');
	// The SDK asks the executable to raise no permission request when it has no callback.
	expect(JSON.stringify(initialize)).not.toContain('canUseTool');
	expect(cwd).toBeDefined();
	// The settings overlay holds at the flag tier, with every setting source off.
	expect(JSON.parse(String(flagValue(argv, '--settings')))).toEqual(SEAT_SETTINGS);
	expect(SEAT_SETTINGS.autoMemoryEnabled).toBe(false);
	for (const flag of [
		'--setting-sources=',
		'--strict-mcp-config',
		'--replay-user-messages',
		'--include-partial-messages',
	])
		expect(argv).toContain(flag);
	expect(JSON.stringify(initialize.systemPrompt)).toContain('Answer once.');
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

/** The options of a seat that runs with `runtime`, over a fixed home. */
function optionsOf(
	runtime: QueryInput['runtime'] = {},
	options: Parameters<typeof seat>[0] = {},
	names: string[] = [],
) {
	return queryOptions({
		executor: claudeOf(seat(options).executor),
		systemPrompt: '',
		server: {} as QueryInput['server'],
		names,
		runtime,
		home: () => ({ config: '/seat/config', work: '/seat/work', home: '/seat/home' }),
		stderr: () => {},
	});
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
		// The seat gets a home of its own, so its shell reads no rc file of the host user.
		for (const name of [...ENV_ALLOWLIST, ...prefixed].filter(
			(name) => name !== 'HOME' && name !== 'USERPROFILE',
		))
			expect(env?.[name]).toBe(`host-${name}`);
		expect(env?.HOME).toBe('/seat/home');
		expect(env?.USERPROFILE).toBe('/seat/home');
		expect(env).not.toHaveProperty('AMBION_SECRET');
		expect(env).not.toHaveProperty('GITHUB_TOKEN');
	} finally {
		vi.unstubAllEnvs();
	}
});

it('lays the env of the host over the allowlisted variables, and removes a variable that it sets to undefined', () => {
	vi.stubEnv('PATH', '/host/bin');
	vi.stubEnv('AMBION_SECRET', 'hidden');
	vi.stubEnv('ANTHROPIC_API_KEY', 'host-key');
	try {
		const { env } = optionsOf({
			env: { AWS_REGION: 'eu-west-1', PATH: '/seat/bin', ANTHROPIC_API_KEY: undefined },
		});
		// An added variable stays, a replaced one changes, and an undefined one goes.
		expect(env?.AWS_REGION).toBe('eu-west-1');
		expect(env?.PATH).toBe('/seat/bin');
		expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
		// The overlay adds to the allowlist, and does not replace it.
		expect(env).not.toHaveProperty('AMBION_SECRET');
		expect(env?.HOME).toBe('/seat/home');
	} finally {
		vi.unstubAllEnvs();
	}
});

it('sets the variables of the seat last, so the env of the host cannot change them', () => {
	const { env } = optionsOf({
		env: {
			HOME: '/srv/user',
			USERPROFILE: '/srv/user',
			CLAUDE_CONFIG_DIR: '/shared',
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0',
			CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
			CLAUDE_CODE_SESSION_ID: 'host-session',
		},
	});
	expect(env).toMatchObject({
		HOME: '/seat/home',
		USERPROFILE: '/seat/home',
		CLAUDE_CONFIG_DIR: '/seat/config',
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
	});
	expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID');
});

it('sets the working directory to the scratch directory of the seat', () => {
	expect(optionsOf().cwd).toBe('/seat/work');
});

it.each([
	{ what: 'no tool of the seat', names: [], aliases: {} },
	{
		what: 'a tool with no built-in name',
		names: ['mcp__ambion__say', 'mcp__ambion__lookup'],
		aliases: {},
	},
	{
		what: 'one matching tool',
		names: ['mcp__ambion__say', 'mcp__ambion__bash'],
		aliases: { Bash: 'mcp__ambion__bash' },
	},
	{
		what: 'every pair of the table',
		names: Object.values(TOOL_ALIASES).map((name) => `mcp__ambion__${name}`),
		aliases: Object.fromEntries(
			Object.entries(TOOL_ALIASES).map(([builtin, name]) => [builtin, `mcp__ambion__${name}`]),
		),
	},
	{ what: 'a tool of another server', names: ['mcp__other__bash'], aliases: {} },
])('maps the built-in names for $what', ({ names, aliases }) => {
	expect(toolAliases(names)).toEqual(aliases);
});

it('gives the options no alias map when no alias applies, and skills off always', () => {
	expect(optionsOf().toolAliases).toBeUndefined();
	expect(optionsOf().skills).toEqual([]);
	expect(optionsOf({}, {}, ['mcp__ambion__edit']).toolAliases).toEqual({
		Edit: 'mcp__ambion__edit',
	});
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
		{ configRoot: root, room: 'lab', seat: 'sonnet' },
	);
	const home = join(root, segment('lab'), segment('sonnet'));
	expect(env.values.CLAUDE_CONFIG_DIR).toBe(join(home, 'config'));
	expect(env.values.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
	expect(env.values.HOME).toBe(join(home, 'home'));
	for (const directory of ['config', 'work', 'home']) {
		expect(statSync(join(home, directory)).mode & 0o077).toBe(0);
	}
	expect(realpathSync(String(cwd))).toBe(realpathSync(join(home, 'work')));
	expect(initialize.skills).toEqual([]);
	expect(initialize.toolAliases).toEqual({ Bash: 'mcp__ambion__bash' });
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

it('keeps the config home of the seat when the env of the host names another', async () => {
	const { env } = await argvOf({}, { CLAUDE_CONFIG_DIR: '/shared/claude' });
	expect(env.values.CLAUDE_CONFIG_DIR).not.toBe('/shared/claude');
	expect(basename(String(env.values.CLAUDE_CONFIG_DIR))).toBe('config');
});

it('records one harness step from the init message, with the room tools by their plain names', async () => {
	const run = open({ turns: [[]], initTools: ['mcp__ambion__say'], apiKeySource: 'none' });
	await run.session.pass({ kind: 'view', view: viewOf() });
	run.session.close?.();
	const steps = run.steps.filter((step) => step.type === 'harness');
	expect(steps).toEqual([
		{
			type: 'harness',
			name: 'claude',
			version: '0.0.0-fake',
			model: 'claude-fake',
			cwd: expect.stringContaining('work'),
			session: expect.any(String),
			auth: 'none',
			permissionMode: 'dontAsk',
			tools: ['say'],
			servers: [{ name: 'ambion', status: 'connected' }],
		},
	]);
	// The step holds no list of skills, agents, plugins, or slash commands.
	expect(Object.keys(steps[0] ?? {})).not.toEqual(expect.arrayContaining(['skills', 'plugins']));
});
