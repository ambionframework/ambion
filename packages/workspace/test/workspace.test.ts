/**
 * A workspace in use: the built-in tools in a running room, on disk and in
 * memory; the bundle a backend extends; a room that the workspace audits and
 * mirrors at the paths its backend names; and two agents whose operations
 * the workspace serializes. The just-bash adapter has its own tests in
 * `@ambionframework/just-bash`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type AgentDefinition,
	defineTool,
	isSpoken,
	type Room,
	startRoom,
	type ToolContext,
} from '@ambionframework/ambion';
import { type PiOptions, piExecution } from '@ambionframework/pi';
import { BACKGROUND_CONTEXT, type ExecutionEnv } from '@earendil-works/pi-agent-core';
import type { Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { describe, expect, it, onTestFinished } from 'vitest';
import { enter, roomName as name, scriptedAgent } from '../../ambion/test/support/room.ts';
import {
	byAgent,
	callTool,
	quiet,
	type Script,
	scripted,
	speak,
} from '../../ambion/test/support/scripted.ts';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { directoryBackend, memoryBackend } from '../../just-bash/src/index.ts';
import { defaultToolGuidance } from '../src/default-tools.ts';
import { openWorkspace } from '../src/index.ts';
import { roomMirrorGuidance, roomMirrorPath } from '../src/mirror.ts';
import { callAs, toolOf, wrapped } from './support/backends.ts';

const ROOM_MIRROR_GUIDANCE = roomMirrorGuidance('/rooms');
const ctx = BACKGROUND_CONTEXT;

/** Every tool result the model has been shown so far, oldest first. */
function toolResults(context: Context): { tool: string; text: string; failed: boolean }[] {
	return context.messages.flatMap((message) => {
		if (message.role !== 'toolResult') return [];
		const text = message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
		return [{ tool: message.toolName, text, failed: message.isError }];
	});
}

const agent = (agentName: string, options: Partial<PiOptions> = {}) =>
	scriptedAgent(agentName, undefined, options);

/** Every line of one JSONL file, parsed. */
async function linesOf(env: ExecutionEnv, path: string): Promise<Record<string, unknown>[]> {
	const read = await env.readTextFile(path, ctx);
	if (!read.ok) throw read.error;
	return read.value
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** One room, one question, and the seats' scripts; resolves at the exchange close. */
async function run(agents: AgentDefinition[], seats: Record<string, Script>): Promise<Room> {
	const session = stopAtEnd(
		await startRoom({
			name: name('workspace'),
			agents,
			execution: piExecution({ sessions: 'memory', stream: scripted(byAgent(seats)) }),
		}),
	);
	const visit = await enter(session);
	const exchange = await visit.send({ text: 'go' });
	await exchange.waitForClose();
	return session;
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
				writer: (context, who, call) => {
					results[who] = toolResults(context);
					if (call === 1)
						return callTool('write', { path: 'notes.txt', content: 'slab pour Thu\n' });
					if (call === 2) return callTool('bash', { command: 'pwd; cat ~/notes.txt; ls /home' });
					if (call > 3) return quiet();
					writerDone.resolve();
					return speak('written');
				},
				reader: async (context, who, call) => {
					results[who] = toolResults(context);
					// The reader waits for the writer's file, then reads it from the other home.
					if (call === 1) {
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
		// Only the writer's home exists yet: nothing calls connect before an
		// activation's first tool asks for it, and the reader is still waiting.
		expect(writer[1]?.text).toBe('/home/writer\nslab pour Thu\nwriter\n');
		const reader = results.reader ?? [];
		expect(reader[0]).toMatchObject({ tool: 'read', text: 'slab pour Thu\n', failed: false });
		expect((await session.read()).messages.filter(isSpoken).map((m) => m.text)).toContain(
			'written',
		);
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
			editor: (context, _who, call) => {
				if (call === 1)
					return callTool('write', { path: 'f.txt', content: 'alpha\nbeta\ngamma\n' });
				if (call === 2)
					return callTool('edit', { path: 'f.txt', oldText: 'alpha', newText: 'ALPHA' });
				if (call === 3)
					return fauxAssistantMessage([edit('beta', 'BETA'), edit('gamma', 'GAMMA')], {
						stopReason: 'toolUse',
					});
				if (call === 4) return callTool('read', { path: 'f.txt' });
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
			worker: async (context, _who, call) => {
				if (call === 1) return callTool('write', { path: 'a.txt', content: 'x' });
				if (call === 2) {
					await site.dispose();
					return callTool('read', { path: 'a.txt' });
				}
				if (call === 3) return callTool('probe', {});
				if (call > 4) return quiet();
				after = toolResults(context);
				custom = after.at(-1)?.text;
				return speak('still here');
			},
		});
		expect(after[0]).toMatchObject({ tool: 'write', failed: false });
		expect(after[1]).toMatchObject({ tool: 'read', failed: true });
		expect(after[1]?.text).toMatch(/no longer available/);
		expect(custom).toMatch(/no longer available/);
	});
});

