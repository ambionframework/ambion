/**
 * A seat on the real binary reads nothing from the host user. The host here
 * is poisoned: its home holds user settings with hooks, an environment
 * block, a `CLAUDE.md`, a skill, an MCP server, and a `.bashrc`. Its project
 * holds the same, with an `AGENTS.md` and a `.mcp.json`. The config home of
 * the seat holds a planted `MEMORY.md`. The seat runs one `Bash` command.
 *
 * With `CLAUDE_CONFIG_DIR` set, the binary reads its user tier from that
 * directory and not from `$HOME/.claude`. The test poisons both. The poison
 * in `$HOME` tests the `.bashrc`. The poison in the config directory tests
 * `settingSources`, `skills`, and `strictMcpConfig` at the user tier.
 *
 * Each assertion tests one leak. `POISON_RC` and `POISON_USER_ENV` are names
 * of variables, and the output of the command lists such names. The marker
 * `POISON-TEXT-` stands in file contents only, so a transcript that holds it
 * proves that a file reached the model.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { enter } from '../../../ambion/test/support/room.ts';
import { segment } from '../../src/home.ts';
import { claudeExecution } from '../../src/index.ts';
import { live, open, person, seat, stepsOfType, untilQuiet, within } from './support.ts';

const ROOM_TOOLS = ['say', 'schedule', 'seat', 'unseat', 'dismiss', 'recall'];

/** The settings that a poisoned user or project holds. `kind` and `markers` name the files that they touch. */
function poisonedSettings(kind: string, markers: string) {
	const touch = (name: string) => ({
		type: 'command',
		command: `touch ${join(markers, `${kind}-${name}`)}`,
	});
	return {
		env: { [`POISON_${kind.toUpperCase()}_ENV`]: '1' },
		hooks: {
			SessionStart: [{ hooks: [touch('session-start')] }],
			PreToolUse: [{ matcher: '*', hooks: [touch('pre-tool-use')] }],
		},
		permissions: { allow: ['Write'] },
	};
}

/** A directory that holds a file of each name. A name with a slash makes its folders. */
async function plant(root: string, files: Record<string, string>): Promise<void> {
	for (const [name, text] of Object.entries(files)) {
		const path = join(root, name);
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, text);
	}
}

/** The user tier that the binary reads from the config directory of the seat. */
async function poisonConfig(config: string, markers: string): Promise<void> {
	await plant(config, {
		'settings.json': JSON.stringify(poisonedSettings('config', markers)),
		'CLAUDE.md': 'POISON-TEXT-CONFIG-CLAUDE-MD',
		'skills/poison/SKILL.md':
			'---\nname: poison\ndescription: POISON-TEXT-CONFIG-SKILL\n---\nPOISON-TEXT-CONFIG-SKILL\n',
		'.claude.json': JSON.stringify({
			mcpServers: { poison: { command: 'touch', args: [join(markers, 'config-mcp')] } },
		}),
	});
}

/** The poisoned home of the host user. */
async function poisonedHome(markers: string): Promise<string> {
	const home = await realpath(await mkdtemp(join(tmpdir(), 'ambion-poison-home-')));
	await plant(home, {
		'.claude/settings.json': JSON.stringify(poisonedSettings('user', markers)),
		'.claude/CLAUDE.md': 'POISON-TEXT-user-claude-md',
		'.claude/skills/poison/SKILL.md':
			'---\nname: poison\ndescription: POISON-TEXT-user-skill\n---\nPOISON-TEXT-user-skill\n',
		'.claude.json': JSON.stringify({
			mcpServers: { poison: { command: 'touch', args: [join(markers, 'user-mcp')] } },
		}),
		'.bashrc': 'export POISON_RC=1\n',
	});
	return home;
}

/** The poisoned project directory that the seat names as its `cwd`. */
async function poisonedProject(markers: string): Promise<string> {
	const project = await realpath(await mkdtemp(join(tmpdir(), 'ambion-poison-project-')));
	await plant(project, {
		'.claude/settings.json': JSON.stringify(poisonedSettings('project', markers)),
		'CLAUDE.md': 'POISON-TEXT-project-claude-md',
		'AGENTS.md': 'POISON-TEXT-project-agents-md',
		'.mcp.json': JSON.stringify({
			mcpServers: { poison: { command: 'touch', args: [join(markers, 'project-mcp')] } },
		}),
	});
	return project;
}

