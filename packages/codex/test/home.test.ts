/**
 * The Codex home of a seat: where it lives, which login it links, and what
 * the binary runs with. Real files in temporary directories. No key, no
 * network, no `codex` process.
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { openHome, rolloutOf, seatHome } from '../src/home.ts';

const root = mkdtempSync(join(tmpdir(), 'ambion-codex-home-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

let counter = 0;

/** A fresh directory under the root. */
function fresh(): string {
	counter += 1;
	const path = join(root, `case-${counter}`);
	mkdirSync(path);
	return path;
}

/** A host user: a home directory with a `.codex/auth.json` that holds `text`. */
function host(text = '{"OPENAI_API_KEY":"sk-host"}'): { home: string; login: string } {
	const home = fresh();
	mkdirSync(join(home, '.codex'));
	const login = join(home, '.codex', 'auth.json');
	writeFileSync(login, text);
	return { home, login };
}

describe('seatHome', () => {
	it.each([
		[
			'the HOME of the env',
			{ HOME: '/users/ada' },
			'/users/ada/.ambion/codex',
			'/users/ada/.codex/auth.json',
		],
		[
			'the user home directory without HOME',
			{},
			join(homedir(), '.ambion/codex'),
			join(homedir(), '.codex/auth.json'),
		],
		[
			'the user home directory with an empty HOME',
			{ HOME: '' },
			join(homedir(), '.ambion/codex'),
			join(homedir(), '.codex/auth.json'),
		],
	])('places the home and the login by %s', (_name, env, path, login) => {
		expect(seatHome({ env })).toMatchObject({ path, login });
	});

	it('takes the home and the login the caller names, as absolute paths', () => {
		const given = seatHome({
			env: { HOME: '/users/ada' },
			home: 'seats/one',
			login: 'keys/auth.json',
		});
		expect(given.path).toBe(resolve('seats/one'));
		expect(given.login).toBe(resolve('keys/auth.json'));
		expect(seatHome({ env: { HOME: '/users/ada' }, login: false }).login).toBeUndefined();
	});

	it('follows the CODEX_HOME of the host process for the login, and never passes it on', () => {
		vi.stubEnv('CODEX_HOME', '/elsewhere/codex');
		vi.stubEnv('HOME', '/users/ada');
		const home = seatHome({});
		expect(home.login).toBe('/elsewhere/codex/auth.json');
		expect(home.path).toBe('/users/ada/.ambion/codex');
		expect(home.env.CODEX_HOME).toBe('/users/ada/.ambion/codex');
		expect(home.env.HOME).toBe('/users/ada/.ambion/codex/home');
	});

	it('reads the HOME and the CODEX_HOME of an explicit env as the host, and the binary never gets them', () => {
		const env = { HOME: '/users/ada', CODEX_HOME: '/elsewhere/codex' };
		const home = seatHome({ env });
		expect(home.login).toBe('/elsewhere/codex/auth.json');
		expect(home.path).toBe('/users/ada/.ambion/codex');
		expect(home.env).toMatchObject({
			HOME: '/users/ada/.ambion/codex/home',
			USERPROFILE: '/users/ada/.ambion/codex/home',
			CODEX_HOME: '/users/ada/.ambion/codex',
		});
		expect(seatHome({ env, login: '/keys/auth.json' }).login).toBe('/keys/auth.json');
		expect(seatHome({ env, login: false }).login).toBeUndefined();
	});

	it('reads the HOME of this process for the defaults when env has none', () => {
		vi.stubEnv('HOME', '/users/ada');
		expect(seatHome({ env: { CODEX_API_KEY: 'k' } })).toMatchObject({
			path: '/users/ada/.ambion/codex',
			login: '/users/ada/.codex/auth.json',
		});
		expect(seatHome({ env: { HOME: undefined } }).path).toBe(join(homedir(), '.ambion/codex'));
	});

	it('sets the seat variables to the Codex home and its private home directory', () => {
		const home = seatHome({ home: '/seats/one', env: {} });
		expect(home.privateHome).toBe('/seats/one/home');
		expect(home.env).toMatchObject({
			CODEX_HOME: '/seats/one',
			HOME: '/seats/one/home',
			USERPROFILE: '/seats/one/home',
		});
	});

	it.each([
		['PATH', true],
		['https_proxy', true],
		['ALL_PROXY', true],
		['NODE_EXTRA_CA_CERTS', true],
		['LANG', true],
		['LC_ALL', true],
		['CODEX_API_KEY', true],
		['OPENAI_API_KEY', true],
		['OPENAI_BASE_URL', true],
		['SHELL', false],
		['TERM', false],
		['AWS_SECRET_ACCESS_KEY', false],
		['GITHUB_TOKEN', false],
		['ANTHROPIC_API_KEY', false],
		['SSH_AUTH_SOCK', false],
		['NPM_TOKEN', false],
	])('lets the process variable %s reach the binary: %s', (name, reaches) => {
		vi.stubEnv(name, 'value-of-the-host');
		const env = seatHome({ home: '/seats', env: {} }).env;
		expect(env[name]).toBe(reaches ? 'value-of-the-host' : undefined);
	});

	it('lays the env over the allowlisted variables: it adds, replaces, and removes', () => {
		vi.stubEnv('PATH', '/host/bin');
		vi.stubEnv('LANG', 'C');
		vi.stubEnv('TMPDIR', '/host/tmp');
		const { env } = seatHome({
			home: '/seats',
			env: {
				PATH: '/own/bin',
				LANG: undefined,
				CODEX_API_KEY: 'k',
				AZURE_KEY: 'a',
				GONE: undefined,
			},
		});
		expect(env).toMatchObject({
			PATH: '/own/bin',
			CODEX_API_KEY: 'k',
			AZURE_KEY: 'a',
			TMPDIR: '/host/tmp',
		});
		expect(Object.keys(env)).not.toContain('LANG');
		expect(Object.keys(env)).not.toContain('GONE');
	});

	it('gives the seat variables the last word over the env', () => {
		const { env } = seatHome({
			home: '/seats',
			env: { HOME: '/users/ada', USERPROFILE: '/users/ada', CODEX_HOME: '/elsewhere' },
		});
		expect(env).toMatchObject({
			HOME: '/seats/home',
			USERPROFILE: '/seats/home',
			CODEX_HOME: '/seats',
		});
	});
});