describe('the workspace bundle', () => {
	it('gives a backend with no tools of its own the four file tools, and the /rooms guidance', async () => {
		const workspace = openWorkspace({
			name: name('empty-tools'),
			backend: { bash: wrapped(() => ({ tools: [] })) },
		});
		expect(workspace.tools()).toBe(workspace.tools());
		expect(workspace.tools().tools.map((tool) => tool.name)).toEqual([
			'read',
			'write',
			'edit',
			'bash',
		]);
		// The /rooms guidance names no room, so a workspace states it with no other guidance.
		expect(workspace.tools().guidance).toBe(`${defaultToolGuidance()}\n\n${ROOM_MIRROR_GUIDANCE}`);
		await workspace.dispose();
	});

	it('preserves backend-owned tools and guidance through the ordinary bundle', async () => {
		const inspect = {
			name: 'inspect',
			label: 'Inspect',
			description: 'Inspect the custom backend.',
			parameters: Type.Object({}),
			execute: async (
				_toolCallId: string,
				_params: unknown,
				_onUpdate: unknown,
				toolContext: { env: ExecutionEnv },
			) => ({ content: [{ type: 'text' as const, text: toolContext.env.cwd }], details: {} }),
		};
		const workspace = openWorkspace({
			name: name('custom-tools'),
			backend: {
				bash: wrapped(() => ({ tools: [inspect], guidance: 'Custom backend guidance.' })),
			},
		});
		const bundle = workspace.tools();
		expect(bundle.guidance).toBe(
			`${defaultToolGuidance()}\n\nCustom backend guidance.\n\n${ROOM_MIRROR_GUIDANCE}`,
		);
		expect(bundle.tools.map((tool) => tool.name)).toEqual([
			'read',
			'write',
			'edit',
			'bash',
			'inspect',
		]);
		const result = await toolOf(workspace, 'inspect').invoke({}, callAs('alpha'));
		if (typeof result === 'string') throw new Error('The backend must return a structured result.');
		expect(result.content[0]).toMatchObject({ type: 'text', text: '/home/alpha' });
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
			inside: (context, who, call) => {
				if (call <= 2) return callTool('where', {});
				seen[who] = toolResults(context)
					.map((r) => r.text)
					.join(' | ');
				return quiet();
			},
			outside: (context, who, call) => {
				if (call === 1) return callTool('where', {});
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
	it("audits each call and mirrors the room's record at the paths the backend layout names, and states both", async () => {
		const own = { audit: '/audit/calls.jsonl', rooms: '/mirror' };
		const site = openWorkspace({
			name: name('own-layout'),
			backend: { bash: wrapped(() => ({ layout: own })) },
			audit: {},
		});
		const guidance = site.tools().guidance ?? '';
		expect(guidance).toContain(own.audit);
		expect(guidance).toContain(own.rooms);

		const roomId = name('through-room');
		const session = await startRoom({
			name: roomId,
			agents: [agent('worker', { bundles: [site.tools()] })],
			execution: piExecution({
				sessions: 'memory',
				stream: scripted(
					byAgent({
						worker: (_context, _who, call) => {
							if (call === 1) return callTool('write', { path: 'notes.txt', content: 'done\n' });
							if (call === 2) return speak('first');
							return call === 3 ? speak('second') : quiet();
						},
					}),
				),
			}),
		});
		const mirror = await site.mirror(session);
		expect(mirror.path).toBe(roomMirrorPath(own.rooms, roomId));
		const visit = await enter(session);
		await (await visit.send({ text: 'go' })).waitForClose();
		// Stop the room, and the "left" its shutdown writes, before the mirror:
		// a mirror that stopped first must not see what came after.
		await session.stop();
		await mirror.stop();

		const [audit, lines] = await site.use({ name: 'worker' }, (env) =>
			Promise.all([linesOf(env, own.audit), linesOf(env, mirror.path)]),
		);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({ room: roomId, agent: 'worker', tool: 'write' });
		const spoken = lines.filter((line) => line.kind === 'said' && line.from === 'worker');
		expect(spoken.map((line) => line.text)).toEqual(['first', 'second']);
		expect(lines.every((line) => line.room === roomId)).toBe(true);
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
				const read = await env.readTextFile('/shared.txt', ctx);
				if (!read.ok) throw read.error;
				const write = await env.writeFile('/shared.txt', `${read.value}${line}\n`, ctx);
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
