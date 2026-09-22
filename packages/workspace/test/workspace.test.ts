import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type AgentDefinition,
	defineAgent,
	defineTool,
	isSpoken,
	type Room,
	startRoom,
	type ToolContext,
} from '@ambionframework/ambion';
import { type PiOptions, pi, piExecution } from '@ambionframework/pi';
import type { ExecutionEnv } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/pi-agent-core';
import type { Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Bash, InMemoryFs } from 'just-bash';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { enter, roomName as name } from '../../ambion/test/support/room.ts';
import {
	byAgent,
	callTool,
	quiet,
	type Script,
	scripted,
	speak,
} from '../../ambion/test/support/scripted.ts';
import { BashEnv, DEFAULT_TIMEOUT_SECONDS } from '../src/bash-env.ts';
import type { WorkspaceBackend } from '../src/index.ts';
import {
	directoryBackend,
	memoryBackend,
	openWorkspace,
	ROOM_MIRROR_GUIDANCE,
} from '../src/index.ts';
import { MEMORY_LIMIT_BYTES } from '../src/just-bash.ts';

const workspaceAgent = (name: string) => ({ name, identity: `${name} identity` });

/** A context for a direct filesystem or shell call that has no other one. */
const ctx = BACKGROUND_CONTEXT;

/**
 * Run one command and collect its bounded output. `exec` now returns metadata
 * and an exit code, and delivers the combined output through `onUpdate`, so a
 * test reads the text from the final view.
 */
async function sh(
	env: ExecutionEnv,
	command: string,
	options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; exitCode?: number; code?: string; output: string }> {
	let output = '';
	const context = options.signal ? withAbortSignal(options.signal, BACKGROUND_CONTEXT) : ctx;
	const result = await env.exec(
		command,
		{
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			...(options.timeout === undefined ? {} : { timeout: options.timeout }),
			capture: { limits: { maxBytes: 1_000_000, maxLines: 100_000 } },
			onUpdate: (update) => {
				if (update.kind === 'replace') output = update.output.text;
			},
		},
		context,
	);
	return result.ok
		? { ok: true, exitCode: result.value.exitCode, output }
		: { ok: false, code: result.error.code, output };
}

/** Every tool result the model has been shown so far, oldest first. */
function toolResults(context: Context): { tool: string; text: string; failed: boolean }[] {
	return context.messages.flatMap((message) => {
		if (message.role !== 'toolResult') return [];
		const text = message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
		return [{ tool: message.toolName, text, failed: message.isError }];
	});
}

function agent(agentName: string, options: Partial<PiOptions> = {}) {
	return defineAgent({
		name: agentName,
		identity: 'Works in a workspace.',
		executor: pi({ instructions: 'work', model: `scripted/${agentName}`, ...options }),
	});
}

/** One room, one question, and the seats' scripts; resolves at the exchange close. */
async function run(agents: AgentDefinition[], seats: Record<string, Script>): Promise<Room> {
	const session = await startRoom({
		name: name('workspace'),
		agents,
		execution: piExecution({ stream: scripted(byAgent(seats)) }),
	});
	const visit = await enter(session);
	const exchange = await visit.send({ text: 'go' });
	await exchange.waitForClose();
	return session;
}

// -- the built-in tools ------------------------------------------------------

