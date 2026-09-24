/**
 * A workstation with a git backend: each account's real `git` reaches
 * `gitBackend` over HTTP with the credentials that `~/.git-credentials`
 * holds. The git conformance cases run here, and the file has mode `0600`,
 * `git` leaves it unchanged, a removed line comes back at the next
 * `connect`, the owner pushes its fork, and a peer cannot.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBackend, type JustGitBackend, sqliteGitStorage } from '@ambionframework/git';
import { openWorkspace, type Workspace } from '@ambionframework/workspace';
import { type GitConformanceBackend, gitConformance } from '@ambionframework/workspace/conformance';
import { BACKGROUND_CONTEXT, type ShellOutputUpdate } from '@earendil-works/pi-agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { workstationBackend } from '../src/index.ts';
import { startSshServer } from './support/server.ts';
import { hasSetsid } from './support/setsid.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ANALYST = { name: 'analyst' };
const REVIEWER = { name: 'reviewer' };

async function sh(workspace: Workspace, agent: { name: string }, command: string) {
	let output = '';
	const ran = await workspace.use(agent, (env) =>
		env.exec(
			command,
			{
				timeout: 60,
				capture: { limits: { maxBytes: 100_000, maxLines: 1000 } },
				onUpdate: (update: ShellOutputUpdate) => {
					if (update.kind === 'replace') output = update.output.text;
				},
			},
			BACKGROUND_CONTEXT,
		),
	);
	if (!ran.ok) throw ran.error;
	return { code: ran.value.exitCode, output };
}

async function lab() {
	const dir = await mkdtemp(join(tmpdir(), 'ambion-ws-git-'));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const http = createServer();
	const port = await new Promise<number>((resolve) =>
		http.listen(0, '127.0.0.1', () => resolve((http.address() as AddressInfo).port)),
	);
	cleanups.push(() => new Promise((resolve) => http.close(resolve)));
	const git = gitBackend({
		storage: sqliteGitStorage(join(dir, 'git.db')),
		secret: 'workstation-secret',
		url: `http://127.0.0.1:${port}`,
		templates: { blank: { source: { 'README.md': 'blank\n' } } },
	});
	http.on('request', git.handler);
	const server = await startSshServer(['analyst', 'reviewer', 'lab-host']);
	cleanups.push(() => server.stop());
	const workspace = openWorkspace({
		name: 'lab',
		backend: { bash: workstationBackend(server.options), git },
	});
	cleanups.push(() => workspace.dispose());
	return { workspace, homes: server.homes };
}

/** Each store: a scripted SSH server, and an HTTP server for the git backend that the store opens last. */
const harness: GitConformanceBackend = {
	name: 'workstation',
	shortestTokenTtl: 1,
	async open() {
		const dir = await mkdtemp(join(tmpdir(), 'ambion-ws-git-conformance-'));
		const http = createServer();
		const port = await new Promise<number>((resolve) =>
			http.listen(0, '127.0.0.1', () => resolve((http.address() as AddressInfo).port)),
		);
		let current: JustGitBackend | undefined;
		http.on('request', (request, response) => current?.handler(request, response));
		const server = await startSshServer(['analyst', 'reviewer']);
		return {
			bash: workstationBackend(server.options),
			backend: (options) => {
				current = gitBackend({
					storage: sqliteGitStorage(join(dir, 'git.db')),
					secret: 'workstation-conformance',
					url: `http://127.0.0.1:${port}`,
					...(options.tokenTtl === undefined ? {} : { tokenTtl: options.tokenTtl }),
					templates: Object.fromEntries(
						Object.entries(options.templates).map(([name, template]) => [
							name,
							{
								source: template.files,
								...(template.description === undefined
									? {}
									: { description: template.description }),
							},
						]),
					),
				});
				return current;
			},
			dispose: async () => {
				await server.stop();
				await new Promise((resolve) => http.close(resolve));
				await rm(dir, { recursive: true, force: true });
			},
		};
	},
};

describe.skipIf(!hasSetsid)('the git conformance cases on a workstation', () => {
	for (const c of gitConformance(harness)) it(c.name, c.run);
});

describe.skipIf(!hasSetsid)('a workstation with a git backend', () => {
	it('writes the credential file with mode 0600, and the owner clones and pushes its fork', async () => {
		const { workspace, homes } = await lab();
		const forked = await workspace.git?.use(ANALYST, (env) => env.fork('templates/blank', 'work'));
		if (!forked?.ok) throw new Error('the fork was refused');
		const pushed = await sh(
			workspace,
			ANALYST,
			`git clone ${forked.repository.url} work && cd work && git -c user.name=analyst -c user.email=a@x commit --allow-empty -m pushed && git push origin main`,
		);
		expect(pushed.code, pushed.output).toBe(0);
		const home = homes.get('analyst') ?? '';
		const file = join(home, '.git-credentials');
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const lines = (await readFile(file, 'utf8')).trim().split('\n');
		expect(lines).toHaveLength(2);
		for (const line of lines)
			expect(line).toMatch(/^http:\/\/ambion:[^@]+@127\.0\.0\.1:\d+\/[a-z-]+\/[a-z]+$/);
		expect(
			lines.some((line) => /^http:\/\/ambion:[^@]+@127\.0\.0\.1:\d+\/analyst\/work$/.test(line)),
		).toBe(true);
		const after = await workspace.git?.use(ANALYST, (env) => env.get('analyst/work'));
		expect(after?.branches.main).not.toBe(forked.repository.branches.main);
	});

	it('keeps the file across git requests, and writes a removed line again at the next connect', async () => {
		const { workspace, homes } = await lab();
		const url = (await workspace.git?.use(ANALYST, (env) => env.get('templates/blank')))?.url;
		const clone = await sh(workspace, ANALYST, `git clone ${url} blank && cd blank && git fetch`);
		expect(clone.code, clone.output).toBe(0);
		const file = join(homes.get('analyst') ?? '', '.git-credentials');
		const written = await readFile(file, 'utf8');
		await sh(workspace, ANALYST, 'true');
		expect(await readFile(file, 'utf8')).toBe(written);
		await writeFile(file, '');
		await sh(workspace, ANALYST, 'true');
		expect(await readFile(file, 'utf8')).toBe(written);
	});

	it("refuses a peer's push to another account's fork", async () => {
		const { workspace } = await lab();
		const forked = await workspace.git?.use(ANALYST, (env) => env.fork('templates/blank', 'mine'));
		if (!forked?.ok) throw new Error('the fork was refused');
		const clone = await sh(workspace, REVIEWER, `git clone ${forked.repository.url} theirs`);
		expect(clone.code, clone.output).toBe(0);
		const pushed = await sh(
			workspace,
			REVIEWER,
			'cd theirs && git -c user.name=reviewer -c user.email=r@x commit --allow-empty -m nope && git push origin main',
		);
		expect(pushed.code).not.toBe(0);
	});
});
