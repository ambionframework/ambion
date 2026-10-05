/**
 * A workspace in use: the built-in tools in a running room, on disk and in
 * memory; the bundle a backend extends; a room that the workspace audits and
 * mirrors at the paths its backend names; and two agents whose operations
 * the workspace serializes. The just-bash adapter has its own tests in
 * `@ambionframework/just-bash`.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createRuntime,
	definePerson,
	defineTool,
	isSaid,
	snapshotUri,
	startRoom,
	type ToolContext,
} from '@ambionframework/ambion';
import { memoryJournals } from '@ambionframework/journal';
import { piExecution } from '@ambionframework/pi';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { describe, expect, it, onTestFinished } from 'vitest';
import { enter, roomName as name } from '../../ambion/test/support/room.ts';
import {
	byAgent,
	callTool,
	quiet,
	say,
	scriptedStream,
} from '../../ambion/test/support/scripted.ts';
import { directoryBackend, memoryBackend } from '../../just-bash/src/index.ts';
import { openWorkspace, type WorkspaceEnv } from '../src/index.ts';
import { roomMirrorGuidance, roomMirrorPath } from '../src/mirror.ts';
import { processToolGuidance } from '../src/process-tools.ts';
import { snapshotGuidance } from '../src/snapshots.ts';
import { FILES_NOTE, wrapped } from './support/backends.ts';
import { agent, run, toolResults } from './support/room.ts';

const ROOM_MIRROR_GUIDANCE = roomMirrorGuidance('/rooms');
const BASE_TOOLS = ['read', 'write', 'edit', 'bash', 'ps', 'wait', 'cancel', 'snapshot', 'restore'];

/** Every line of one JSONL file, parsed. */
async function linesOf(env: WorkspaceEnv, path: string): Promise<Record<string, unknown>[]> {
	const read = await env.readTextFile(path);
	if (!read.ok) throw read.error;
	return read.value
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

// -- the built-in tools ------------------------------------------------------

describe('the built-in tools', () => {
	it('write, read and bash reach one directory on disk that two agents share, rooted at each home, and it outlasts dispose', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'ambion-'));
		onTestFinished(() => rm(parent, { recursive: true, force: true }));
		const root = join(parent, 'site');
		const site = openWorkspace({ name: name('shared'), backend: { bash: directoryBackend(root) } });
		const tools = site.tools();
		const results: Record<string, { tool: string; text: string; failed: boolean }[]> = {};
		const writerDone = Promise.withResolvers<void>();
		const session = await run(
			[agent('writer', { bundles: [tools] }), agent('reader', { bundles: [tools] })],
			{
				writer: (context, who, request) => {
					results[who] = toolResults(context);
					if (request === 1)
						return callTool('write', { path: 'notes.txt', content: 'slab pour Thu\n' });
					if (request === 2) return callTool('bash', { command: 'pwd; cat ~/notes.txt; ls /home' });
					if (request > 3) return quiet();
					writerDone.resolve();
					return say('written');
				},
				reader: async (context, who, request) => {
					results[who] = toolResults(context);
					// The reader waits for the writer's file, then reads it from the other home.
					if (request === 1) {
						await writerDone.promise;
						return callTool('read', { path: '/home/writer/notes.txt' });
					}
					return quiet();
				},
			},
		);
		const writer = results.writer ?? [];
		expect(writer[0]).toMatchObject({ tool: 'write', failed: false });
		expect(writer[1]?.tool).toBe('bash');
		// Both homes exist: the reminder reads each seat's processes at the
		// start of its activation, and that connect creates the reader's home.
		expect(writer[1]?.text).toMatch(
			/^\/home\/writer\nslab pour Thu\nreader\nwriter\n\n\[Process bash-[0-9a-f]{12} exited with code 0\. Output: \/home\/writer\/\.processes\/bash-[0-9a-f]{12}\/out\.\]$/,
		);
		const reader = results.reader ?? [];
		expect(reader[0]).toMatchObject({ tool: 'read', text: 'slab pour Thu\n', failed: false });
		expect((await session.read()).messages.filter(isSaid).map((m) => m.text)).toContain('written');
		await session.stop();
		await site.dispose();
		expect(await readFile(join(root, 'home', 'writer', 'notes.txt'), 'utf8')).toBe(
			'slab pour Thu\n',
		);
	});

	it('accepts Pi alternate edit arguments, and serializes two edits in one model batch so both land', async () => {
		const site = openWorkspace({ name: name('edits'), backend: { bash: memoryBackend() } });
		let final: string | undefined;
		const edit = (from: string, to: string) =>
			fauxToolCall('edit', { path: 'f.txt', edits: [{ oldText: from, newText: to }] });
		await run([agent('editor', { bundles: [site.tools()] })], {
			editor: (context, _who, request) => {
				if (request === 1)
					return callTool('write', { path: 'f.txt', content: 'alpha\nbeta\ngamma\n' });
				if (request === 2)
					return callTool('edit', { path: 'f.txt', oldText: 'alpha', newText: 'ALPHA' });
				if (request === 3)
					return fauxAssistantMessage([edit('beta', 'BETA'), edit('gamma', 'GAMMA')], {
						stopReason: 'toolUse',
					});
				if (request === 4) return callTool('read', { path: 'f.txt' });
				final = toolResults(context).at(-1)?.text;
				return quiet();
			},
		});
		expect(final).toBe('ALPHA\nBETA\nGAMMA\n');
		await site.dispose();
	});

	it('fail on the next call once the workspace is disposed, and the activation goes on', async () => {
		const site = openWorkspace({ name: name('disposed'), backend: { bash: memoryBackend() } });
		const tools = site.tools();
		let after: { tool: string; text: string; failed: boolean }[] = [];
		let custom: string | undefined;
		const probe = defineTool({
			name: 'probe',
			description: 'Reports whether a workspace is reachable.',
			parameters: Type.Object({}),
			execute: async (_params, ctx) => site.use(ctx.agent, async () => 'some', ctx.signal),
		});
		await run([agent('worker', { tools: [probe], bundles: [tools] })], {
			worker: async (context, _who, request) => {
				if (request === 1) return callTool('write', { path: 'a.txt', content: 'x' });
				if (request === 2) {
					await site.dispose();
					return callTool('read', { path: 'a.txt' });
				}
				if (request === 3) return callTool('probe', {});
				if (request > 4) return quiet();
				after = toolResults(context);
				custom = after.at(-1)?.text;
				return say('still here');
			},
		});
		expect(after[0]).toMatchObject({ tool: 'write', failed: false });
		expect(after[1]).toMatchObject({ tool: 'read', failed: true });
		expect(after[1]?.text).toMatch(/no longer available/);
		expect(custom).toMatch(/no longer available/);
	});
});