describe('the built-in tools', () => {
	it('write, read and bash reach one filesystem two agents share, rooted at each home', async () => {
		const site = openWorkspace({ name: name('shared'), backend: memoryBackend() });
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
	});

	it('accepts Pi alternate edit arguments through the ordinary workspace bundle', async () => {
		const site = openWorkspace({ name: name('edits'), backend: memoryBackend() });
		const tools = site.tools();
		let final: string | undefined;
		await run([agent('editor', { bundles: [tools] })], {
			editor: (context, _who, call) => {
				if (call === 1) return callTool('write', { path: 'f.txt', content: 'alpha\n' });
				if (call === 2)
					return callTool('edit', { path: 'f.txt', oldText: 'alpha', newText: 'ALPHA' });
				if (call === 3) return callTool('read', { path: 'f.txt' });
				final = toolResults(context).at(-1)?.text;
				return quiet();
			},
		});
		expect(final).toBe('ALPHA\n');
		await site.dispose();
	});

	it('serializes two edits in one model batch so both updates land', async () => {
		const site = openWorkspace({ name: name('edits'), backend: memoryBackend() });
		const tools = site.tools();
		let final: string | undefined;
		await run([agent('editor', { bundles: [tools] })], {
			editor: (context, _who, call) => {
				if (call === 1) return callTool('write', { path: 'f.txt', content: 'alpha\nbeta\n' });
				if (call === 2)
					return fauxAssistantMessage(
						[
							fauxToolCall('edit', {
								path: 'f.txt',
								edits: [{ oldText: 'alpha', newText: 'ALPHA' }],
							}),
							fauxToolCall('edit', {
								path: 'f.txt',
								edits: [{ oldText: 'beta', newText: 'BETA' }],
							}),
						],
						{ stopReason: 'toolUse' },
					);
				if (call === 3) return callTool('read', { path: 'f.txt' });
				final = toolResults(context).at(-1)?.text;
				return quiet();
			},
		});
		expect(final).toBe('ALPHA\nBETA\n');
		await site.dispose();
	});

	it('fail on the next call once the workspace is disposed, and the activation goes on', async () => {
		const site = openWorkspace({ name: name('disposed'), backend: memoryBackend() });
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

describe('the workspace resource owner', () => {
	it('keeps an empty backend tool set empty', async () => {
		const inner = memoryBackend();
		const workspace = openWorkspace({
			name: name('empty-tools'),
			backend: { tools: [], connect: (agent) => inner.connect(agent) },
		});
		expect(workspace.tools()).toBe(workspace.tools());
		expect(workspace.tools().tools).toEqual([]);
		// The /rooms guidance is unconditional: it names no room, so a
		// workspace states it even with no other guidance to add.
		expect(workspace.tools().guidance).toBe(ROOM_MIRROR_GUIDANCE);
		await workspace.dispose();
	});

	it('preserves backend-owned tools and guidance through the ordinary bundle', async () => {
		const inner = memoryBackend();
		const customTool = {
			name: 'inspect',
			label: 'Inspect',
			description: 'Inspect the custom backend.',
			parameters: Type.Object({}),
			execute: async (
				_toolCallId: string,
				_params: unknown,
				_onUpdate: unknown,
				toolContext: { env: ExecutionEnv },
			) => ({
				content: [{ type: 'text' as const, text: toolContext.env.cwd }],
				details: {},
			}),
		};
		const workspace = openWorkspace({
			name: name('custom-tools'),
			backend: {
				tools: [customTool],
				guidance: 'Custom backend guidance.',
				connect: (agent) => inner.connect(agent),
			},
		});
		const bundle = workspace.tools();
		expect(bundle.guidance).toBe(`Custom backend guidance.\n\n${ROOM_MIRROR_GUIDANCE}`);
		expect(bundle.tools.map((tool) => tool.name)).toEqual(['inspect']);
		const tool = bundle.tools[0];
		if (tool === undefined) throw new Error('The backend tool is missing.');
		const result = await tool.invoke(
			{},
			{
				agent: workspaceAgent('alpha'),
				callId: 'custom-call',
			},
		);
		if (typeof result === 'string') throw new Error('The backend must return a structured result.');
		expect(result.content[0]).toMatchObject({ type: 'text', text: '/home/alpha' });
		await workspace.dispose();
	});

	it('shares queue and revocation between direct use and bound tools', async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let toolCalls = 0;
		const inner = memoryBackend();
		const workspace = openWorkspace({
			name: name('shared-owner'),
			backend: {
				tools: [
					{
						name: 'inspect',
						label: 'Inspect',
						description: 'Inspect the workspace.',
						parameters: Type.Object({}),
						execute: async () => {
							toolCalls += 1;
							return { content: [{ type: 'text' as const, text: 'called' }], details: {} };
						},
					},
				],
				connect: (caller, signal) => inner.connect(caller, signal),
			},
		});
		const active = workspace.use(workspaceAgent('alpha'), async () => {
			started.resolve();
			await release.promise;
		});
		await started.promise;
		const bound = workspace.tools().tools[0];
		if (bound === undefined) throw new Error('The bound tool is missing.');
		const queued = bound.invoke({}, { agent: workspaceAgent('beta'), callId: 'queued' });
		const disposing = workspace.dispose();
		expect(toolCalls).toBe(0);
		release.resolve();
		await active;
		await disposing;
		await expect(queued).rejects.toThrow(/no longer available/i);
		expect(toolCalls).toBe(0);
	});

	it('serializes complete operations from two agents, so shared edits do not lose updates', async () => {
		const backend = memoryBackend({
			seed: async ({ writeFile }) => writeFile('/shared.txt', 'base\n'),
		});
		const workspace = openWorkspace({
			name: name('serialized-edits'),
			backend,
		});
		const append = async (agentName: string, line: string) =>
			workspace.use(workspaceAgent(agentName), async (env) => {
				const read = await env.readTextFile('/shared.txt', ctx);
				if (!read.ok) throw new Error(read.error.message);
				const write = await env.writeFile('/shared.txt', `${read.value}${line}\n`, ctx);
				if (!write.ok) throw new Error(write.error.message);
			});
		await Promise.all([append('alpha', 'alpha'), append('beta', 'beta')]);
		const files = await backend.readFiles();
		expect(files).toContainEqual({ path: '/shared.txt', text: 'base\nalpha\nbeta\n' });
		await workspace.dispose();
	});

	it('revokes pending and queued calls while an active call drains', async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let cleaned = 0;
		const inner = memoryBackend();
		const backend = {
			tools: [],
			connect: async (agent: { name: string; identity: string }) => {
				started.resolve();
				await release.promise;
				const env = await inner.connect(agent);
				env.cleanup = async () => void cleaned++;
				return env;
			},
		};
		const workspace = openWorkspace({ name: name('revoke'), backend });
		const active = workspace.use(workspaceAgent('alpha'), () => 'done');
		await started.promise;
		const queued = workspace.use(workspaceAgent('beta'), () => 'queued');
		const disposing = workspace.dispose();
		release.resolve();
		await expect(active).rejects.toThrow(/no longer available/i);
		await expect(queued).rejects.toThrow(/no longer available/i);
		await disposing;
		expect(cleaned).toBe(1);
	});

	it('checks an aborted queued call before connecting it', async () => {
		const release = Promise.withResolvers<void>();
		let connects = 0;
		const inner = memoryBackend();
		const workspace = openWorkspace({
			name: name('queued-abort'),
			backend: {
				tools: [],
				connect: async (agent, signal) => {
					connects += 1;
					if (connects === 1) await release.promise;
					if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
					return inner.connect(agent, signal);
				},
			},
		});
		const active = workspace.use(workspaceAgent('alpha'), () => 'active');
		const controller = new AbortController();
		const queued = workspace.use(workspaceAgent('beta'), () => 'queued', controller.signal);
		controller.abort();
		release.resolve();
		await expect(active).resolves.toBe('active');
		await expect(queued).rejects.toThrow(/abort/i);
		expect(connects).toBe(1);
		await workspace.dispose();
	});

	it('cleans an environment after active work drains before dispose', async () => {
		let cleaned = 0;
		let disposed = 0;
		const inner = memoryBackend();
		const workspace = openWorkspace({
			name: name('cleanup'),
			backend: {
				tools: [],
				connect: async (agent, signal) => {
					const env = await inner.connect(agent, signal);
					env.cleanup = async () => void cleaned++;
					return env;
				},
				dispose: async () => void disposed++,
			},
		});
		await workspace.use(workspaceAgent('alpha'), async (env) => {
			const result = await env.exec('echo ready', undefined, ctx);
			if (!result.ok) throw new Error('command failed');
		});
		await workspace.dispose();
		expect(cleaned).toBe(1);
		expect(disposed).toBe(1);
	});
});

// -- ToolContext -------------------------------------------------------------

describe('ToolContext', () => {
	it('passes caller identity to a custom tool that closes over its resource', async () => {
		const connects: string[] = [];
		const backend = memoryBackend();
		const site = openWorkspace({ name: name('context'), backend });
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

// -- the adapter -------------------------------------------------------------

describe('the just-bash adapter', () => {
	async function env(
		agentName = 'alpha',
	): Promise<{ env: ExecutionEnv; backend: WorkspaceBackend }> {
		const backend = memoryBackend();
		return { env: await backend.connect(agent(agentName)), backend };
	}

	it('roots the environment at the home, and expands ~ to it', async () => {
		const { env: alpha } = await env();
		expect(alpha.cwd).toBe('/home/alpha');
		expect(await alpha.absolutePath('~', ctx)).toEqual({ ok: true, value: '/home/alpha' });
		expect(await alpha.absolutePath('~/x', ctx)).toEqual({ ok: true, value: '/home/alpha/x' });
		expect(await alpha.absolutePath('sub/../y', ctx)).toEqual({ ok: true, value: '/home/alpha/y' });
		const pwd = await sh(alpha, 'cd; pwd; echo ~');
		expect(pwd).toMatchObject({ ok: true, output: '/home/alpha\n/home/alpha\n' });
	});

	it("classifies just-bash's thrown errors into Pi's codes", async () => {
		const { env: alpha } = await env();
		await alpha.writeFile('f.txt', 'x', ctx);
		const codeOf = (result: { ok: boolean; error?: { code: string } }) =>
			result.ok ? 'ok' : result.error?.code;
		expect(codeOf(await alpha.readTextFile('missing', ctx))).toBe('not_found');
		expect(codeOf(await alpha.canonicalPath('missing', ctx))).toBe('not_found');
		expect(codeOf(await alpha.readTextFile('.', ctx))).toBe('is_directory');
		expect(codeOf(await alpha.listDir('f.txt', ctx))).toBe('not_directory');
		expect(codeOf(await alpha.createDir('f.txt', { recursive: false }, ctx))).toBe('invalid');
		expect(codeOf(await alpha.remove('.', undefined, ctx))).toBe('invalid');
		expect(await alpha.exists('missing', ctx)).toEqual({ ok: true, value: false });
	});

	it('lists a directory with each entry sized, and reads lines', async () => {
		const { env: alpha } = await env();
		await alpha.writeFile('a.txt', 'one\ntwo\nthree', ctx);
		await alpha.createDir('d', undefined, ctx);
		const listed = await alpha.listDir('.', ctx);
		expect(listed.ok && listed.value.map((f) => [f.name, f.kind, f.size])).toEqual([
			['a.txt', 'file', 13],
			['d', 'directory', 0],
		]);
		expect(await alpha.readTextLines('a.txt', { maxLines: 2 }, ctx)).toEqual({
			ok: true,
			value: ['one', 'two'],
		});
		await alpha.renameFile('a.txt', 'd/b.txt', ctx);
		expect(await alpha.readTextFile('d/b.txt', ctx)).toEqual({
			ok: true,
			value: 'one\ntwo\nthree',
		});
	});

	it('hands one bounded view of combined output to onUpdate, and keeps no cd', async () => {
		const { env: alpha } = await env();
		const combined = await sh(alpha, 'mkdir -p sub && cd sub && pwd && echo warn >&2');
		expect(combined).toMatchObject({ ok: true, exitCode: 0, output: '/home/alpha/sub\nwarn\n' });
		expect(await sh(alpha, 'pwd')).toMatchObject({ ok: true, output: '/home/alpha\n' });
		expect(await sh(alpha, 'pwd', { cwd: 'sub' })).toMatchObject({
			ok: true,
			output: '/home/alpha/sub\n',
		});
	});

	it('tells an abort apart from a timeout', async () => {
		const { env: alpha } = await env();
		const controller = new AbortController();
		const aborted = sh(alpha, 'sleep 5', { signal: controller.signal });
		controller.abort();
		expect(await aborted).toMatchObject({ ok: false, code: 'aborted' });
		expect(await sh(alpha, 'sleep 5', { timeout: 0.05 })).toMatchObject({
			ok: false,
			code: 'timeout',
		});
	});

	it('gives a command that names no timeout the default, and stops it there', async () => {
		expect(DEFAULT_TIMEOUT_SECONDS).toBe(30);
		const fs = new InMemoryFs();
		const short = new BashEnv(new Bash({ fs, cwd: '/' }), '/', { timeout: 0.05 });
		expect(await sh(short, 'sleep 5')).toMatchObject({ ok: false, code: 'timeout' });
		expect(await sh(short, 'echo quick')).toMatchObject({ ok: true, output: 'quick\n' });
		// A caller's own timeout wins over the default.
		expect(await sh(short, 'sleep 0.1; echo late', { timeout: 1 })).toMatchObject({
			ok: true,
			output: 'late\n',
		});
	});

	it('runs js-exec and python3, and has no curl', async () => {
		const { env: alpha } = await env();
		expect(await sh(alpha, 'js-exec -c "console.log(1 + 2)"')).toMatchObject({
			ok: true,
			exitCode: 0,
			output: '3\n',
		});
		expect(await sh(alpha, 'python3 -c "print(1 + 2)"')).toMatchObject({
			ok: true,
			exitCode: 0,
			output: '3\n',
		});
		expect(await sh(alpha, 'curl --version')).toMatchObject({
			ok: true,
			exitCode: 127,
			output: 'bash: curl: command not found\n',
		});
	});

	it('spills the whole output to a file when the limits cut it', async () => {
		const { env: alpha } = await env();
		let viewSpill: string | undefined;
		const result = await alpha.exec(
			'printf "%s\\n" a b c d e',
			{
				capture: { limits: { maxBytes: 1_000_000, maxLines: 2 }, spill: true },
				onUpdate: (update) => {
					if (update.kind === 'replace') viewSpill = update.output.spillPath;
				},
			},
			ctx,
		);
		expect(result.ok && result.value.truncation.truncated).toBe(true);
		const spillPath = result.ok ? result.value.spillPath : undefined;
		expect(spillPath).toMatch(/^\/tmp\/shell-[0-9a-f]+\.out$/);
		expect(viewSpill).toBe(spillPath);
		if (spillPath !== undefined) {
			expect(await alpha.readTextFile(spillPath, ctx)).toEqual({
				ok: true,
				value: 'a\nb\nc\nd\ne\n',
			});
		}
	});

	it('holds 128 MB in memory, and refuses the write that goes past it', async () => {
		expect(MEMORY_LIMIT_BYTES).toBe(128 * 1024 * 1024);
		const { env: alpha } = await env();
		const half = new Uint8Array(MEMORY_LIMIT_BYTES / 2);
		expect(await alpha.writeFile('first', half, ctx)).toEqual({ ok: true, value: undefined });
		// The second half does not fit beside the layout `Bash` seeds into a fresh filesystem.
		const over = await alpha.writeFile('second', half, ctx);
		expect(over.ok).toBe(false);
		expect(!over.ok && over.error.message).toMatch(/ENOSPC/);
		await alpha.remove('first', undefined, ctx);
		expect(await alpha.writeFile('second', half, ctx)).toEqual({ ok: true, value: undefined });
	});

	it('creates /tmp before a temp file needs it, and appends to it', async () => {
		const { env: alpha } = await env();
		const file = await alpha.createTempFile({ prefix: 'bash-', suffix: '.journal' }, ctx);
		expect(file.ok && file.value).toMatch(/^\/tmp\/bash-[0-9a-f]+\.journal$/);
		if (!file.ok) return;
		await alpha.appendFile(file.value, 'a', ctx);
		await alpha.appendFile(file.value, 'b', ctx);
		expect(await alpha.readTextFile(file.value, ctx)).toEqual({ ok: true, value: 'ab' });
		const dir = await alpha.createTempDir(undefined, ctx);
		expect(dir.ok && dir.value).toMatch(/^\/tmp\/tmp-/);
	});

	it('recreates a home removed out from under it, and shares files across agents', async () => {
		const backend = memoryBackend();
		const alpha = await backend.connect(agent('alpha'));
		await alpha.writeFile('shared.txt', 'from alpha', ctx);
		const beta = await backend.connect(agent('beta'));
		expect(await beta.readTextFile('/home/alpha/shared.txt', ctx)).toEqual({
			ok: true,
			value: 'from alpha',
		});
		await beta.remove('/home/alpha', { recursive: true }, ctx);
		const again = await backend.connect(agent('alpha'));
		expect(await again.exists('.', ctx)).toEqual({ ok: true, value: true });
		expect(await sh(again, 'ls ~')).toMatchObject({ ok: true, output: '' });
	});
});

// -- memoryBackend seeding and reading ---------------------------------------

describe('memoryBackend', () => {
	it('runs a seed function once, lazily, and reads what it wrote back without an agent', async () => {
		let calls = 0;
		const backend = memoryBackend({
			seed: async (write) => {
				calls++;
				await write.writeFile('/site/README.md', 'start here\n');
			},
		});
		expect(calls).toBe(0); // nothing runs until something asks for the filesystem
		expect(await backend.readFiles()).toEqual([{ path: '/site/README.md', text: 'start here\n' }]);
		const alpha = await backend.connect(agent('alpha'));
		await alpha.writeFile('/site/notes.md', 'a note\n', ctx);
		expect(calls).toBe(1); // memoised: connect reused the filesystem readFiles already built
		// The first `connect` also lays just-bash's own binaries into the shared
		// filesystem (`docs/workspace.md` §8), so this checks the two site files
		// among everything else rather than the listing on its own.
		const after = await backend.readFiles();
		expect(after).toContainEqual({ path: '/site/README.md', text: 'start here\n' });
		expect(after).toContainEqual({ path: '/site/notes.md', text: 'a note\n' });
		const paths = after.map((f) => f.path);
		expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
	});

	it('skips a symlink in readFiles rather than following it', async () => {
		const backend = memoryBackend({
			seed: async (write) => write.writeFile('/site/README.md', 'hi\n'),
		});
		const alpha = await backend.connect(agent('alpha'));
		await alpha.exec('ln -s /site ~/sitelink && ln -s /nowhere ~/dangling', undefined, ctx);
		const files = await backend.readFiles();
		expect(files).toContainEqual({ path: '/site/README.md', text: 'hi\n' });
		expect(files.some((f) => f.path.includes('sitelink') || f.path.includes('dangling'))).toBe(
			false,
		);
	});

	it('retries a seed that failed once, rather than staying poisoned', async () => {
		let attempt = 0;
		const backend = memoryBackend({
			seed: async (write) => {
				attempt++;
				if (attempt === 1) throw new Error('transient');
				await write.writeFile('/site/README.md', 'hi\n');
			},
		});
		await expect(backend.readFiles()).rejects.toThrow('transient');
		expect(await backend.readFiles()).toEqual([{ path: '/site/README.md', text: 'hi\n' }]);
		expect(attempt).toBe(2);
	});

	it('disposes in-memory resources without retaining old files or reseeding them', async () => {
		let seeds = 0;
		const backend = memoryBackend({
			seed: async ({ writeFile }) => {
				seeds += 1;
				await writeFile('/old.txt', 'old\n');
			},
		});
		const workspace = openWorkspace({ name: name('memory-dispose'), backend });
		await workspace.use(workspaceAgent('alpha'), async (env) => {
			const old = await env.readTextFile('/old.txt', ctx);
			if (!old.ok) throw new Error('seed missing');
		});
		await workspace.dispose();
		expect(await backend.readFiles()).toEqual([]);
		expect(seeds).toBe(1);
	});
});

// -- the directory backend ---------------------------------------------------

describe('directoryBackend', () => {
	it('writes through to a real directory it creates', async () => {
		const root = join(await mkdtemp(join(tmpdir(), 'ambion-')), 'site');
		try {
			const site = openWorkspace({ name: name('disk'), backend: directoryBackend(root) });
			const tools = site.tools();
			let read: string | undefined;
			await run([agent('scribe', { bundles: [tools] })], {
				scribe: (context, _who, call) => {
					if (call === 1) return callTool('write', { path: 'journal.md', content: '# day one\n' });
					if (call === 2) return callTool('bash', { command: 'cat ~/journal.md' });
					read = toolResults(context).at(-1)?.text;
					return quiet();
				},
			});
			expect(read).toBe('# day one\n');
			expect(await readFile(join(root, 'home', 'scribe', 'journal.md'), 'utf8')).toBe(
				'# day one\n',
			);
			await site.dispose();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
