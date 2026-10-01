/**
 * A seat on the real binary reads nothing from the host user. A Claude seat
 * has no built-in tool, so the model cannot show what the process holds. A
 * wrapper around the real binary (`support/wire.mjs`) records the names of
 * the variables of the process, its working directory, and its `HOME` and
 * `CLAUDE_CONFIG_DIR`.
 *
 * The host here is poisoned. Its home holds user settings with hooks, an
 * environment block, a `CLAUDE.md`, a skill, an MCP server, and a `.bashrc`.
 * The config directory of the seat holds the same user tier, because the
 * binary reads its user tier there when `CLAUDE_CONFIG_DIR` is set. The work
 * directory of the seat, which is its `cwd`, holds a poisoned project with an
 * `AGENTS.md` and a `.mcp.json`. The config directory also holds a planted
 * `MEMORY.md`.
 *
 * A person's message also names a file of the host with an `@` mention. The
 * binary reads such a file into the prompt unless the query is verbatim.
 *
 * Each assertion tests one leak. The marker `POISON-TEXT-` stands in file
 * contents only, so a transcript that holds it proves that a file reached the
 * model. The transcript holds the system prompt in a `prompt_snapshot`
 * attachment, so a memory file that reached the prompt shows there too.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { isSpoken } from '../../../ambion/src/index.ts';
import { enter, messagesOf } from '../../../ambion/test/support/room.ts';
import { segment } from '../../src/home.ts';
import { claudeExecution } from '../../src/index.ts';
import { live, open, person, seat, stepsOfType, untilQuiet, within } from './support.ts';

const ROOM_TOOLS = ['say', 'schedule', 'seat', 'unseat', 'dismiss', 'recall'];
const WIRE = fileURLToPath(new URL('./support/wire.mjs', import.meta.url));

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

/** The project tier that the binary reads from its working directory. */
async function poisonProject(work: string, markers: string): Promise<void> {
	await plant(work, {
		'.claude/settings.json': JSON.stringify(poisonedSettings('project', markers)),
		'CLAUDE.md': 'POISON-TEXT-project-claude-md',
		'AGENTS.md': 'POISON-TEXT-project-agents-md',
		'.mcp.json': JSON.stringify({
			mcpServers: { poison: { command: 'touch', args: [join(markers, 'project-mcp')] } },
		}),
	});
}

/** What the wrapper logged for each start of the binary. */
interface Start {
	names: string[];
	cwd: string;
	HOME: string;
	CLAUDE_CONFIG_DIR: string;
	CLAUDE_CODE_DISABLE_AUTO_MEMORY: string;
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: string;
}

async function startsIn(log: string): Promise<Start[]> {
	const text = await readFile(log, 'utf8');
	return text
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line) as Start);
}

/** The files under a directory that end with `suffix`. */
async function filesEnding(root: string, suffix: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
		.map((entry) => join(entry.parentPath, entry.name));
}

/** The attachment types that a transcript holds, one for each line that has one. */
async function attachmentTypes(path: string): Promise<string[]> {
	const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line !== '');
	return lines.flatMap((line) => {
		const type = (JSON.parse(line) as { attachment?: { type?: string } }).attachment?.type;
		return type === undefined ? [] : [type];
	});
}

const cleanup: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

live('hermetic seat', () => {
	it('reads no file of the host user, runs no hook or server of the host, and keeps no host variable', async () => {
		// A broken wrapper fails here in a second, and not after the retries of a room.
		expect(execFileSync(process.execPath, [WIRE, '--version'], { encoding: 'utf8' })).toMatch(
			/\d+\.\d+\.\d+/,
		);
		const markers = await mkdtemp(join(tmpdir(), 'ambion-poison-markers-'));
		const configRoot = await realpath(await mkdtemp(join(tmpdir(), 'ambion-poison-root-')));
		const home = await poisonedHome(markers);
		const wireLog = join(configRoot, 'wire.log');
		const hostDirectory = await realpath(await mkdtemp(join(tmpdir(), 'ambion-poison-host-')));
		const hostFile = join(hostDirectory, 'secret.txt');
		await writeFile(hostFile, 'POISON-TEXT-HOSTFILE');
		cleanup.push(markers, configRoot, home, hostDirectory);
		vi.stubEnv('HOME', home);
		vi.stubEnv('AMBION_SECRET', 'POISON-TEXT-host-secret');
		const definition = seat('hermetic', 'Says one word.', {
			instructions: 'Whatever you are asked, say only the word done, once.',
		});
		const execution = claudeExecution({
			configRoot,
			pathToClaudeCodeExecutable: WIRE,
			env: { AMBION_WIRE_LOG: wireLog },
		});
		const { session, name, steps: stepsOf } = await open('hermetic', [definition], execution);
		try {
			const seatDirectory = join(configRoot, segment(name), segment('hermetic'));
			const work = join(seatDirectory, 'work');
			const config = join(seatDirectory, 'config');
			// The planted memory sits where the binary looks for the memory of this working directory.
			const memory = join(config, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
			await plant(memory, { 'MEMORY.md': 'POISON-TEXT-memory' });
			await poisonConfig(config, markers);
			await poisonProject(work, markers);
			const visit = await enter(session, person);
			const started = new Promise<string>((resolve) => {
				session.subscribe((e) => {
					if (e.type === 'activation_start') resolve(e.activation);
				});
			});
			await visit.send({ text: `What does the file @${hostFile} say? Please tell me.` });
			const activation = await within(started, 60_000, 'the activation starting');
			await untilQuiet(session);
			const steps = stepsOf(activation);

			// The harness step shows what the seat ran with: the room tools, and the room server alone.
			const [harness] = stepsOfType(steps, 'harness');
			expect(new Set(harness?.tools)).toEqual(new Set(ROOM_TOOLS));
			expect(harness?.servers).toEqual([{ name: 'ambion', status: 'connected' }]);
			expect(harness?.cwd).toBe(work);

			// The process holds no host variable, and its directories are the directories of the seat.
			const starts = await startsIn(wireLog);
			expect(starts.length).toBeGreaterThan(0);
			for (const start of starts) {
				expect(start.names).not.toContain('AMBION_SECRET');
				expect(start.HOME).toBe(join(seatDirectory, 'home'));
				expect(start.CLAUDE_CONFIG_DIR).toBe(config);
				expect(start.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
				expect(start.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
				expect(await realpath(start.cwd)).toBe(work);
			}

			// No hook and no server of the host ran.
			expect(await readdir(markers)).toEqual([]);

			// No file of the host reached the model. Only a transcript holds what the model read.
			const transcripts = await filesEnding(configRoot, '.jsonl');
			expect(transcripts.length).toBeGreaterThan(0);
			for (const path of transcripts) {
				expect(await readFile(path, 'utf8')).not.toContain('POISON-TEXT-');
				// The `@` mention of the host file made no `file` attachment.
				expect(await attachmentTypes(path)).not.toContain('file');
			}
			const said = (await messagesOf(session)).filter(isSpoken).map((message) => message.text);
			expect(said.join('\n')).not.toContain('POISON-TEXT-HOSTFILE');
			// The transcript sits in the project key that the test computed, so the memory file was in reach.
			expect(transcripts.map((path) => dirname(path))).toContain(dirname(memory));
			expect(existsSync(join(memory, 'MEMORY.md'))).toBe(true);
		} finally {
			await session.stop();
		}
	});
});
