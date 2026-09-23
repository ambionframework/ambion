/**
 * The workstation when things go wrong: a connection that drops before or
 * during an operation, a command that writes far more than its view, a
 * child that keeps the output open, a timeout no timer holds, and a
 * credential resolver that fails.
 */

import { readFile, stat } from 'node:fs/promises';
import type { WorkspaceEnv } from '@ambionframework/workspace';
import { BACKGROUND_CONTEXT, type ShellOutputUpdate } from '@earendil-works/pi-agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { workstationBackend } from '../src/index.ts';
import { startSshServer, type TestServer } from './support/server.ts';
import { hasSetsid } from './support/setsid.ts';

const ctx = BACKGROUND_CONTEXT;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(): Promise<TestServer> {
	const started = await startSshServer(['ada']);
	cleanups.push(() => started.stop());
	return started;
}

function backendFor(started: TestServer, options: Partial<TestServer['options']> = {}) {
	const backend = workstationBackend({ ...started.options, ...options });
	cleanups.push(async () => backend.dispose?.());
	return backend;
}

/** `promise`, or a rejection that names the hang after `ms`. */
function within<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`hung past ${ms} ms`)), ms).unref();
		}),
	]);
}

const idle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasSetsid)('a dropped connection', () => {
	it('fails each call on the dead session at once, and the next connect logs in again', async () => {
		const started = await server();
		const backend = backendFor(started);
		const env = await backend.connect({ name: 'ada' });
		started.dropClients();
		await idle(200);
		const calls: Array<Promise<{ ok: boolean }>> = [
			env.readTextFile('a.txt', ctx),
			env.writeFile('a.txt', 'x', ctx),
			env.createDir('d', undefined, ctx),
			env.exec('true', undefined, ctx),
		];
		for (const result of await within(Promise.all(calls))) expect(result.ok).toBe(false);
		await env.cleanup();
		const again = await backend.connect({ name: 'ada' });
		expect(await again.exec('true', undefined, ctx)).toMatchObject({ ok: true });
		await again.cleanup();
		expect(started.logins.get('ada')).toBe(2);
	});

	it('answers a command the drop cut short with an error, and no exit code', async () => {
		const started = await server();
		const backend = backendFor(started);
		const env = await backend.connect({ name: 'ada' });
		const running = env.exec('sleep 5; echo late', undefined, ctx);
		await idle(300);
		started.dropClients();
		expect(await within(running)).toMatchObject({ ok: false, error: { code: 'unknown' } });
		await env.cleanup();
	});
});

describe.skipIf(!hasSetsid)('a large output', () => {
	it('keeps the view within its limits, and spills the whole output to a private file', async () => {
		const started = await server();
		const backend = backendFor(started);
		const env: WorkspaceEnv = await backend.connect({ name: 'ada' });
		const updates: ShellOutputUpdate[] = [];
		const result = await env.exec(
			'seq 1 300000',
			{
				capture: { limits: { maxBytes: 2_000, maxLines: 50 }, spill: true },
				onUpdate: (update) => updates.push(update),
			},
			ctx,
		);
		await env.cleanup();
		if (!result.ok) throw result.error;
		expect(result.value.truncation).toMatchObject({ truncated: true, totalLines: 300_000 });
		const view = updates[0];
		if (view?.kind !== 'replace') throw new Error('no view');
		expect(view.output.text.split('\n').at(-1)).toBe('300000');
		const spilled = result.value.spillPath ?? '';
		expect((await stat(spilled)).mode & 0o777).toBe(0o600);
		const whole = await readFile(spilled, 'utf8');
		expect(whole.split('\n').length).toBe(300_001);
	});

	it('removes the spill file when the view keeps the whole output', async () => {
		const started = await server();
		const backend = backendFor(started);
		const env = await backend.connect({ name: 'ada' });
		const token = `short-${Date.now()}-${Math.random()}`;
		const result = await env.exec(
			`echo ${token}`,
			{ capture: { limits: { maxBytes: 2_000, maxLines: 50 }, spill: true } },
			ctx,
		);
		const leftover = await env.exec(`grep -l -- ${token} /tmp/shell-*.out`, undefined, ctx);
		await env.cleanup();
		expect(result).toMatchObject({ ok: true, value: { truncation: { truncated: false } } });
		expect(result.ok ? result.value.spillPath : 'failed').toBeUndefined();
		// grep answers 1 when no file holds the token.
		expect(leftover).toMatchObject({ ok: true, value: { exitCode: 1 } });
	});
});

describe.skipIf(!hasSetsid)('a command that ends early', () => {
	it('returns soon after the command exits, while a child keeps the output open', async () => {
		const started = await server();
		const backend = backendFor(started);
		const env = await backend.connect({ name: 'ada' });
		const updates: ShellOutputUpdate[] = [];
		const began = Date.now();
		const result = await env.exec(
			'sleep 3 & echo started',
			{ timeout: 10, onUpdate: (update) => updates.push(update) },
			ctx,
		);
		const took = Date.now() - began;
		await env.cleanup();
		expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
		expect(took).toBeLessThan(2_000);
		const view = updates[0];
		expect(view?.kind === 'replace' && view.output.text).toBe('started\n');
	});

	it('gives the exit status of a command that exits before its deadline, while a child keeps writing', async () => {
		const started = await server();
		const backend = backendFor(started);
		const env = await backend.connect({ name: 'ada' });
		const chatty = '(while :; do echo tick; sleep 0.1; done) & echo started';
		// Under the short deadline the deadline ends the wait; under the long one the drain limit
		// does, and the view says that it cut the output.
		for (const [timeout, notice] of [
			[2, false],
			[20, true],
		] as const) {
			const updates: ShellOutputUpdate[] = [];
			const began = Date.now();
			const result = await env.exec(
				chatty,
				{ timeout, onUpdate: (update) => updates.push(update) },
				ctx,
			);
			const took = Date.now() - began;
			expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
			expect(took).toBeLessThan(10_000);
			const view = updates[0];
			const text = view?.kind === 'replace' ? view.output.text : '';
			expect(text.includes('closed the output 5 seconds after the command exited')).toBe(notice);
		}
		await env.cleanup();
	});

	it('refuses a timeout that is not a positive finite number of seconds', async () => {
		const started = await server();
		const backend = backendFor(started);
		const env = await backend.connect({ name: 'ada' });
		for (const timeout of [0, -1, Number.NaN, 3_000_000]) {
			expect(await env.exec('true', { timeout }, ctx)).toMatchObject({
				ok: false,
				error: { code: 'timeout' },
			});
		}
		await env.cleanup();
	});
});

describe.skipIf(!hasSetsid)('a credential resolver that fails', () => {
	it('rejects the connect, and the next connect asks the resolver again', async () => {
		const started = await server();
		let calls = 0;
		const backend = backendFor(started, {
			credentialFor: (agent) => {
				calls += 1;
				if (calls === 1) throw new Error('The vault is sealed.');
				return started.options.credentialFor(agent);
			},
		});
		await expect(backend.connect({ name: 'ada' })).rejects.toThrow('The vault is sealed.');
		const env = await backend.connect({ name: 'ada' });
		expect(await env.exec('true', undefined, ctx)).toMatchObject({ ok: true });
		await env.cleanup();
	});
});
