/**
 * The skills of a seat: the folders its bundle names, the list its reminder
 * gives each respond activation, and a `read` of one skill in a real room.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { callTool, contextText, quiet } from '../../ambion/test/support/scripted.ts';
import { memoryBackend } from '../../just-bash/src/index.ts';
import type { BashBackend } from '../src/backend.ts';
import { MAX_SKILLS } from '../src/skills.ts';
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

/** Write one `SKILL.md` as `agentName`, with the frontmatter lines given. */
async function writeSkill(
	workspace: Workspace,
	path: string,
	frontmatter: readonly string[],
	body = 'Follow these steps.',
	agentName = 'host',
): Promise<void> {
	const content = ['---', ...frontmatter, '---', body, ''].join('\n');
	await toolOf(workspace, 'write').invoke({ path, content }, callAs(agentName));
}

const seat = (activation: string) => ({ agent: 'alpha', room: 'lobby', activation });
const live = () => new AbortController().signal;

describe('the skills of a seat', () => {
	it('lists the skills of its folders to the seat that names them, and the seat reads one with read', async () => {
		const workspace = site();
		await writeSkill(workspace, '/skills/pour-plan/SKILL.md', [
			'name: pour-plan',
			'description: Check a concrete pour plan against the tonnage.',
		]);
		await writeSkill(workspace, '/skills/hidden/SKILL.md', [
			'name: hidden',
			'description: Only the application invokes this.',
			'disable-model-invocation: true',
		]);
		await writeSkill(workspace, '/skills/draft/SKILL.md', ['name: draft']);
		await writeSkill(
			workspace,
			'mine/sketch/SKILL.md',
			['name: sketch', 'description: Sketch a section.'],
			'Sketch it.',
			'surveyor',
		);
		const seen: Record<string, string> = {};
		const read: string[] = [];
		await run(
			[
				agent('surveyor', { bundles: [workspace.tools({ skills: ['/skills', 'mine'] })] }),
				agent('clerk', { bundles: [workspace.tools()] }),
			],
			{
				surveyor: (context, _who, call) => {
					if (call === 1) {
						seen.surveyor = contextText(context);
						return callTool('read', { path: '/skills/pour-plan/SKILL.md' });
					}
					read.push(...toolResults(context).map((result) => result.text));
					return quiet();
				},
				clerk: (context) => {
					seen.clerk = contextText(context);
					return quiet();
				},
			},
		);
		expect(seen.surveyor).toContain('<available_skills>');
		expect(seen.surveyor).toContain('<location>/skills/pour-plan/SKILL.md</location>');
		expect(seen.surveyor).toContain('<location>/home/surveyor/mine/sketch/SKILL.md</location>');
		expect(seen.surveyor).not.toContain('<name>hidden</name>');
		expect(seen.surveyor).not.toContain('<name>draft</name>');
		expect(read.join('\n')).toContain('Follow these steps.');
		expect(seen.clerk).toBeDefined();
		expect(seen.clerk).not.toContain('<available_skills>');
	});

	it(`names ${MAX_SKILLS} skills, counts the rest, and puts the list before the processes`, async () => {
		const workspace = site();
		for (let i = 0; i < MAX_SKILLS + 2; i++) {
			const name = `skill-${String(i).padStart(2, '0')}`;
			await writeSkill(workspace, `/many/${name}/SKILL.md`, [`name: ${name}`, 'description: A.']);
		}
		await toolOf(workspace, 'bash').invoke({ command: 'sleep 30', wait: 0 }, callAs('alpha'));
		const text = (await workspace.tools({ skills: '/many' }).remind?.(seat('a1'), live())) ?? '';
		expect(text.match(/<skill>/g)).toHaveLength(MAX_SKILLS);
		expect(text).toContain('<name>skill-49</name>');
		expect(text).not.toContain('<name>skill-50</name>');
		expect(text).toMatch(
			/<\/available_skills>\nand 2 more skills in \/many\n\nYour background processes in the workspace:\n/,
		);
	});

	it('gives no text for a missing folder, and the process reminder alone when the folder cannot be read', async () => {
		const workspace = site(
			wrapped((inner) => ({
				connect: async (who, signal, services) => {
					const env = await inner.connect(who, signal, services);
					const fileInfo = env.fileInfo.bind(env);
					env.fileInfo = (path, context) => {
						if (path.startsWith('/unreadable')) throw new Error('The disk is gone.');
						return fileInfo(path, context);
					};
					return env;
				},
			})),
		);
		expect(
			await workspace.tools({ skills: '/absent' }).remind?.(seat('a1'), live()),
		).toBeUndefined();
		await toolOf(workspace, 'bash').invoke({ command: 'sleep 30', wait: 0 }, callAs('alpha'));
		const text = await workspace.tools({ skills: '/unreadable' }).remind?.(seat('a2'), live());
		expect(text).toMatch(/^Your background processes in the workspace:\n/);
	});

	it.each([
		['an empty path', ''],
		['an empty list', []],
		['a list with a blank path', ['/skills', ' ']],
		['a number', 3],
	])('refuses %s, and keeps one bundle when no skills are named', (_case, skills) => {
		const workspace = site();
		expect(() => workspace.tools({ skills: skills as string })).toThrow(
			'Workspace skills must be a folder path or a nonempty list of folder paths.',
		);
		expect(workspace.tools({})).toBe(workspace.tools());
	});
});
