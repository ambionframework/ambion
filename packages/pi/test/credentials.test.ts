/**
 * Subscription sign-ins. The file store is real, on a real disk. The stream
 * test sends a real request to a local server that stands in for the
 * provider: a real provider needs an account.
 */

import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { type Credential, normalizeContext } from '@earendil-works/pi-ai';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { fileCredentials } from '../src/credentials.ts';
import { terminalInteraction } from '../src/login.ts';
import { createExecutionServices } from '../src/services.ts';
import { tempDir } from './support/temp.ts';

const oauth = (access: string): Credential => ({
	type: 'oauth',
	access,
	refresh: 'refresh-token',
	expires: Date.now() + 3_600_000,
});

describe('fileCredentials', () => {
	it('keeps a credential for each provider, and keeps it private', async () => {
		const path = join(await tempDir('ambion-credentials-'), 'nested', 'auth.json');
		const store = fileCredentials(path);
		expect(await store.read('anthropic')).toBeUndefined();

		await store.modify('anthropic', async () => oauth('one'));
		await store.modify('openai-codex', async () => ({ type: 'api_key', key: 'k' }));
		await store.modify('anthropic', async (current) => {
			expect(current).toMatchObject({ access: 'one' });
			return undefined;
		});

		expect(await store.read('anthropic')).toMatchObject({ access: 'one' });
		expect(await store.list()).toEqual([
			{ providerId: 'anthropic', type: 'oauth' },
			{ providerId: 'openai-codex', type: 'api_key' },
		]);
		expect((await stat(path)).mode & 0o777).toBe(0o600);

		await store.delete('anthropic');
		expect(await store.read('anthropic')).toBeUndefined();
		expect(await store.read('openai-codex')).toMatchObject({ key: 'k' });
	});

	it('serializes writes of two stores on one file, so no rotated token is lost', async () => {
		const path = join(await tempDir('ambion-credentials-'), 'auth.json');
		const [a, b] = [fileCredentials(path), fileCredentials(path)];
		const rotate = (store: typeof a, id: string) =>
			store.modify(id, async (current) => oauth(`${String(current?.type)}-${id}`));
		await Promise.all(
			Array.from({ length: 20 }, (_, i) => rotate(i % 2 === 0 ? a : b, `provider-${i}`)),
		);
		expect((await a.list()).length).toBe(20);
	});

	it('takes a lock that a dead process left behind', async () => {
		const path = join(await tempDir('ambion-credentials-'), 'auth.json');
		const lock = `${path}.lock`;
		await writeFile(lock, '');
		const old = new Date(Date.now() - 120_000);
		const { utimes } = await import('node:fs/promises');
		await utimes(lock, old, old);
		const store = fileCredentials(path);
		await store.modify('anthropic', async () => oauth('after-crash'));
		expect(await store.read('anthropic')).toMatchObject({ access: 'after-crash' });
	});

	it('waits for a lock that another process holds, and writes when it ends', async () => {
		const path = join(await tempDir('ambion-credentials-'), 'auth.json');
		const lock = `${path}.lock`;
		await writeFile(lock, 'another-process');
		const store = fileCredentials(path);
		const written = store.modify('anthropic', async () => oauth('after-wait'));
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(await store.read('anthropic')).toBeUndefined();
		await rm(lock);
		await written;
		expect(await store.read('anthropic')).toMatchObject({ access: 'after-wait' });
	});

	it('stops waiting for a lock with a missing target when the sign-in is cancelled', async () => {
		const path = join(await tempDir('ambion-credentials-'), 'auth.json');
		// A lock whose target is gone still blocks exclusive creation. Cancellation must end the wait.
		await symlink(join(path, 'missing'), `${path}.lock`);
		const controller = new AbortController();
		const written = fileCredentials(path).modify('anthropic', async () => oauth('x'), {
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(new Error('cancelled')), 100);
		await expect(written).rejects.toThrow('cancelled');
	});

	it('removes only its own lock, so a lock another process took stays', async () => {
		const path = join(await tempDir('ambion-credentials-'), 'auth.json');
		const lock = `${path}.lock`;
		await fileCredentials(path).modify('anthropic', async () => {
			await writeFile(lock, 'the-new-owner');
			return oauth('slow');
		});
		expect(await readFile(lock, 'utf8')).toBe('the-new-owner');
	});

	it('leaves no temporary file when the write fails, and writes on the next call', async () => {
		const dir = await tempDir('ambion-credentials-');
		const path = join(dir, 'auth.json');
		await mkdir(path);
		const store = fileCredentials(path);
		await expect(store.modify('anthropic', async () => oauth('x'))).rejects.toThrow();
		expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
		await rm(path, { recursive: true });
		await store.modify('anthropic', async () => oauth('later'));
		expect(await store.read('anthropic')).toMatchObject({ access: 'later' });
	});

	it('refuses to overwrite a file it cannot read', async () => {
		const path = join(await tempDir('ambion-credentials-'), 'auth.json');
		await writeFile(path, '{ not json');
		const store = fileCredentials(path);
		await expect(store.modify('anthropic', async () => oauth('x'))).rejects.toThrow(
			/cannot be read/,
		);
	});
});

/** Run `request` against a local server; answer the headers of the one request it receives. */
async function headersOf(request: (baseUrl: string) => Promise<unknown>) {
	let seen: Record<string, string | string[] | undefined> = {};
	const server = createServer((req, res) => {
		seen = req.headers;
		res.writeHead(401, { 'content-type': 'application/json' });
		res.end('{"type":"error","error":{"type":"authentication_error","message":"stand-in"}}');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	onTestFinished(() => new Promise((resolve) => server.close(() => resolve(undefined))));
	await request(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	return seen;
}

const context = normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] });

/** One stream through the services, against the stand-in provider. */
async function stream(services: ReturnType<typeof createExecutionServices>, baseUrl: string) {
	const model = await services.model('anthropic/claude-sonnet-4-5', 'seat');
	const events = await services.stream({ ...model, baseUrl }, context, { maxRetries: 0 } as never);
	for await (const _event of events) {
		// The stream ends with an error event: the stand-in refuses.
	}
}

describe('a stored sign-in', () => {
	it('answers for its provider, and the store skips the key in the environment', async () => {
		vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api-from-environment');
		onTestFinished(() => void vi.unstubAllEnvs());
		const path = join(await tempDir('ambion-credentials-'), 'auth.json');
		const credentials = fileCredentials(path);
		await credentials.modify('anthropic', async () => oauth('sk-ant-oat-from-store'));

		const withStore = await headersOf((baseUrl) =>
			stream(createExecutionServices({ credentials }), baseUrl),
		);
		expect(withStore.authorization).toBe('Bearer sk-ant-oat-from-store');
		expect(withStore['x-api-key']).toBeUndefined();

		const withKey = await headersOf((baseUrl) => stream(createExecutionServices(), baseUrl));
		expect(withKey['x-api-key']).toBe('sk-ant-api-from-environment');
	});

	it('leaves the key in the environment to a provider with no stored sign-in', async () => {
		vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api-from-environment');
		onTestFinished(() => void vi.unstubAllEnvs());
		const credentials = fileCredentials(join(await tempDir('ambion-credentials-'), 'auth.json'));
		const seen = await headersOf((baseUrl) =>
			stream(createExecutionServices({ credentials }), baseUrl),
		);
		expect(seen['x-api-key']).toBe('sk-ant-api-from-environment');
	});
});

describe('terminalInteraction', () => {
	it('prints each event, and answers a prompt and a choice from the input', async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const written: string[] = [];
		output.on('data', (chunk) => written.push(String(chunk)));
		const terminal = terminalInteraction({ input, output });
		onTestFinished(() => terminal.close());

		terminal.notify({ type: 'auth_url', url: 'https://example.test/sign-in' });
		terminal.notify({ type: 'device_code', userCode: 'ABCD', verificationUri: 'https://x.test' });
		const code = terminal.prompt({ type: 'manual_code', message: 'Paste the code:' });
		await vi.waitFor(() => expect(written.join('')).toContain('Paste the code:'));
		input.write('  the-code  \n');
		expect(await code).toBe('the-code');

		const choice = terminal.prompt({
			type: 'select',
			message: 'Which?',
			options: [
				{ id: 'a', label: 'First' },
				{ id: 'b', label: 'Second' },
			],
		});
		await vi.waitFor(() => expect(written.join('')).toContain('Which?'));
		input.write('2\n');
		expect(await choice).toBe('b');

		const text = written.join('');
		expect(text).toContain('https://example.test/sign-in');
		expect(text).toContain('ABCD');
		expect(text).toContain('2. Second');
	});
});
