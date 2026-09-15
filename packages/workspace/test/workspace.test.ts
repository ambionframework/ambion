import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type AgentDefinition,
	defineAgent,
	defineTool,
	isSpoken,
	type Session,
	startSession,
	stopSession,
	type ToolContext,
} from '@ambionframework/ambion';
import type { ExecutionEnv } from '@earendil-works/pi-agent-core';
import type { Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Bash, InMemoryFs } from 'just-bash';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { assistant, enter, roomName as name } from '../../ambion/test/support/room.ts';
import {
	byAgent,
	callTool,
	quiet,
	type Script,
	scripted,
	speak,
} from '../../ambion/test/support/scripted.ts';
import { BashEnv, DEFAULT_TIMEOUT_SECONDS } from '../src/bash-env.ts';
import { directoryBackend, memoryBackend, openWorkspace, workspaceTools } from '../src/index.ts';
import { MEMORY_LIMIT_BYTES } from '../src/just-bash.ts';
import type { WorkspaceBackend } from '../src/resource.ts';

const workspaceAgent = (name: string) => ({ name, identity: `${name} identity` });

/** Every tool result the model has been shown so far, oldest first. */
function toolResults(context: Context): { tool: string; text: string; failed: boolean }[] {
	return context.messages.flatMap((message) => {
		if (message.role !== 'toolResult') return [];
		const text = message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
		return [{ tool: message.toolName, text, failed: message.isError }];
	});
}

function agent(agentName: string, options: Partial<Parameters<typeof defineAgent>[0]> = {}) {
	return defineAgent({
		name: agentName,
		identity: 'Works in a workspace.',
		instructions: 'work',
		model: `scripted/${agentName}`,
		...options,
	});
}

/** One room, one delivery, and the seats' scripts; resolves when the room settles. */
async function run(agents: AgentDefinition[], seats: Record<string, Script>): Promise<Session> {
	const session = startSession({
		name: name('workspace'),
		assistant,
		agents,
		streamFn: scripted(byAgent(seats)),
	});
	const visit = await enter(session);
	await visit.deliver({ text: 'go' });
	await session.settled();
	return session;
}

// -- the built-in tools ------------------------------------------------------