/** The files under a directory that end with `suffix`. */
async function filesEnding(root: string, suffix: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
		.map((entry) => join(entry.parentPath, entry.name));
}

/** The text of a tool result output. */
function textOf(output: unknown): string {
	if (typeof output === 'string') return output;
	if (!Array.isArray(output)) return JSON.stringify(output);
	return output.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

const cleanup: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

live('hermetic seat', () => {
	it('reads no file of the host user, runs no hook or server of the host, and keeps no host variable', async () => {
		const markers = await mkdtemp(join(tmpdir(), 'ambion-poison-markers-'));
		const configRoot = await realpath(await mkdtemp(join(tmpdir(), 'ambion-poison-root-')));
		const home = await poisonedHome(markers);
		const project = await poisonedProject(markers);
		cleanup.push(markers, configRoot, home, project);
		vi.stubEnv('HOME', home);
		vi.stubEnv('AMBION_SECRET', 'POISON-TEXT-host-secret');
		const definition = seat('hermetic', 'Runs one command.', {
			instructions: `
				When asked, run this exact command once with the Bash tool, and no
				other command: env | cut -d= -f1 | sort; echo "HOME=$HOME"
				Then say the word done once.
			`,
			allowedTools: ['Bash'],
			cwd: project,
		});
		const {
			session,
			name,
			steps: stepsOf,
		} = await open('hermetic', [definition], claudeExecution({ configRoot }));
		try {
			// The planted memory sits where the CLI looks for the memory of this project.
			const seatDirectory = join(configRoot, segment(name), segment('hermetic'));
			const memory = join(
				seatDirectory,
				'config',
				'projects',
				project.replace(/[^a-zA-Z0-9]/g, '-'),
				'memory',
			);
			await plant(memory, { 'MEMORY.md': 'POISON-TEXT-memory' });
			await poisonConfig(join(seatDirectory, 'config'), markers);
			const visit = await enter(session, person);
			const started = new Promise<string>((resolve) => {
				session.subscribe((e) => {
					if (e.type === 'activation_start') resolve(e.activation);
				});
			});
			await visit.send({ text: 'Go.' });
			const activation = await within(started, 60_000, 'the activation starting');
			await untilQuiet(session);
			const steps = stepsOf(activation);

			// The harness step shows what the seat ran with.
			const [harness] = stepsOfType(steps, 'harness');
			expect(new Set(harness?.tools)).toEqual(new Set(['Bash', ...ROOM_TOOLS]));
			expect(harness?.servers).toEqual([{ name: 'ambion', status: 'connected' }]);
			expect(harness?.cwd).toBe(project);

			// The shell read no rc file, and the environment holds no host variable.
			const results = stepsOfType(steps, 'tool_result').map((step) => textOf(step.output));
			const output = results.find((text) => text.includes('HOME=')) ?? '';
			expect(output).not.toContain('POISON');
			expect(output).not.toContain('AMBION_SECRET');
			const seatHome = /^HOME=(.*)$/m.exec(output)?.[1] ?? '';
			expect(seatHome).toBe(join(seatDirectory, 'home'));

			// No hook and no server of the host ran.
			expect(await readdir(markers)).toEqual([]);

			// No file of the host reached the model. Only a transcript holds what the model read.
			const transcripts = await filesEnding(configRoot, '.jsonl');
			expect(transcripts.length).toBeGreaterThan(0);
			// The transcript sits in the project key that the test computed, so the memory file was in reach.
			expect(transcripts.map((path) => dirname(path))).toContain(dirname(memory));
			for (const path of transcripts)
				expect(await readFile(path, 'utf8')).not.toContain('POISON-TEXT-');
			expect(existsSync(join(memory, 'MEMORY.md'))).toBe(true);
		} finally {
			await session.stop();
		}
	});
});
