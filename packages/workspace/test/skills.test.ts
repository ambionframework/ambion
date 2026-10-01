/**
 * The skills of an agent: `loadSkills` and its checks, the guidance that
 * lists a set, the copy in each agent's home, a seat in a real room that
 * reads a skill, a reference, and runs a script of it, and a run outside a
 * room.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@ambionframework/ambion';
import { createExecutionServices, runAgent } from '@ambionframework/pi';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { describe, expect, it, onTestFinished } from 'vitest';
import { callTool, quiet, scriptedStream } from '../../ambion/test/support/scripted.ts';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { tempDir } from '../../just-bash/test/support/backends.ts';
import type { BashBackend } from '../src/backend.ts';
import { fromDirectory, loadSkills, type SkillSet } from '../src/index.ts';
import { MANIFEST } from '../src/skills.ts';
import { openWorkspace, type Workspace } from '../src/workspace.ts';
import { callAs, toolOf, wrapped } from './support/backends.ts';
import { agent, run, toolResults } from './support/room.ts';

let serial = 0;

function site(bash: BashBackend = memoryBackend()): Workspace {
	serial += 1;
	const workspace = openWorkspace({ name: `skills-${serial}`, backend: { bash } });
	onTestFinished(() => workspace.dispose());
	return workspace;
}

/** The text of a `SKILL.md` with the frontmatter lines given. */
const skillMd = (frontmatter: readonly string[], body = 'Follow these steps.') =>
	['---', ...frontmatter, '---', body, ''].join('\n');

/** The frontmatter of a valid skill named `name`. */
const valid = (name: string, description = `Use ${name}.`) => [
	`name: ${name}`,
	`description: ${description}`,
];

const POUR_PLAN = {
	'pour-plan/SKILL.md': skillMd(
		valid('pour-plan', 'Check a concrete pour plan against the tonnage.'),
		'Run scripts/tonnage.sh with the volume. Read references/limits.md for the limits.',
	),
	'pour-plan/scripts/tonnage.sh': '#!/bin/bash\necho "tonnage for $1 m3: $(( $1 * 24 / 10 )) t"\n',
	'pour-plan/references/limits.md': 'A single pour holds at most 60 t.\n',
};

/** Wait until the bash owner has run every operation queued before this one. */
const drained = (workspace: Workspace, name = 'alpha') => workspace.use({ name }, () => undefined);

const seat = (activation: string) => ({ agent: 'alpha', room: 'lobby', activation });
const live = () => new AbortController().signal;

/** Run a command as `name`, and give its exit code. */
const exitOf = (workspace: Workspace, name: string, command: string) =>
	workspace.use({ name }, async (env) => {
		const ran = await env.exec(command, undefined, BACKGROUND_CONTEXT);
		if (!ran.ok) throw ran.error;
		return ran.value.exitCode;
	});