describe('the built-in tools', () => {
	it('write, read and bash reach one filesystem two agents share, rooted at each home', async () => {
		const site = openWorkspace({ name: name('shared'), backend: memoryBackend() });
		const tools = workspaceTools(site);
		const results: Record<string, { tool: string; text: string; failed: boolean }[]> = {};
		const writerDone = Promise.withResolvers<void>();
		const session = await run(
			[agent('writer', { tools: [tools] }), agent('reader', { tools: [tools] })],
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
		expect((await session.messages()).filter(isSpoken).map((m) => m.text)).toContain('written');
		await stopSession(session);
		await site.destroy();
	});

	it('accepts Pi alternate edit arguments through the ordinary workspace bundle', async () => {
		const site = openWorkspace({ name: name('edits'), backend: memoryBackend() });
		const tools = workspaceTools(site);
		let final: string | undefined;
		await run([agent('editor', { tools: [tools] })], {
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
		await site.destroy();
	});

	it('serializes two edits in one model batch so both updates land', async () => {
		const site = openWorkspace({ name: name('edits'), backend: memoryBackend() });
		const tools = workspaceTools(site);
		let final: string | undefined;
		await run([agent('editor', { tools: [tools] })], {
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
		await site.destroy();
	});

	it('fail on the next call once the workspace is destroyed, and the activation goes on', async () => {
		const site = openWorkspace({ name: name('destroyed'), backend: memoryBackend() });
		const tools = workspaceTools(site);
		let after: { tool: string; text: string; failed: boolean }[] = [];
		let custom: string | undefined;
		const probe = defineTool({
			name: 'probe',
			description: 'Reports whether a workspace is reachable.',
			parameters: Type.Object({}),
			execute: async (_params, ctx) => site.use(ctx.agent, async () => 'some', ctx.signal),
		});
		await run([agent('worker', { tools: [tools, probe] })], {
			worker: async (context, _who, call) => {
				if (call === 1) return callTool('write', { path: 'a.txt', content: 'x' });
				if (call === 2) {
					await site.destroy();
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
			backend: { tools: [], connect: (agent) => inner.connect(agent), destroy: async () => {} },
		});
		expect(workspaceTools(workspace).tools).toEqual([]);
		expect(workspaceTools(workspace).guidance).toBeUndefined();
		await workspace.destroy();
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
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				context: { env: ExecutionEnv },
			) => ({
				content: [{ type: 'text' as const, text: context.env.cwd }],
				details: {},
			}),
		};
		const workspace = openWorkspace({
			name: name('custom-tools'),
			backend: {
				tools: [customTool],
				guidance: 'Custom backend guidance.',
				connect: (agent) => inner.connect(agent),
				destroy: async () => {},
			},
		});
		const bundle = workspaceTools(workspace);
		expect(bundle.guidance).toBe('Custom backend guidance.');
		expect(bundle.tools.map((tool) => (tool as { name: string }).name)).toEqual(['inspect']);
		const result = await (
			bundle.tools[0] as {
				execute: (
					params: unknown,
					context: ToolContext,
				) => Promise<{ content: { text: string }[] }>;
			}
		).execute(
			{},
			{
				agent: workspaceAgent('alpha'),
				callId: 'custom-call',
			},
		);
		expect(result.content[0]?.text).toBe('/home/alpha');
		await workspace.destroy();
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
				const read = await env.readTextFile('/shared.txt');
				if (!read.ok) throw new Error(read.error.message);
				const write = await env.writeFile('/shared.txt', `${read.value}${line}\n`);
				if (!write.ok) throw new Error(write.error.message);
			});
		await Promise.all([append('alpha', 'alpha'), append('beta', 'beta')]);
		const files = await backend.readFiles();
		expect(files).toContainEqual({ path: '/shared.txt', text: 'base\nalpha\nbeta\n' });
		await workspace.destroy();
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
			destroy: async () => {},
		};
		const workspace = openWorkspace({ name: name('revoke'), backend });
		const active = workspace.use(workspaceAgent('alpha'), () => 'done');
		await started.promise;
		const queued = workspace.use(workspaceAgent('beta'), () => 'queued');
		const destroying = workspace.destroy();
		release.resolve();
		await expect(active).rejects.toThrow(/no longer available/i);
		await expect(queued).rejects.toThrow(/no longer available/i);
		await destroying;
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
				destroy: async () => {},
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
		await workspace.destroy();
	});

	it('cleans an environment after active work drains before deletion', async () => {
		let cleaned = 0;
		let destroyed = 0;
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
				destroy: async () => void destroyed++,
			},
		});
		await workspace.use(workspaceAgent('alpha'), async (env) => {
			const result = await env.exec('echo ready');
			if (!result.ok) throw new Error('command failed');
		});
		await workspace.destroy();
		expect(cleaned).toBe(1);
		expect(destroyed).toBe(1);
	});

	it('drains active work, joins concurrent destroy calls, and destroys once', async () => {
		const release = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		let destroys = 0;
		const inner = memoryBackend();
		const workspace = openWorkspace({
			name: name('destroy-drain'),
			backend: {
				tools: [],
				connect: async (agent) => inner.connect(agent),
				destroy: async () => {
					destroys += 1;
				},
			},
		});
		const active = workspace.use(workspaceAgent('alpha'), async () => {
			started.resolve();
			await release.promise;
		});
		await started.promise;
		const first = workspace.destroy();
		const second = workspace.destroy();
		await Promise.resolve();
		expect(destroys).toBe(0);
		release.resolve();
		await Promise.all([active, first, second]);
		expect(destroys).toBe(1);
		await expect(workspace.use(workspaceAgent('alpha'), () => 'late')).rejects.toThrow(
			/no longer available/i,
		);
	});

	it('joins dispose when destroy has already started', async () => {
		let destroys = 0;
		const inner = memoryBackend();
		const workspace = openWorkspace({
			name: name('dispose-destroy-race'),
			backend: {
				tools: [],
				connect: (agent) => inner.connect(agent),
				destroy: async () => void destroys++,
			},
		});
		const destroying = workspace.destroy();
		await expect(workspace.dispose()).resolves.toBeUndefined();
		await destroying;
		expect(destroys).toBe(1);
	});

	it('keeps a failed deletion retryable, then becomes terminal without resurrection', async () => {
		let destroys = 0;
		const inner = memoryBackend();
		const workspace = openWorkspace({
			name: name('retry-destroy'),
			backend: {
				tools: [],
				connect: (agent) => inner.connect(agent),
				destroy: async () => {
					destroys += 1;
					if (destroys === 1) throw new Error('disk busy');
				},
			},
		});
		await expect(workspace.destroy()).rejects.toThrow('disk busy');
		await expect(workspace.use(workspaceAgent('alpha'), () => 'retry works')).resolves.toBe(
			'retry works',
		);
		await workspace.destroy();
		await expect(workspace.use(workspaceAgent('alpha'), () => 'resurrected')).rejects.toThrow(
			/no longer available/i,
		);
		expect(destroys).toBe(2);
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
		await site.destroy();
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
		expect(await alpha.absolutePath('~')).toEqual({ ok: true, value: '/home/alpha' });
		expect(await alpha.absolutePath('~/x')).toEqual({ ok: true, value: '/home/alpha/x' });
		expect(await alpha.absolutePath('sub/../y')).toEqual({ ok: true, value: '/home/alpha/y' });
		const pwd = await alpha.exec('cd; pwd; echo ~');
		expect(pwd).toMatchObject({ ok: true, value: { stdout: '/home/alpha\n/home/alpha\n' } });
	});

	it("classifies just-bash's thrown errors into Pi's codes", async () => {
		const { env: alpha } = await env();
		await alpha.writeFile('f.txt', 'x');
		const codeOf = (result: { ok: boolean; error?: { code: string } }) =>
			result.ok ? 'ok' : result.error?.code;
		expect(codeOf(await alpha.readTextFile('missing'))).toBe('not_found');
		expect(codeOf(await alpha.canonicalPath('missing'))).toBe('not_found');
		expect(codeOf(await alpha.readTextFile('.'))).toBe('is_directory');
		expect(codeOf(await alpha.listDir('f.txt'))).toBe('not_directory');
		expect(codeOf(await alpha.createDir('f.txt', { recursive: false }))).toBe('invalid');
		expect(codeOf(await alpha.remove('.'))).toBe('invalid');
		expect(await alpha.exists('missing')).toEqual({ ok: true, value: false });
	});

	it('lists a directory with each entry sized, and reads lines', async () => {
		const { env: alpha } = await env();
		await alpha.writeFile('a.txt', 'one\ntwo\nthree');
		await alpha.createDir('d');
		const listed = await alpha.listDir('.');
		expect(listed.ok && listed.value.map((f) => [f.name, f.kind, f.size])).toEqual([
			['a.txt', 'file', 13],
			['d', 'directory', 0],
		]);
		expect(await alpha.readTextLines('a.txt', { maxLines: 2 })).toEqual({
			ok: true,
			value: ['one', 'two'],
		});
		await alpha.renameFile('a.txt', 'd/b.txt');
		expect(await alpha.readTextFile('d/b.txt')).toEqual({ ok: true, value: 'one\ntwo\nthree' });
	});

	it('delivers output through the callbacks before exec resolves, and keeps no cd', async () => {
		const { env: alpha } = await env();
		const chunks: string[] = [];
		const result = await alpha.exec('mkdir -p sub && cd sub && pwd && echo warn >&2', {
			onStdout: (chunk) => chunks.push(`out:${chunk}`),
			onStderr: (chunk) => chunks.push(`err:${chunk}`),
		});
		expect(chunks).toEqual(['out:/home/alpha/sub\n', 'err:warn\n']);
		expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
		expect(await alpha.exec('pwd')).toMatchObject({ ok: true, value: { stdout: '/home/alpha\n' } });
		expect(await alpha.exec('pwd', { cwd: 'sub' })).toMatchObject({
			ok: true,
			value: { stdout: '/home/alpha/sub\n' },
		});
	});

	it('tells an abort apart from a timeout', async () => {
		const { env: alpha } = await env();
		const controller = new AbortController();
		const aborted = alpha.exec('sleep 5', { abortSignal: controller.signal });
		controller.abort();
		expect(await aborted).toMatchObject({ ok: false, error: { code: 'aborted' } });
		expect(await alpha.exec('sleep 5', { timeout: 0.05 })).toMatchObject({
			ok: false,
			error: { code: 'timeout' },
		});
	});

	it('gives a command that names no timeout the default, and stops it there', async () => {
		expect(DEFAULT_TIMEOUT_SECONDS).toBe(30);
		const fs = new InMemoryFs();
		const short = new BashEnv(new Bash({ fs, cwd: '/' }), '/', { timeout: 0.05 });
		expect(await short.exec('sleep 5')).toMatchObject({ ok: false, error: { code: 'timeout' } });
		expect(await short.exec('echo quick')).toMatchObject({
			ok: true,
			value: { stdout: 'quick\n' },
		});
		// A caller's own timeout wins over the default.
		expect(await short.exec('sleep 0.1; echo late', { timeout: 1 })).toMatchObject({
			ok: true,
			value: { stdout: 'late\n' },
		});
	});

	it('runs js-exec and python3, and has no curl', async () => {
		const { env: alpha } = await env();
		expect(await alpha.exec('js-exec -c "console.log(1 + 2)"')).toMatchObject({
			ok: true,
			value: { stdout: '3\n', exitCode: 0 },
		});
		expect(await alpha.exec('python3 -c "print(1 + 2)"')).toMatchObject({
			ok: true,
			value: { stdout: '3\n', exitCode: 0 },
		});
		expect(await alpha.exec('curl --version')).toMatchObject({
			ok: true,
			value: { exitCode: 127, stderr: 'bash: curl: command not found\n' },
		});
	});

	it('holds 128 MB in memory, and refuses the write that goes past it', async () => {
		expect(MEMORY_LIMIT_BYTES).toBe(128 * 1024 * 1024);
		const { env: alpha } = await env();
		const half = new Uint8Array(MEMORY_LIMIT_BYTES / 2);
		expect(await alpha.writeFile('first', half)).toEqual({ ok: true, value: undefined });
		// The second half does not fit beside the layout `Bash` seeds into a fresh filesystem.
		const over = await alpha.writeFile('second', half);
		expect(over.ok).toBe(false);
		expect(!over.ok && over.error.message).toMatch(/ENOSPC/);
		await alpha.remove('first');
		expect(await alpha.writeFile('second', half)).toEqual({ ok: true, value: undefined });
	});

	it('creates /tmp before a temp file needs it, and appends to it', async () => {
		const { env: alpha } = await env();
		const file = await alpha.createTempFile({ prefix: 'bash-', suffix: '.journal' });
		expect(file.ok && file.value).toMatch(/^\/tmp\/bash-[0-9a-f]+\.journal$/);
		if (!file.ok) return;
		await alpha.appendFile(file.value, 'a');
		await alpha.appendFile(file.value, 'b');
		expect(await alpha.readTextFile(file.value)).toEqual({ ok: true, value: 'ab' });
		const dir = await alpha.createTempDir();
		expect(dir.ok && dir.value).toMatch(/^\/tmp\/tmp-/);
	});

	it('recreates a home removed out from under it, and shares files across agents', async () => {
		const backend = memoryBackend();
		const alpha = await backend.connect(agent('alpha'));
		await alpha.writeFile('shared.txt', 'from alpha');
		const beta = await backend.connect(agent('beta'));
		expect(await beta.readTextFile('/home/alpha/shared.txt')).toEqual({
			ok: true,
			value: 'from alpha',
		});
		await beta.remove('/home/alpha', { recursive: true });
		const again = await backend.connect(agent('alpha'));
		expect(await again.exists('.')).toEqual({ ok: true, value: true });
		expect(await again.exec('ls ~')).toMatchObject({ ok: true, value: { stdout: '' } });
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
		await alpha.writeFile('/site/notes.md', 'a note\n');
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
		await alpha.exec('ln -s /site ~/sitelink && ln -s /nowhere ~/dangling');
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

	it('clears the backend on destroy, so later reads do not resurrect old files', async () => {
		let seedCalls = 0;
		const backend = memoryBackend({
			seed: async (write) => {
				seedCalls++;
				await write.writeFile('/site/README.md', 'hi\n');
			},
		});
		await backend.readFiles();
		expect(seedCalls).toBe(1);
		await backend.destroy();
		expect(await backend.readFiles()).toEqual([]);
		expect(await backend.connect(agent('alpha'))).toBeDefined();
		expect(seedCalls).toBe(1); // destroy clears data; it never re-runs the seed
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
			const old = await env.readTextFile('/old.txt');
			if (!old.ok) throw new Error('seed missing');
		});
		await workspace.dispose();
		expect(await backend.readFiles()).toEqual([]);
		expect(seeds).toBe(1);
	});
});

