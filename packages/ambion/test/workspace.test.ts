import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionEnv } from '@earendil-works/pi-agent-core';
import type { Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Bash, InMemoryFs } from 'just-bash';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { BashEnv, DEFAULT_TIMEOUT_SECONDS } from '../src/bash-env.ts';
import {
	type AgentDefinition,
	defineAgent,
	defineTool,
	defineWorkspace,
	destroyWorkspace,
	directoryBackend,
	isSpoken,
	type Session,
	startSession,
	stopSession,
	type ToolContext,
	type WorkspaceBackend,
} from '../src/index.ts';
import { MEMORY_LIMIT_BYTES, memoryBackend } from '../src/just-bash.ts';
import { assistant, enter, roomName as name } from './support/room.ts';
import {
	byAgent,
	callTool,
	quiet,
	type Script,
	scripted,
	speak,
	toolNames,
} from './support/scripted.ts';

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

// -- defineWorkspace ---------------------------------------------------------

describe('defineWorkspace', () => {
	it('holds one handle per name until destroyWorkspace frees it', async () => {
		const site = defineWorkspace({ name: 'site-once' });
		expect(site.name).toBe('site-once');
		expect(() => defineWorkspace({ name: 'site-once' })).toThrow(/already defined/);
		await destroyWorkspace(site);
		await destroyWorkspace(site); // terminal, and a second call does nothing
		const again = defineWorkspace({ name: 'site-once' });
		expect(again).not.toBe(site);
		await destroyWorkspace(again);
	});

	it('stays live when the backend fails to delete, so a retry is possible', async () => {
		let attempts = 0;
		const flaky: WorkspaceBackend = {
			connect: () => memoryBackend().connect(agent('nobody')),
			destroy: async () => {
				if (++attempts === 1) throw new Error('disk busy');
			},
		};
		const site = defineWorkspace({ name: 'site-flaky', backend: flaky });
		await expect(destroyWorkspace(site)).rejects.toThrow('disk busy');
		expect(() => defineWorkspace({ name: 'site-flaky' })).toThrow(/already defined/);
		await destroyWorkspace(site);
		expect(attempts).toBe(2);
		await destroyWorkspace(defineWorkspace({ name: 'site-flaky' }));
	});

	it('refuses a name the room could not address', () => {
		expect(() => defineWorkspace({ name: 'Team Site' })).toThrow(/Invalid workspace name/);
	});

	it('keeps the four built-in names free for an agent that names a workspace', async () => {
		const site = defineWorkspace({ name: name('reserved') });
		const read = defineTool({
			name: 'read',
			description: 'A custom read.',
			parameters: Type.Object({}),
			execute: () => 'custom',
		});
		expect(() => agent('clash', { workspace: site, tools: [read] })).toThrow(
			/'read' is a built-in/,
		);
		expect(() => agent('free', { tools: [read] })).not.toThrow();
		expect(() =>
			agent('other', { workspace: site, tools: [{ name: 'bash', execute() {} }] }),
		).toThrow(/'bash' is a built-in/);
		expect(() => agent('fake', { workspace: { name: 'x' } as never })).toThrow(
			/must come from defineWorkspace/,
		);
		await destroyWorkspace(site);
	});

	it('refuses an assistant that names a workspace', async () => {
		const site = defineWorkspace({ name: name('assistant') });
		const connected = agent('assistant', { workspace: site });
		expect(() =>
			startSession({ name: name('workspace'), assistant: connected, agents: [] }),
		).toThrow(/names a workspace/);
		await destroyWorkspace(site);
	});
});

// -- the built-in tools ------------------------------------------------------