describe('the workspace bundle', () => {
	it('gives the file tools, the process tools, and the snapshot tools, and the /rooms guidance', async () => {
		const workspace = openWorkspace({
			name: name('empty-tools'),
			backend: { bash: wrapped() },
		});
		expect(workspace.tools()).toBe(workspace.tools());
		expect(workspace.tools().tools.map((tool) => tool.name)).toEqual(BASE_TOOLS);
		// The /rooms guidance names no room. A workspace states it only when the host sets `rooms`.
		const base = `${FILES_NOTE}\n\n${processToolGuidance()}\n\n${snapshotGuidance(workspace.name)}`;
		expect(workspace.tools().guidance).toBe(base);
		const mirroring = openWorkspace({
			name: name('rooms-tools'),
			backend: { bash: wrapped() },
			rooms: true,
		});
		expect(mirroring.tools().guidance).toBe(
			`${FILES_NOTE}\n\n${processToolGuidance()}\n\n${snapshotGuidance(mirroring.name)}\n\n${ROOM_MIRROR_GUIDANCE}`,
		);
		await workspace.dispose();
		await mirroring.dispose();
	});

	it('adds the guidance of the bash backend to the bundle', async () => {
		const workspace = openWorkspace({
			name: name('custom-guidance'),
			backend: { bash: wrapped(() => ({ guidance: 'Custom backend guidance.' })) },
		});
		expect(workspace.tools().guidance).toBe(
			`${FILES_NOTE}\n\n${processToolGuidance()}\n\n${snapshotGuidance(workspace.name)}\n\nCustom backend guidance.`,
		);
		await workspace.dispose();
	});
});

// -- ToolContext -------------------------------------------------------------

describe('ToolContext', () => {
	it('passes caller identity to a custom tool that closes over its resource', async () => {
		const connects: string[] = [];
		const backend = memoryBackend();
		const site = openWorkspace({ name: name('context'), backend: { bash: backend } });
		const seen: Record<string, string> = {};
		const where = defineTool({
			name: 'where',
			description: 'Names the workspace and its home.',
			parameters: Type.Object({}),
			execute: async (_params, ctx: ToolContext) => {
				const value = await site.use(
					ctx.agent,
					async (env) => {
						connects.push(ctx.agent.name);
						return `${site.name} at ${env.cwd}`;
					},
					ctx.signal,
				);
				const signal = ctx.signal instanceof AbortSignal ? 'signal' : 'no signal';
				return `${value}, ${signal}`;
			},
		});
		await run([agent('inside', { tools: [where] }), agent('outside', { tools: [where] })], {
			inside: (context, who, request) => {
				if (request <= 2) return callTool('where', {});
				seen[who] = toolResults(context)
					.map((r) => r.text)
					.join(' | ');
				return quiet();
			},
			outside: (context, who, request) => {
				if (request === 1) return callTool('where', {});
				seen[who] = toolResults(context)
					.map((r) => r.text)
					.join(' | ');
				return quiet();
			},
		});
		expect(seen.inside).toBe(
			`${site.name} at /home/inside, signal | ${site.name} at /home/inside, signal`,
		);
		expect(seen.outside).toBe(`${site.name} at /home/outside, signal`);
		expect(connects.sort()).toEqual(['inside', 'inside', 'outside'].sort());
		await site.dispose();
	});
});