describe('loadSkills', () => {
	it('reads a folder of skills with scripts, references, and binary assets, and freezes the set', async () => {
		const { dir, dispose } = await tempDir('ambion-skills-');
		onTestFinished(dispose);
		for (const [path, text] of Object.entries(POUR_PLAN)) {
			await mkdir(join(dir, path, '..'), { recursive: true });
			await writeFile(join(dir, path), text);
		}
		await mkdir(join(dir, 'pour-plan', 'assets'));
		await writeFile(
			join(dir, 'pour-plan', 'assets', 'slab.png'),
			new Uint8Array([0x89, 0x50, 0xff]),
		);
		const set = await loadSkills(fromDirectory(dir));
		expect(set.skills).toEqual([
			{
				name: 'pour-plan',
				description: 'Check a concrete pour plan against the tonnage.',
				files: ['SKILL.md', 'assets/slab.png', 'references/limits.md', 'scripts/tonnage.sh'],
			},
		]);
		expect(set.scripts).toEqual(['pour-plan/scripts/tonnage.sh']);
		expect([...(set.files['pour-plan/assets/slab.png'] ?? [])]).toEqual([0x89, 0x50, 0xff]);
		expect(
			Object.isFrozen(set) && Object.isFrozen(set.files) && Object.isFrozen(set.skills[0]),
		).toBe(true);
	});

	it.each<[string, Record<string, string>, string]>([
		[
			'a file outside a skill folder',
			{ 'README.md': 'x', ...POUR_PLAN },
			"the file 'README.md' is outside a skill folder",
		],
		[
			'a path with ..',
			{ 'a/../a/SKILL.md': skillMd(valid('a')) },
			"the file path 'a/../a/SKILL.md' is not a plain relative path",
		],
		['a folder with no SKILL.md', { 'a/notes.md': 'x' }, "the skill folder 'a' has no SKILL.md"],
		[
			'no frontmatter',
			{ 'a/SKILL.md': 'Just steps.' },
			"the SKILL.md of 'a' starts with no frontmatter",
		],
		[
			'frontmatter that is not YAML',
			{ 'a/SKILL.md': skillMd(['name: [a']) },
			"the frontmatter of 'a' is not YAML",
		],
		[
			'frontmatter that is a list',
			{ 'a/SKILL.md': skillMd(['- a']) },
			"the frontmatter of 'a' is not a YAML mapping",
		],
		[
			'a name that differs from the folder',
			{ 'a/SKILL.md': skillMd(valid('b')) },
			"the name of 'a' must equal its folder name",
		],
		[
			'a name with capitals',
			{ 'Pour/SKILL.md': skillMd(valid('Pour')) },
			"the name 'Pour' must be 1 to 64 characters",
		],
		[
			'a name with two hyphens together',
			{ 'a--b/SKILL.md': skillMd(valid('a--b')) },
			"the name 'a--b' must be",
		],
		[
			'a name of 65 characters',
			{ [`${'a'.repeat(65)}/SKILL.md`]: skillMd(valid('a'.repeat(65))) },
			`the name '${'a'.repeat(65)}' must be 1 to 64 characters`,
		],
		['no description', { 'a/SKILL.md': skillMd(['name: a']) }, "the skill 'a' has no description"],
		[
			'a description of 1025 characters',
			{ 'a/SKILL.md': skillMd(valid('a', 'd'.repeat(1025))) },
			"the description of 'a' is longer than 1024 characters",
		],
		[
			'a compatibility of 501 characters',
			{ 'a/SKILL.md': skillMd([...valid('a'), `compatibility: ${'c'.repeat(501)}`]) },
			"the compatibility of 'a' must be text",
		],
		['no skill', {}, 'the source holds no skill'],
	])('refuses %s', async (_case, source, message) => {
		await expect(loadSkills(source)).rejects.toThrow(`Skill set: ${message}`);
	});

	it('ends the frontmatter at a line that is --- alone, and refuses a SKILL.md that is not UTF-8 and a set that loadSkills did not make', async () => {
		const early = await loadSkills({
			'a/SKILL.md': [
				'---',
				'name: a',
				'---notes: kept',
				'description: Use a.',
				'---  ',
				'Steps.',
			].join('\n'),
		});
		expect(early.skills[0]?.description).toBe('Use a.');
		const bytes = { read: async () => ({ 'a/SKILL.md': new Uint8Array([0xff, 0xfe]) }) };
		await expect(loadSkills(bytes)).rejects.toThrow(
			"Skill set: the SKILL.md of 'a' is not UTF-8 text.",
		);
		const made = await loadSkills(POUR_PLAN);
		expect(() => site().tools({ skills: { ...made } as SkillSet })).toThrow(
			'Workspace skills must be a skill set that loadSkills made.',
		);
	});
});