describe('the built-in tools', () => {
	it('bind read, write, edit and bash to a connected agent, and nothing to a plain one', async () => {
		const site = defineWorkspace({ name: name('hands') });
		const seen = new Map<string, string[]>();
		await run([agent('connected', { workspace: site }), agent('plain')], {
			connected: (context, who) => {
				seen.set(who, toolNames(context));
				return quiet();
			},
			plain: (context, who) => {
				seen.set(who, toolNames(context));
				return quiet();
			},
		});
		expect(seen.get('connected')).toEqual(['say', 'read', 'write', 'edit', 'bash']);
		expect(seen.get('plain')).toEqual(['say']);
		await destroyWorkspace(site);
	});

	it("states the workspace's reach in a connected agent's system prompt, and nothing to a plain one", async () => {
		const site = defineWorkspace({ name: name('briefed') });
		const prompts: Record<string, string> = {};
		await run([agent('connected', { workspace: site }), agent('plain')], {
			connected: (context, who) => {
				prompts[who] = context.systemPrompt ?? '';
				return quiet();
			},
			plain: (context, who) => {
				prompts[who] = context.systemPrompt ?? '';
				return quiet();
			},
		});
		expect(prompts.connected).toContain('Your workspace gives you four tools');
		expect(prompts.connected).toContain('js-exec');
		expect(prompts.connected).toContain('no network');
		expect(prompts.plain).not.toContain('Your workspace gives you four tools');
		await destroyWorkspace(site);
	});

	it('write, read and bash reach one filesystem two agents share, rooted at each home', async () => {
		const site = defineWorkspace({ name: name('shared') });
		const results: Record<string, { tool: string; text: string; failed: boolean }[]> = {};
		const writerDone = Promise.withResolvers<void>();
		const session = await run(
			[agent('writer', { workspace: site }), agent('reader', { workspace: site })],
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
		await destroyWorkspace(site);
	});

	it('runs two edits to one file in one batch one at a time, so both land', async () => {
		const site = defineWorkspace({ name: name('edits') });
		let final: string | undefined;
		await run([agent('editor', { workspace: site })], {
			editor: (context, _who, call) => {
				if (call === 1) return callTool('write', { path: 'f.txt', content: 'alpha\nbeta\n' });
				if (call === 2) {
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
				}
				if (call === 3) return callTool('read', { path: 'f.txt' });
				final = toolResults(context).at(-1)?.text;
				return quiet();
			},
		});
		expect(final).toBe('ALPHA\nBETA\n');
		await destroyWorkspace(site);
	});

	it('fail on the next call once the workspace is destroyed, and the activation goes on', async () => {
		const site = defineWorkspace({ name: name('destroyed') });
		let after: { tool: string; text: string; failed: boolean }[] = [];
		let custom: string | undefined;
		const probe = defineTool({
			name: 'probe',
			description: 'Reports whether a workspace is reachable.',
			parameters: Type.Object({}),
			execute: async (_params, ctx) => ((await ctx.workspace()) === undefined ? 'none' : 'some'),
		});
		await run([agent('worker', { workspace: site, tools: [probe] })], {
			worker: async (context, _who, call) => {
				if (call === 1) return callTool('write', { path: 'a.txt', content: 'x' });
				if (call === 2) {
					await destroyWorkspace(site);
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
		expect(after[1]?.text).toMatch(/is destroyed/);
		expect(custom).toBe('none');
	});
});

// -- ToolContext -------------------------------------------------------------

describe('ToolContext', () => {
	it('hands a custom tool its workspace, fresh on every call, and undefined without one', async () => {
		const connects: string[] = [];
		const inner = memoryBackend();
		const counting: WorkspaceBackend = {
			connect(who, signal) {
				connects.push(who.name);
				return inner.connect(who, signal);
			},
			destroy: () => inner.destroy(),
		};
		const site = defineWorkspace({ name: name('context'), backend: counting });
		const seen: Record<string, string> = {};
		const where = defineTool({
			name: 'where',
			description: 'Names the workspace and its home.',
			parameters: Type.Object({}),
			execute: async (_params, ctx: ToolContext) => {
				const workspace = await ctx.workspace();
				const signal = ctx.signal instanceof AbortSignal ? 'signal' : 'no signal';
				if (!workspace) return `nowhere, ${signal}`;
				return `${workspace.name} at ${workspace.env.cwd}, ${signal}`;
			},
		});
		await run(
			[agent('inside', { workspace: site, tools: [where] }), agent('outside', { tools: [where] })],
			{
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
			},
		);
		expect(seen.inside).toBe(
			`${site.name} at /home/inside, signal | ${site.name} at /home/inside, signal`,
		);
		expect(seen.outside).toBe('nowhere, signal');
		expect(connects).toEqual(['inside', 'inside']); // one connect per call, none cached
		await destroyWorkspace(site);
	});

	it("makes a connect failure the tool call's failure", async () => {
		const broken: WorkspaceBackend = {
			connect: async () => {
				throw new Error('no such host');
			},
			destroy: async () => {},
		};
		const site = defineWorkspace({ name: name('broken'), backend: broken });
		let result: { tool: string; text: string; failed: boolean } | undefined;
		await run([agent('unlucky', { workspace: site })], {
			unlucky: (context, _who, call) => {
				if (call === 1) return callTool('bash', { command: 'true' });
				result = toolResults(context)[0];
				return quiet();
			},
		});
		expect(result).toMatchObject({ tool: 'bash', failed: true });
		expect(result?.text).toContain('no such host');
		await destroyWorkspace(site);
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
		const file = await alpha.createTempFile({ prefix: 'bash-', suffix: '.log' });
		expect(file.ok && file.value).toMatch(/^\/tmp\/bash-[0-9a-f]+\.log$/);
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

	it('stays destroyed: destroy makes connect and readFiles reject, not resurrect', async () => {
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
		await expect(backend.readFiles()).rejects.toThrow(/destroyed/);
		await expect(backend.connect(agent('alpha'))).rejects.toThrow(/destroyed/);
		expect(seedCalls).toBe(1); // never re-ran
	});
});

// -- the directory backend ---------------------------------------------------

describe('directoryBackend', () => {
	it('writes through to a real directory it creates, and destroy empties it', async () => {
		const root = join(await mkdtemp(join(tmpdir(), 'ambion-')), 'site');
		const site = defineWorkspace({ name: name('disk'), backend: directoryBackend(root) });
		let read: string | undefined;
		await run([agent('scribe', { workspace: site })], {
			scribe: (context, _who, call) => {
				if (call === 1) return callTool('write', { path: 'log.md', content: '# day one\n' });
				if (call === 2) return callTool('bash', { command: 'cat ~/log.md' });
				read = toolResults(context).at(-1)?.text;
				return quiet();
			},
		});
		expect(read).toBe('# day one\n');
		expect(await readFile(join(root, 'home', 'scribe', 'log.md'), 'utf8')).toBe('# day one\n');
		await destroyWorkspace(site);
		expect(await readdir(root)).toEqual([]);
	});

	it('stays destroyed: connect after destroy rejects rather than recreating the root', async () => {
		const root = join(await mkdtemp(join(tmpdir(), 'ambion-')), 'site');
		const backend = directoryBackend(root);
		await backend.connect(agent('alpha'));
		await backend.destroy();
		await expect(backend.connect(agent('beta'))).rejects.toThrow(/destroyed/);
	});
});
