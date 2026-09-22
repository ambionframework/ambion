import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT, type ExecutionEnv } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { openWorkspace } from '../src/index.ts';
import { directoryBackend, memoryBackend } from '../src/just-bash.ts';
import { backends } from './support/backends.ts';

const ctx = BACKGROUND_CONTEXT;
const agent = { name: 'ada' };

/** Run one command and return its combined output and exit code. */
async function sh(env: ExecutionEnv, command: string): Promise<{ output: string; code: number }> {
	let output = '';
	const result = await env.exec(
		command,
		{
			capture: { limits: { maxBytes: 100_000, maxLines: 1000 } },
			onUpdate: (update) => {
				if (update.kind === 'replace') output = update.output.text;
			},
		},
		ctx,
	);
	if (!result.ok) throw result.error;
	return { output, code: result.value.exitCode };
}

describe.each(backends)('the null device on $name', (backend) => {
	async function withEnv(run: (env: ExecutionEnv) => Promise<void>) {
		const handle = await backend.open();
		const workspace = openWorkspace({ name: 'devices', backend: handle.backend });
		try {
			await workspace.use(agent, run);
		} finally {
			await workspace.dispose();
			await handle.dispose();
		}
	}

	it('reads empty before any write', () =>
		withEnv(async (env) => {
			expect(await env.readTextFile('/dev/null', ctx)).toEqual({ ok: true, value: '' });
			expect((await sh(env, 'cat /dev/null')).output).toBe('');
		}));

	it('discards what a redirect writes', () =>
		withEnv(async (env) => {
			await sh(env, 'printf "%s" big > /dev/null');
			await sh(env, 'echo a > /dev/null; echo b >> /dev/null');
			expect((await sh(env, 'cat /dev/null')).output).toBe('');
			expect(await env.readTextFile('/dev/null', ctx)).toEqual({ ok: true, value: '' });
		}));

	it('discards what the write tool path writes', () =>
		withEnv(async (env) => {
			expect(await env.canonicalPath('/dev/null', ctx)).toEqual({ ok: true, value: '/dev/null' });
			expect((await env.writeFile('/dev/null', 'x', ctx)).ok).toBe(true);
			expect((await env.appendFile('/dev/null', 'y', ctx)).ok).toBe(true);
			expect(await env.readTextFile('/dev/null', ctx)).toEqual({ ok: true, value: '' });
		}));

	it('swallows stderr and keeps the exit code', () =>
		withEnv(async (env) => {
			const result = await sh(env, 'nosuchcmd 2>/dev/null; echo $?');
			expect(result.output.trim()).toBe('127');
		}));

	it('is a character device', () =>
		withEnv(async (env) => {
			expect((await sh(env, 'test -c /dev/null')).code).toBe(0);
		}));

	it('lists the same devices', () =>
		withEnv(async (env) => {
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
	it('adds no file to the memory backend', async () => {
		const backend = memoryBackend();
		const workspace = openWorkspace({ name: 'devices', backend });
		let before: Awaited<ReturnType<typeof backend.readFiles>> = [];
		await workspace.use(agent, async (env) => {
			await sh(env, 'true');
			before = await backend.readFiles();
			await sh(env, 'echo leak > /dev/null; echo more >> /dev/null');
		});
		const after = await backend.readFiles();
		expect(after).toEqual(before);
		expect(after.filter((file) => file.path.startsWith('/dev'))).toEqual([]);
		await workspace.dispose();
	});

	it('adds no dev directory to the root of the directory backend', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-devices-'));
		const workspace = openWorkspace({ name: 'devices', backend: directoryBackend(root) });
		try {
			await workspace.use(agent, async (env) => {
				await sh(env, 'echo leak > /dev/null; echo more >> /dev/null');
			});
			expect(await readdir(root)).not.toContain('dev');
		} finally {
			await workspace.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