describe('the skills of a seat', () => {
	it('lists each agent its own skills, and the seat reads a skill and a reference and runs a script', async () => {
		const workspace = site();
		const surveyorSkills = await loadSkills(POUR_PLAN);
		const clerkSkills = await loadSkills({ 'filing/SKILL.md': skillMd(valid('filing')) });
		const prompts: Record<string, string> = {};
		const results: string[] = [];
		await run(
			[
				agent('surveyor', { bundles: [workspace.tools({ skills: surveyorSkills })] }),
				agent('clerk', { bundles: [workspace.tools({ skills: clerkSkills })] }),
			],
			{
				surveyor: (context, _who, request) => {
					prompts.surveyor = context.systemPrompt ?? '';
					if (request === 1) return callTool('read', { path: '~/.skills/pour-plan/SKILL.md' });
					if (request === 2)
						return callTool('read', { path: '~/.skills/pour-plan/references/limits.md' });
					if (request === 3)
						return callTool('bash', { command: '~/.skills/pour-plan/scripts/tonnage.sh 20' });
					results.push(...toolResults(context).map((result) => result.text));
					return quiet();
				},
				clerk: (context) => {
					prompts.clerk = context.systemPrompt ?? '';
					return quiet();
				},
			},
		);
		expect(prompts.surveyor).toContain('<location>~/.skills/pour-plan/SKILL.md</location>');
		expect(prompts.surveyor).not.toContain('<name>filing</name>');
		expect(prompts.clerk).toContain('<location>~/.skills/filing/SKILL.md</location>');
		expect(prompts.clerk).not.toContain('<name>pour-plan</name>');
		expect(results[0]).toContain('Run scripts/tonnage.sh with the volume.');
		expect(results[1]).toContain('A single pour holds at most 60 t.');
		expect(results[2]).toContain('tonnage for 20 m3: 48 t');
		expect(await exitOf(workspace, 'clerk', 'test -e ~/.skills/pour-plan')).not.toBe(0);
	});

	it('copies the set once, writes it again when the manifest goes or the set changes, and marks each script executable', async () => {
		let writes = 0;
		const workspace = site(
			wrapped((inner) => ({
				connect: async (who, signal) => {
					const env = await inner.connect(who, signal);
					const writeFile = env.writeFile.bind(env);
					env.writeFile = (path, content, context) => {
						writes += 1;
						return writeFile(path, content, context);
					};
					return env;
				},
			})),
		);
		const first = workspace.tools({ skills: await loadSkills(POUR_PLAN) });
		const copy = async (bundle = first, activation = 'a') => {
			writes = 0;
			await bundle.remind?.(seat(activation), live());
			await drained(workspace);
			return writes;
		};
		expect(await copy()).toBe(4);
		expect(await exitOf(workspace, 'alpha', 'test -x ~/.skills/pour-plan/scripts/tonnage.sh')).toBe(
			0,
		);
		expect(await exitOf(workspace, 'alpha', 'test -x ~/.skills/pour-plan/SKILL.md')).not.toBe(0);
		expect(await copy()).toBe(0);
		await exitOf(workspace, 'alpha', `rm ~/.skills/${MANIFEST}`);
		expect(await copy()).toBe(4);
		const other = workspace.tools({
			skills: await loadSkills({ 'filing/SKILL.md': skillMd(valid('filing')) }),
		});
		expect(await copy(other)).toBe(2);
		expect(await exitOf(workspace, 'alpha', 'test -e ~/.skills/pour-plan')).not.toBe(0);
		expect(await exitOf(workspace, 'alpha', 'test -f ~/.skills/filing/SKILL.md')).toBe(0);
	});

	it('finishes the copy after the reminder bound, keeps the process reminder, and copies again after a failed copy', async () => {
		let failChmod = true;
		const gate = Promise.withResolvers<void>();
		const workspace = site(
			wrapped((inner) => ({
				connect: async (who, signal) => {
					const env = await inner.connect(who, signal);
					const writeFile = env.writeFile.bind(env);
					const exec = env.exec.bind(env);
					env.writeFile = async (path, content, context) => {
						await gate.promise;
						return writeFile(path, content, context);
					};
					env.exec = (command, options, context) =>
						exec(failChmod && command.startsWith('chmod') ? 'exit 1' : command, options, context);
					return env;
				},
			})),
		);
		const bundle = workspace.tools({ skills: await loadSkills(POUR_PLAN) });
		const bound = new AbortController();
		const reminded = Promise.resolve(bundle.remind?.(seat('a1'), bound.signal)).catch(
			() => undefined,
		);
		bound.abort();
		gate.resolve();
		await Promise.all([reminded, drained(workspace)]);
		expect(await exitOf(workspace, 'alpha', 'test -f ~/.skills/pour-plan/scripts/tonnage.sh')).toBe(
			0,
		);
		expect(await exitOf(workspace, 'alpha', `test -e ~/.skills/${MANIFEST}`)).not.toBe(0);
		failChmod = false;
		await toolOf(workspace, 'bash').invoke({ command: 'sleep 30', wait: 0 }, callAs('alpha'));
		const text = await bundle.remind?.(seat('a2'), live());
		await drained(workspace);
		expect(text).toMatch(/^Your background processes in the workspace:\n/);
		expect(await exitOf(workspace, 'alpha', `test -f ~/.skills/${MANIFEST}`)).toBe(0);
	});

	it('copies the set at the first tool call of a run outside a room, which resolves no reminder', async () => {
		const workspace = site();
		const finish = defineTool({
			name: 'finish',
			description: 'End the run.',
			parameters: Type.Object({}),
			execute: () => 'finished',
		});
		const read: string[] = [];
		await runAgent(
			createExecutionServices({
				sessions: 'memory',
				stream: scriptedStream((context, _who, request) => {
					if (request === 1) return callTool('read', { path: '~/.skills/pour-plan/SKILL.md' });
					read.push(...toolResults(context).map((result) => result.text));
					return callTool('finish', {});
				}),
			}),
			{
				model: 'scripted/surveyor',
				name: 'surveyor',
				agent: { name: 'surveyor', identity: 'Quantity surveyor.' },
				system: 'Use your skills.',
				prompt: 'Check the pour.',
				tools: [finish],
				bundles: [workspace.tools({ skills: await loadSkills(POUR_PLAN) })],
				ends: ['finish'],
			},
		);
		expect(read.join('\n')).toContain('Run scripts/tonnage.sh with the volume.');
	});

	it('adds the list to the guidance of the bundle, and keeps one bundle when no skills are named', async () => {
		const workspace = site();
		const bundle = workspace.tools({ skills: await loadSkills(POUR_PLAN) });
		expect(bundle.tools.map((tool) => tool.name)).toEqual(
			workspace.tools().tools.map((tool) => tool.name),
		);
		expect(bundle.guidance?.startsWith(workspace.tools().guidance ?? '')).toBe(true);
		expect(bundle.guidance).toMatch(
			/<\/available_skills>\nYour skills are in ~\/\.skills\. The folder of a skill also holds its scripts and\nresources\. Read a file with read, and run a script with bash\.$/,
		);
		expect(workspace.tools({})).toBe(workspace.tools());
	});
});
