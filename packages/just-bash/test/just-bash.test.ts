/**
 * The just-bash adapter beyond the conformance suite: path queries, the
 * working directory of one command, temporary names, the default timeout,
 * the scripting commands, git, the memory limit, the shared homes, and a
 * change that a host makes while a script ends. Then the memory backend's
 * seed function and `readFiles`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT, DEFAULT_TIMEOUT_SECONDS } from '@ambionframework/workspace';
import { Bash, InMemoryFs } from 'just-bash';
import { describe, expect, it, onTestFinished } from 'vitest';
import { BashEnv } from '../src/bash-env.ts';
import { directoryBackend, MEMORY_LIMIT_BYTES, memoryBackend } from '../src/just-bash.ts';
import { backends, sh, tempDir } from './support/backends.ts';

const ctx = BACKGROUND_CONTEXT;

describe('the just-bash adapter', () => {
	const connect = (agentName = 'alpha') => memoryBackend().connect({ name: agentName });
	const codeOf = (result: { ok: boolean; error?: { code: string } }) =>
		result.ok ? 'ok' : result.error?.code;

	it('answers path queries beyond the conformance suite', async () => {
		const alpha = await connect();
		await alpha.writeFile('f.txt', 'x', ctx);
		// canonicalPath maps a missing path as readTextFile does; Pi's write and
		// edit tools read that mapping to decide whether a path is a new file.
		expect(codeOf(await alpha.canonicalPath('missing', ctx))).toBe('not_found');
		// createDir with no recursive flag, and remove on the root of the env, answer invalid.
		expect(codeOf(await alpha.createDir('f.txt', { recursive: false }, ctx))).toBe('invalid');
		expect(codeOf(await alpha.remove('.', undefined, ctx))).toBe('invalid');
		// A path that never existed answers false, with no remove call before.
		expect(await alpha.exists('missing', ctx)).toEqual({ ok: true, value: false });
		expect(await alpha.absolutePath('sub/../y', ctx)).toEqual({
			ok: true,
			value: `${alpha.cwd}/y`,
		});
	});

	it('scopes cwd to one exec call, keeps no cd across calls, and joins stderr into the same output', async () => {
		const alpha = await connect();
		const combined = await sh(alpha, 'mkdir -p sub && cd sub && pwd && echo warn >&2');
		expect(combined).toMatchObject({ ok: true, exitCode: 0, output: '/home/alpha/sub\nwarn\n' });
		expect(await sh(alpha, 'pwd')).toMatchObject({ ok: true, output: '/home/alpha\n' });
		expect(await sh(alpha, 'pwd', { cwd: 'sub' })).toMatchObject({
			ok: true,
			output: '/home/alpha/sub\n',
		});
	});

	it('honors a temp file prefix and suffix, appends, lists each entry sized, reads lines, and renames', async () => {
		const alpha = await connect();
		const file = await alpha.createTempFile({ prefix: 'bash-', suffix: '.journal' }, ctx);
		if (!file.ok) throw file.error;
		expect(file.value).toMatch(/^\/tmp\/bash-[0-9a-f]+\.journal$/);
		await alpha.appendFile(file.value, 'a', ctx);
		await alpha.appendFile(file.value, 'b', ctx);
		expect(await alpha.readTextFile(file.value, ctx)).toEqual({ ok: true, value: 'ab' });

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

	it('gives a command that names no timeout the default, and stops it there', async () => {
		expect(DEFAULT_TIMEOUT_SECONDS).toBe(30);
		const short = new BashEnv(new Bash({ fs: new InMemoryFs(), cwd: '/' }), '/', { timeout: 0.05 });
		expect(await sh(short, 'sleep 5')).toMatchObject({ ok: false, code: 'timeout' });
		expect(await sh(short, 'echo quick')).toMatchObject({ ok: true, output: 'quick\n' });
		// A caller's own timeout wins over the default.
		expect(await sh(short, 'sleep 0.1; echo late', { timeout: 1 })).toMatchObject({
			ok: true,
			output: 'late\n',
		});
	});

	it('runs js-exec and python3, and has no curl', async () => {
		const alpha = await connect();
		expect(await sh(alpha, 'js-exec -c "console.log(1 + 2)"')).toEqual({
			ok: true,
			exitCode: 0,
			output: '3\n',
		});
		expect(await sh(alpha, 'python3 -c "print(1 + 2)"')).toEqual({
			ok: true,
			exitCode: 0,
			output: '3\n',
		});
		expect(await sh(alpha, 'curl --version')).toEqual({
			ok: true,
			exitCode: 127,
			output: 'bash: curl: command not found\n',
		});
	});

	it.each(backends)(
		'runs git on $name with the agent as the locked author, clones across homes, and has no git network',
		async (harness) => {
			const { backend, dispose } = await harness.open();
			onTestFinished(dispose);
			const alpha = await backend.connect({ name: 'alpha' });
			const beta = await backend.connect({ name: 'beta' });
			const init =
				'git init repo && cd repo && echo hi > a.txt && git add . && git commit -m first';
			expect(await sh(alpha, init)).toMatchObject({ ok: true, exitCode: 0 });
			// A config write succeeds, and the locked identity still wins.
			expect(
				await sh(alpha, 'cd repo && git config user.name other && git log -1 --format="%an <%ae>"'),
			).toMatchObject({ ok: true, output: 'alpha <alpha@ambion.invalid>\n' });
			const push =
				'git clone /home/alpha/repo r && cd r && echo b > b && git add b && git commit -m second && git push origin HEAD:side';
			expect(await sh(beta, push)).toMatchObject({ ok: true, exitCode: 0 });
			expect(await sh(alpha, 'cd repo && git log side --format="%an %s"')).toMatchObject({
				ok: true,
				output: 'beta second\nalpha first\n',
			});
			expect(await sh(alpha, 'git clone https://github.com/example/repo x')).toMatchObject({
				ok: true,
				exitCode: 128,
				output: 'fatal: network access is disabled\n',
			});
			expect(backend.guidance).toContain('git is available');
		},
	);

	it('holds 128 MB in memory, and refuses the write that goes past it', async () => {
		expect(MEMORY_LIMIT_BYTES).toBe(128 * 1024 * 1024);
		const alpha = await connect();
		const half = new Uint8Array(MEMORY_LIMIT_BYTES / 2);
		expect(await alpha.writeFile('first', half, ctx)).toEqual({ ok: true, value: undefined });
		// The second half does not fit beside the layout `Bash` seeds into a fresh filesystem.
		const over = await alpha.writeFile('second', half, ctx);
		expect(!over.ok && over.error.message).toMatch(/ENOSPC/);
		await alpha.remove('first', undefined, ctx);
		expect(await alpha.writeFile('second', half, ctx)).toEqual({ ok: true, value: undefined });
	});

	it('recreates a home removed out from under it, and shares files across agents', async () => {
		const backend = memoryBackend();
		const alpha = await backend.connect({ name: 'alpha' });
		await alpha.writeFile('shared.txt', 'from alpha', ctx);
		const beta = await backend.connect({ name: 'beta' });
		expect(await beta.readTextFile('/home/alpha/shared.txt', ctx)).toEqual({
			ok: true,
			value: 'from alpha',
		});
		await beta.remove('/home/alpha', { recursive: true }, ctx);
		const again = await backend.connect({ name: 'alpha' });
		expect(await again.exists('.', ctx)).toEqual({ ok: true, value: true });
		expect(await sh(again, 'ls ~')).toMatchObject({ ok: true, output: '' });
	});

	it('ends a change that the host asks for while the last change of a script runs', async () => {
		const { dir, dispose } = await tempDir('ambion-drive-');
		onTestFinished(dispose);
		const backend = directoryBackend(dir);
		const alpha = await backend.connect({ name: 'alpha' });
		await sh(alpha, 'mkdir src && for i in $(seq 1 300); do echo $i > src/f$i; done');
		// `cp -r` is one change for the whole copy, and it is the last command of the script.
		const copy = sh(alpha, 'cp -r src dst');
		while (!existsSync(join(dir, 'home', 'alpha', 'dst'))) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		// The `mkdir -p` of the home in `connect` waits for the copy, then starts after it.
		const settles = (work: Promise<unknown>) =>
			Promise.race([
				work.then(() => 'settled'),
				new Promise((resolve) => setTimeout(() => resolve('pending'), 2_000)),
			]);
		expect(await settles(backend.connect({ name: 'beta' }))).toBe('settled');
		expect(await copy).toMatchObject({ ok: true, exitCode: 0 });
		expect(await settles(alpha.writeFile('after.txt', 'x', ctx))).toBe('settled');
	});
});

// -- memoryBackend seeding and reading ---------------------------------------

describe('memoryBackend', () => {
	it('runs a seed function once, lazily, reads what it wrote back without an agent, and skips a symlink', async () => {
		let calls = 0;
		const backend = memoryBackend({
			seed: async (write) => {
				calls++;
				await write.writeFile('/site/README.md', 'start here\n');
			},
		});
		expect(calls).toBe(0); // nothing runs until something asks for the filesystem
		expect(await backend.readFiles()).toEqual([{ path: '/site/README.md', text: 'start here\n' }]);
		const alpha = await backend.connect({ name: 'alpha' });
		await alpha.writeFile('/site/notes.md', 'a note\n', ctx);
		await alpha.exec('ln -s /site ~/sitelink && ln -s /nowhere ~/dangling', undefined, ctx);
		expect(calls).toBe(1); // connect reused the filesystem readFiles already built
		// The first `connect` also lays the just-bash binaries into the shared
		// filesystem (`docs/workspace.md` §8), so the two site files are among others.
		const after = await backend.readFiles();
		expect(after).toContainEqual({ path: '/site/README.md', text: 'start here\n' });
		expect(after).toContainEqual({ path: '/site/notes.md', text: 'a note\n' });
		const paths = after.map((f) => f.path);
		expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
		expect(paths.some((path) => path.includes('sitelink') || path.includes('dangling'))).toBe(
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
});