// -- a running room ----------------------------------------------------------

describe('a workspace beside a running room', () => {
	it("audits each call, snapshots a file, and mirrors the room's record at the paths the backend layout names, and states each", async () => {
		const own = { audit: '/audit/calls.jsonl', rooms: '/mirror', snapshots: '/frozen' };
		const site = openWorkspace({
			name: name('own-layout'),
			backend: { bash: wrapped(() => ({ layout: own })) },
			audit: {},
			rooms: true,
		});
		const guidance = site.tools().guidance ?? '';
		expect(guidance).toContain(own.audit);
		expect(guidance).toContain(own.rooms);
		expect(guidance).toContain('call restore with its ref');
		const digest = createHash('sha256').update('done\n').digest('hex');
		const ref = snapshotUri(site.name, digest, '/home/worker/notes.txt');

		const roomId = name('through-room');
		const session = await startRoom({
			runtime: createRuntime({ storage: memoryJournals() }),
			name: roomId,
			agents: [agent('worker', { bundles: [site.tools()] })],
			execution: piExecution({
				sessions: 'memory',
				stream: scriptedStream(
					byAgent({
						worker: (_context, _who, request) => {
							if (request === 1) return callTool('write', { path: 'notes.txt', content: 'done\n' });
							if (request === 2) return callTool('snapshot', { paths: ['notes.txt'] });
							if (request === 3) return callTool('say', { text: 'first', refs: [ref] });
							return request === 4 ? say('second') : quiet();
						},
					}),
				),
			}),
		});
		const mirror = await site.mirror(session);
		expect(mirror.path).toBe(roomMirrorPath(own.rooms, roomId));
		const reader = definePerson({
			name: 'andrei',
			identity: 'Founder. Owns the room.',
			preferences: 'Lead with the decision.',
		});
		const visit = await enter(session, reader);
		await (await visit.send({ text: 'go' })).waitForClose();
		// Stop the room, and the "left" its shutdown writes, before the mirror:
		// a mirror that stopped first must not see what came after.
		await session.stop();
		await mirror.stop();

		const [audit, lines] = await site.use({ name: 'worker' }, (env) =>
			Promise.all([linesOf(env, own.audit), linesOf(env, mirror.path)]),
		);
		expect(audit.map((entry) => entry.tool)).toEqual(['write', 'snapshot']);
		expect(audit[0]).toMatchObject({ room: roomId, agent: 'worker', tool: 'write' });
		expect(audit[1]).toMatchObject({ agent: 'worker', result: { details: { refs: [ref] } } });
		const spoken = lines.filter((line) => line.kind === 'said' && line.from === 'worker');
		expect(spoken.map((line) => line.text)).toEqual(['first', 'second']);
		expect(spoken[0]?.refs).toEqual([ref]);
		expect(new TextDecoder().decode(await site.readSnapshot(ref))).toBe('done\n');
		expect(
			await site.use(site.mirrorAgent, (env) => env.exists(`${own.snapshots}/${digest}`)),
		).toEqual({ ok: true, value: true });
		expect(lines.every((line) => line.room === roomId)).toBe(true);
		// The arrival of a person holds reading preferences. The mirror leaves them out.
		expect(lines.some((line) => line.kind === 'arrived')).toBe(true);
		expect(lines.some((line) => 'preferences' in line)).toBe(false);
		expect(JSON.stringify(lines)).not.toContain('Lead with the decision.');
		expect(lines).toHaveLength((await session.read()).messages.length);
		await site.dispose();
	});
});

// -- two agents on one memory backend ----------------------------------------

describe('two agents on one workspace', () => {
	it('serializes complete operations from two agents, and disposes its files without reseeding them', async () => {
		let seeds = 0;
		const backend = memoryBackend({
			seed: async ({ writeFile }) => {
				seeds += 1;
				await writeFile('/shared.txt', 'base\n');
			},
		});
		const workspace = openWorkspace({ name: name('serialized-edits'), backend: { bash: backend } });
		const append = async (agentName: string, line: string) =>
			workspace.use({ name: agentName }, async (env) => {
				const read = await env.readTextFile('/shared.txt');
				if (!read.ok) throw read.error;
				const write = await env.writeFile('/shared.txt', `${read.value}${line}\n`);
				if (!write.ok) throw write.error;
			});
		await Promise.all([append('alpha', 'alpha'), append('beta', 'beta')]);
		expect(await backend.readFiles()).toContainEqual({
			path: '/shared.txt',
			text: 'base\nalpha\nbeta\n',
		});
		await workspace.dispose();
		expect(await backend.readFiles()).toEqual([]);
		expect(seeds).toBe(1);
	});
});