describe('openHome', () => {
	it('creates the home with its parents, and links the login as a symbolic link to the host file', async () => {
		const { login } = host();
		const home = join(fresh(), 'deep', 'seats');
		await openHome(seatHome({ home, login, env: {} }));

		const link = join(home, 'auth.json');
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		if (process.platform !== 'win32') {
			expect(lstatSync(home).mode & 0o777).toBe(0o700);
			expect(lstatSync(join(home, 'home')).mode & 0o777).toBe(0o700);
		}
		expect(readlinkSync(link)).toBe(login);
		expect(realpathSync(link)).toBe(realpathSync(login));
	});

	it('shares the file: a write through the link, in place as Codex writes, changes the host file', async () => {
		const { login } = host();
		const home = join(fresh(), 'seats');
		await openHome(seatHome({ home, login, env: {} }));

		writeFileSync(join(home, 'auth.json'), '{"refreshed":true}');
		expect(readFileSync(login, 'utf8')).toBe('{"refreshed":true}');
		expect(lstatSync(join(home, 'auth.json')).isSymbolicLink()).toBe(true);
	});

	it('finds the login of the host by the default, in the HOME of the env', async () => {
		const user = host();
		const home = join(fresh(), 'seats');
		await openHome(seatHome({ home, env: { HOME: user.home } }));
		expect(realpathSync(join(home, 'auth.json'))).toBe(realpathSync(user.login));
	});

	it('links once for several activations at once, and again without change', async () => {
		const { login } = host();
		const home = join(fresh(), 'seats');
		const seat = seatHome({ home, login, env: {} });
		await Promise.all(Array.from({ length: 12 }, () => openHome(seat)));
		await openHome(seat);
		expect(readlinkSync(join(home, 'auth.json'))).toBe(login);
	});

	it.each([
		['a file', (path: string) => writeFileSync(path, 'own login')],
		['a link', (path: string) => symlinkSync('/nowhere/at/all', path)],
	])('leaves an auth.json that is %s in the home as it was', async (_name, make) => {
		const { login } = host();
		const home = fresh();
		const path = join(home, 'auth.json');
		make(path);
		const before = lstatSync(path);
		await openHome(seatHome({ home, login, env: {} }));
		expect(lstatSync(path).ino).toBe(before.ino);
		expect(lstatSync(path).isSymbolicLink()).toBe(before.isSymbolicLink());
		expect(readFileSync(login, 'utf8')).toContain('sk-host');
	});

	it.each([
		[
			'login is false',
			(user: { home: string }) => ({ login: false as const, env: { HOME: user.home } }),
		],
		['the host has no login file', () => ({ login: join(fresh(), 'absent.json'), env: {} })],
	])('links nothing when %s, and still creates the home', async (_name, options) => {
		const home = join(fresh(), 'seats');
		await openHome(seatHome({ home, ...options(host()) }));
		expect(existsSync(home)).toBe(true);
		expect(() => lstatSync(join(home, 'auth.json'))).toThrow();
	});

	it.skipIf(process.platform !== 'linux' || !existsSync('/proc/self'))(
		'fails as permanent when no link can be made, and names both paths and the fix',
		async () => {
			const { login } = host();
			// /proc/self accepts no new entry, so a symbolic link and a hard link both fail.
			const failure = await openHome(seatHome({ home: '/proc/self', login, env: {} })).catch(
				(error: Error) => error,
			);
			expect(failure).toMatchObject({ name: 'PermanentError' });
			expect((failure as Error).message).toContain('/proc/self/auth.json');
			expect((failure as Error).message).toContain(login);
			expect((failure as Error).message).toMatch(
				/CODEX_HOME=\/proc\/self codex login.*login: false/,
			);
		},
	);
});

describe('rolloutOf', () => {
	/** A rollout file of `thread` under the day `YYYY/MM/DD` of a home. */
	function rollout(home: string, day: string, thread: string): string {
		const dir = join(home, 'sessions', ...day.split('/'));
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `rollout-${day.replaceAll('/', '-')}T10-00-00-${thread}.jsonl`);
		writeFileSync(path, '');
		return path;
	}

	it('finds the file of a thread by its id, in the newest day first', () => {
		const home = fresh();
		const old = rollout(home, '2026/01/31', 'aaaa-1');
		const recent = rollout(home, '2026/10/01', 'bbbb-2');
		return Promise.all([
			expect(rolloutOf(home, 'aaaa-1')).resolves.toBe(old),
			expect(rolloutOf(home, 'bbbb-2')).resolves.toBe(recent),
			expect(rolloutOf(home, 'aaaa')).resolves.toBeUndefined(),
		]);
	});

	it('answers nothing for a home with no sessions, and for a thread past the newest days', async () => {
		expect(await rolloutOf(fresh(), 'aaaa-1')).toBeUndefined();
		const home = fresh();
		rollout(home, '2025/01/01', 'gone-3');
		for (let day = 1; day <= 31; day += 1) {
			rollout(home, `2026/03/${String(day).padStart(2, '0')}`, `other-${day}`);
		}
		rollout(home, '2026/04/01', 'other-32');
		expect(await rolloutOf(home, 'gone-3')).toBeUndefined();
	});
});
