/**
 * The virtual root and the null device, on both bash backends. A search
 * from `/` finds a shared file. `/dev/null` reads empty, discards every
 * write, and leaves no file on the backend beneath.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspace } from '@ambionframework/workspace';
import { BACKGROUND_CONTEXT, type ExecutionEnv } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { directoryBackend, memoryBackend } from '../src/just-bash.ts';
import { backends, sh } from './support/backends.ts';

const ctx = BACKGROUND_CONTEXT;
const agent = { name: 'ada' };
const empty = { ok: true, value: '' };

describe.each(backends)('the root and the null device on $name', (backend) => {
	async function withEnv(run: (env: ExecutionEnv) => Promise<void>) {
		const handle = await backend.open();
		const workspace = openWorkspace({ name: 'devices', backend: { bash: handle.backend } });
		try {
			await workspace.use(agent, run);
		} finally {
			await workspace.dispose();
			await handle.dispose();
		}
	}

	it('finds shared artifacts from the virtual root', () =>
		withEnv(async (env) => {
			expect((await env.createDir('/shared', undefined, ctx)).ok).toBe(true);
			expect((await env.writeFile('/shared/prototype.html', '<h1>Relay</h1>', ctx)).ok).toBe(true);
			expect(await env.readBinaryFile('/shared/prototype.html', ctx)).toEqual({
				ok: true,
				value: new TextEncoder().encode('<h1>Relay</h1>'),
			});
			expect((await sh(env, 'cat /shared/prototype.html')).output).toBe('<h1>Relay</h1>');
			expect(await env.fileInfo('/', ctx)).toMatchObject({
				ok: true,
				value: { kind: 'directory' },
			});
			expect(await sh(env, 'find / -iname "prototype.html"')).toEqual({
				ok: true,
				exitCode: 0,
				output: '/shared/prototype.html\n',
			});
		}));

	it('reads empty, before and after a redirect or the write tool path writes to it', () =>
		withEnv(async (env) => {
			expect(await env.readTextFile('/dev/null', ctx)).toEqual(empty);
			expect((await sh(env, 'cat /dev/null')).output).toBe('');
			await sh(env, 'printf "%s" big > /dev/null');
			await sh(env, 'echo a > /dev/null; echo b >> /dev/null');
			expect((await sh(env, 'cat /dev/null')).output).toBe('');
			expect(await env.canonicalPath('/dev/null', ctx)).toEqual({ ok: true, value: '/dev/null' });
			expect((await env.writeFile('/dev/null', 'x', ctx)).ok).toBe(true);
			expect((await env.appendFile('/dev/null', 'y', ctx)).ok).toBe(true);
			expect(await env.readTextFile('/dev/null', ctx)).toEqual(empty);
			expect(await env.readBinaryFile('/dev/null', ctx)).toEqual({
				ok: true,
				value: new Uint8Array(),
			});
		}));

	it('is a character device that swallows stderr and keeps the exit code, beside the same devices', () =>
		withEnv(async (env) => {
			expect((await sh(env, 'nosuchcmd 2>/dev/null; echo $?')).output.trim()).toBe('127');
			expect((await sh(env, 'test -c /dev/null')).exitCode).toBe(0);
			const listing = await sh(env, 'ls /dev');
			expect(listing.output.split('\n').filter(Boolean)).toEqual([
				'fd',
				'null',
				'stderr',
				'stdin',
				'stdout',
				'zero',
			]);
			expect((await sh(env, 'ls / | grep -c dev')).output.trim()).toBe('1');
		}));
});

describe('the null device leaves no trace', () => {
	const leak = 'echo leak > /dev/null; echo more >> /dev/null';

	it('adds no file to the memory backend', async () => {
		const backend = memoryBackend();
		const workspace = openWorkspace({ name: 'devices', backend: { bash: backend } });
		let before: Awaited<ReturnType<typeof backend.readFiles>> = [];
		await workspace.use(agent, async (env) => {
			await sh(env, 'true');
			before = await backend.readFiles();
			await sh(env, leak);
		});
		const after = await backend.readFiles();
		expect(after).toEqual(before);
		expect(after.filter((file) => file.path.startsWith('/dev'))).toEqual([]);
		await workspace.dispose();
	});

	it('adds no dev directory to the root of the directory backend', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-devices-'));
		const workspace = openWorkspace({ name: 'devices', backend: { bash: directoryBackend(root) } });
		await workspace.use(agent, (env) => sh(env, leak));
		expect(await readdir(root)).not.toContain('dev');
		await workspace.dispose();
		await rm(root, { recursive: true, force: true });
	});
});