// -- the directory backend ---------------------------------------------------

describe('directoryBackend', () => {
	it('writes through to a real directory it creates, and destroy empties it', async () => {
		const root = join(await mkdtemp(join(tmpdir(), 'ambion-')), 'site');
		const site = openWorkspace({ name: name('disk'), backend: directoryBackend(root) });
		const tools = workspaceTools(site);
		let read: string | undefined;
		await run([agent('scribe', { tools: [tools] })], {
			scribe: (context, _who, call) => {
				if (call === 1) return callTool('write', { path: 'journal.md', content: '# day one\n' });
				if (call === 2) return callTool('bash', { command: 'cat ~/journal.md' });
				read = toolResults(context).at(-1)?.text;
				return quiet();
			},
		});
		expect(read).toBe('# day one\n');
		expect(await readFile(join(root, 'home', 'scribe', 'journal.md'), 'utf8')).toBe('# day one\n');
		await site.destroy();
		expect(await readdir(root)).toEqual([]);
	});

	it('stays destroyed: connect after destroy rejects rather than recreating the root', async () => {
		const root = join(await mkdtemp(join(tmpdir(), 'ambion-')), 'site');
		const backend = directoryBackend(root);
		const site = openWorkspace({ name: name('disk-closed'), backend });
		await site.use({ name: 'alpha', identity: 'alpha' }, () => undefined);
		await site.destroy();
		await expect(site.use({ name: 'beta', identity: 'beta' }, () => undefined)).rejects.toThrow(
			/no longer available/i,
		);
	});
});
