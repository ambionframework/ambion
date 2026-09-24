/**
 * The agent keys of `workstationGitBackend` on the scripted tier: the
 * generator that retries a pair `ssh2` cannot read, the identity that
 * `identityFor` gives, and the lines of `authorized_keys.ambion`. The test
 * server does not read the key file. The OpenSSH tier proves what `sshd`
 * does with each line.
 */

import { spawnSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { describe, expect, it } from 'vitest';
import { ed25519Pair } from '../src/git-keys.ts';
import { fingerprint } from '../src/index.ts';
import { gitBackend, gitServer, hasGitTools } from './support/git.ts';

const { utils } = ssh2;

const ANALYST = { name: 'analyst' };

/** The lines of the key file of the account in `home`. */
async function keyLines(home: string): Promise<string[]> {
	const text = await readFile(join(home, '.ssh', 'authorized_keys.ambion'), 'utf8');
	return text.split('\n').filter((line) => line !== '');
}

/** The public key of an OpenSSH private key, as a key line holds it. */
function publicOf(privateKey: string): string {
	const key = utils.parseKey(privateKey);
	if (key instanceof Error || Array.isArray(key)) throw new Error('The key does not parse.');
	return `${key.type} ${key.getPublicSSH().toString('base64')}`;
}

/** The local time of `seconds` as `expiry-time` holds it. The test server runs on this machine. */
function stampOf(seconds: number): string {
	return spawnSync('date', ['-d', `@${seconds}`, '+%Y%m%d%H%M%S'], {
		encoding: 'utf8',
	}).stdout.trim();
}

describe('ed25519Pair', () => {
	const unreadable = { private: 'not a key', public: 'ssh-ed25519 AAAA' };

	it('generates again until ssh2 reads both halves', () => {
		const calls: string[] = [];
		const pair = ed25519Pair(() => {
			calls.push('generate');
			return calls.length === 1 ? unreadable : utils.generateKeyPairSync('ed25519');
		});
		expect(calls).toHaveLength(2);
		expect(publicOf(pair.private)).toBe(pair.public);
	});

	it('gives up after 64 pairs that ssh2 cannot read', () => {
		expect(() => ed25519Pair(() => unreadable)).toThrow(/64 Ed25519 key pairs/);
	});
});

describe.skipIf(!hasGitTools)('the agent keys', () => {
	it('issues a key with one line, and gives the same key while it is outside its margin', async () => {
		const { home, options } = await gitServer();
		const backend = gitBackend(options);
		const before = Date.now();
		const identity = await backend.access.identityFor(ANALYST);

		expect(identity).toMatchObject({ alias: 'ambion-git', port: options.port, user: 'lab-git' });
		const [type, blob] = identity.hostKey.split(' ');
		expect(type).toBe('ssh-ed25519');
		expect(fingerprint(Buffer.from(blob ?? '', 'base64'))).toBe(options.hostKey);
		expect(identity.expiresAt).toBeGreaterThan(before + 3_598_000);
		expect(identity.expiresAt).toBeLessThanOrEqual(Date.now() + 3_601_000);
		expect(identity.expiresAt % 1000).toBe(0);
		expect(await stat(join(home, '.ambion', 'serve'))).toBeDefined();
		expect((await stat(join(home, '.ssh', 'authorized_keys.ambion'))).mode & 0o777).toBe(0o600);
		expect(await keyLines(home)).toEqual([
			`restrict,from="127.0.0.1,::1",expiry-time="${stampOf(identity.expiresAt / 1000 - 1)}",command="${home}/.ambion/serve analyst" ${publicOf(identity.privateKey)} ambion:analyst`,
		]);

		const again = await Promise.all([
			backend.access.identityFor(ANALYST),
			backend.access.identityFor(ANALYST),
		]);
		expect(again.map((held) => held.privateKey)).toEqual([
			identity.privateKey,
			identity.privateKey,
		]);
		expect(await keyLines(home)).toHaveLength(1);
	});

	it('issues a new key inside the margin, and keeps the old line until its expiry', async () => {
		const { home, options } = await gitServer();
		// A life of 4 seconds has a margin of 2 seconds. The old line stays for 1.9 seconds more.
		const backend = gitBackend({ ...options, keyTtl: 4 });
		const first = await backend.access.identityFor(ANALYST);
		await new Promise((resolve) => setTimeout(resolve, first.expiresAt - Date.now() - 1_900));
		const second = await backend.access.identityFor(ANALYST);

		expect(second.privateKey).not.toBe(first.privateKey);
		expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
		const lines = await keyLines(home);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(publicOf(first.privateKey));
		expect(lines[1]).toContain(publicOf(second.privateKey));
	});

	it('keeps every line when two host processes write at once', async () => {
		const { home, options } = await gitServer();
		const hosts = [gitBackend(options), gitBackend(options)];
		const agents = ['analyst', 'reviewer', 'writer', 'editor', 'lab-host'];
		const identities = await Promise.all(
			hosts.flatMap((host) => agents.map((name) => host.access.identityFor({ name }))),
		);
		const lines = await keyLines(home);
		expect(lines).toHaveLength(10);
		for (const identity of identities) {
			expect(lines.filter((line) => line.includes(publicOf(identity.privateKey)))).toHaveLength(1);
		}
	});

	it('drops the expired lines at each write, and keeps the others', async () => {
		const { home, options } = await gitServer();
		const backend = gitBackend(options);
		await backend.connect(ANALYST);
		const expired = 'restrict,expiry-time="20000101000000" ssh-ed25519 AAAAexpired ambion:old';
		const live = 'restrict,expiry-time="29991231235959" ssh-ed25519 AAAAlive ambion:other';
		const plain = 'restrict ssh-ed25519 AAAAplain operator';
		await writeFile(join(home, '.ssh', 'authorized_keys.ambion'), `${expired}\n${live}\n${plain}`, {
			mode: 0o600,
		});
		const identity = await backend.access.identityFor(ANALYST);
		const lines = await keyLines(home);
		expect(lines.slice(0, 2)).toEqual([live, plain]);
		expect(lines[2]).toContain(publicOf(identity.privateKey));
		expect(lines).toHaveLength(3);
	});

	it('refuses a key for a reserved name', async () => {
		const { home, options } = await gitServer();
		const backend = gitBackend(options);
		for (const name of ['templates', 'template-sources']) {
			await expect(backend.access.identityFor({ name })).rejects.toThrow(`'${name}' is reserved`);
		}
		await expect(stat(join(home, '.ssh', 'authorized_keys.ambion'))).rejects.toThrow();
	});
});
