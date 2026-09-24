/**
 * The integration tier: the workstation against OpenSSH, with one Unix
 * account for each agent. `setup.sh` provisions the accounts and starts
 * `sshd` as root, and this tier runs only when `AMBION_WORKSTATION_SSHD`
 * names the file that `setup.sh` writes. It proves what only a real server
 * can: the rename and the group kill on OpenSSH, its status codes, the
 * channel limit, the spill file, and the permissions between accounts.
 */

import type { ToolContext } from '@ambionframework/ambion';
import { openWorkspace } from '@ambionframework/workspace';
import {
	type ConformanceBackend,
	workspaceConformance,
} from '@ambionframework/workspace/conformance';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type WorkstationOptions, workstationBackend } from '../../src/index.ts';
import { type Backend, configPath, options, WIPE, withEnv } from '../support/sshd.ts';

const ctx = BACKGROUND_CONTEXT;

const harness: ConformanceBackend = {
	name: 'workstation on OpenSSH',
	async open() {
		const backend = workstationBackend(await options());
		await withEnv(backend, 'conformance', (env) => env.exec(WIPE, undefined, ctx));
		return { backend, dispose: async () => backend.dispose?.() };
	},
};

describe.skipIf(configPath === undefined)('integration tier', () => {
	describe(harness.name, () => {
		for (const c of workspaceConformance(harness)) it(c.name, c.run);
	});

	let backend: Backend;
	let layout: WorkstationOptions['layout'];
	beforeAll(async () => {
		const resolved = await options();
		layout = resolved.layout;
		backend = workstationBackend(resolved);
		for (const agent of ['surveyor', 'planner']) {
			await withEnv(backend, agent, (env) => env.exec(WIPE, undefined, ctx));
		}
		await withEnv(backend, 'lab-host', (env) =>
			env.exec(`rm -rf -- ${layout.rooms}/*`, undefined, ctx),
		);
	});
	afterAll(async () => backend.dispose?.());

	it('classifies the status codes of OpenSSH by the kind of operation', async () => {
		await withEnv(backend, 'surveyor', async (env) => {
			await env.createDir('full', undefined, ctx);
			await env.writeFile('full/a.txt', 'x', ctx);
			expect(await env.remove('full', undefined, ctx)).toMatchObject({
				ok: false,
				error: { code: 'invalid' },
			});
			expect(await env.readTextFile('full/a.txt/x', ctx)).toMatchObject({
				ok: false,
				error: { code: 'not_directory' },
			});
			expect(await env.readTextFile('none/a.txt', ctx)).toMatchObject({
				ok: false,
				error: { code: 'not_found' },
			});
			expect(await env.renameFile('full/a.txt', 'none/b.txt', ctx)).toMatchObject({
				ok: false,
				error: { code: 'not_found' },
			});
			expect(await env.writeFile('deep/er/a.txt', 'x', ctx)).toMatchObject({ ok: true });
			expect(await env.createDir('full', { recursive: false }, ctx)).toMatchObject({
				ok: false,
				error: { code: 'invalid' },
			});
		});
	});

	it('kills the whole process group on a timeout', async () => {
		await withEnv(backend, 'surveyor', async (env) => {
			const timedOut = await env.exec(
				'sleep 30 & echo $! > child.pid; sleep 30',
				{ timeout: 0.5 },
				ctx,
			);
			expect(timedOut).toMatchObject({ ok: false, error: { code: 'timeout' } });
			// A killed child that no init reaps stays a zombie, and `kill -0` still finds it.
			const gone = await env.exec(
				'sleep 0.2; case "$(ps -o stat= -p "$(cat child.pid)")" in "" | Z*) exit 0 ;; *) exit 1 ;; esac',
				undefined,
				ctx,
			);
			expect(gone).toMatchObject({ ok: true, value: { exitCode: 0 } });
		});
	});

	it('stays under MaxSessions over many commands, timeouts, and aborts on one client', async () => {
		await withEnv(backend, 'surveyor', async (env) => {
			for (let i = 0; i < 12; i += 1) {
				expect(await env.exec('true', undefined, ctx)).toMatchObject({ ok: true });
				const timedOut = await env.exec('sleep 30', { timeout: 0.05 }, ctx);
				expect(timedOut).toMatchObject({ ok: false, error: { code: 'timeout' } });
			}
			expect(await env.exec('echo done', undefined, ctx)).toMatchObject({
				ok: true,
				value: { exitCode: 0 },
			});
		});
	});

	it('keeps one account out of another account home and temporary files', async () => {
		const temp = await withEnv(backend, 'surveyor', async (env) => {
			await env.writeFile('secret.txt', 'mine', ctx);
			const file = await env.createTempFile(undefined, ctx);
			if (!file.ok) throw new Error('no temporary file');
			await env.writeFile(file.value, 'mine', ctx);
			return file.value;
		});
		await withEnv(backend, 'planner', async (env) => {
			expect(await env.readTextFile('/home/surveyor/secret.txt', ctx)).toMatchObject({
				ok: false,
				error: { code: 'permission_denied' },
			});
			expect(await env.readTextFile(temp, ctx)).toMatchObject({
				ok: false,
				error: { code: 'permission_denied' },
			});
			const cat = await env.exec('cat /home/surveyor/secret.txt', undefined, ctx);
			expect(cat).toMatchObject({ ok: true, value: { exitCode: 1 } });
		});
	});

	it('spills a large output to a file that only its account reads', async () => {
		const spilled = await withEnv(backend, 'surveyor', async (env) => {
			const result = await env.exec(
				'seq 1 200000',
				{ capture: { limits: { maxBytes: 2_000, maxLines: 50 }, spill: true } },
				ctx,
			);
			if (!result.ok) throw result.error;
			expect(result.value.truncation).toMatchObject({ truncated: true, totalLines: 200_000 });
			const path = result.value.spillPath ?? '';
			const whole = await env.readTextFile(path, ctx);
			expect(whole.ok && whole.value.split('\n').length).toBe(200_001);
			return path;
		});
		await withEnv(backend, 'planner', async (env) => {
			expect(await env.readTextFile(spilled, ctx)).toMatchObject({
				ok: false,
				error: { code: 'permission_denied' },
			});
		});
		await withEnv(backend, 'surveyor', (env) => env.remove(spilled, undefined, ctx));
	});

	it('keeps each new file in the audit folder writable for every agent', async () => {
		const first = `${layout.audit}.first`;
		const rotated = `${layout.audit}.rotated`;
		await withEnv(backend, 'surveyor', (env) => env.writeFile(first, 'a\n', ctx));
		await withEnv(backend, 'planner', async (env) => {
			expect(await env.appendFile(first, 'b\n', ctx)).toMatchObject({ ok: true });
			expect(await env.renameFile(first, rotated, ctx)).toMatchObject({ ok: true });
			expect(await env.writeFile(first, 'c\n', ctx)).toMatchObject({ ok: true });
		});
		await withEnv(backend, 'surveyor', async (env) => {
			expect(await env.appendFile(first, 'd\n', ctx)).toMatchObject({ ok: true });
			expect(await env.readTextFile(rotated, ctx)).toMatchObject({ ok: true, value: 'a\nb\n' });
			await env.remove(first, undefined, ctx);
			await env.remove(rotated, undefined, ctx);
		});
	});

	it('lets the host account write the rooms folder, and no agent', async () => {
		const path = `${layout.rooms}/lobby.jsonl`;
		await withEnv(backend, 'surveyor', async (env) => {
			expect(await env.writeFile(`${layout.rooms}/x.txt`, 'x', ctx)).toMatchObject({
				ok: false,
				error: { code: 'permission_denied' },
			});
		});
		await withEnv(backend, 'lab-host', (env) => env.writeFile(path, 'entry\n', ctx));
		await withEnv(backend, 'planner', async (env) => {
			expect(await env.readTextFile(path, ctx)).toMatchObject({ ok: true, value: 'entry\n' });
			expect(await env.appendFile(path, 'forged\n', ctx)).toMatchObject({
				ok: false,
				error: { code: 'permission_denied' },
			});
		});
	});
});

const context = (agent: string): ToolContext => ({
	agent: { name: agent, identity: agent },
	callId: 'call-1',
	room: 'lobby',
});

describe.skipIf(configPath === undefined)('a workspace on OpenSSH', () => {
	it('audits two agents into one log, each as its own account', async () => {
		const resolved = await options();
		const bashBackend = workstationBackend(resolved);
		const workspace = openWorkspace({
			name: 'lab',
			backend: { bash: bashBackend, sql: sqliteBackend(':memory:') },
			audit: {},
		});
		try {
			const bash = workspace.tools().tools.find((tool) => tool.name === 'bash');
			if (bash === undefined) throw new Error('No bash tool.');
			const surveyor = await bash.invoke({ command: 'id -un' }, context('surveyor'));
			const planner = await bash.invoke({ command: 'id -un' }, context('planner'));
			expect(JSON.stringify(surveyor)).toContain('surveyor');
			expect(JSON.stringify(planner)).toContain('planner');
			const audit = await withEnv(bashBackend, 'surveyor', (env) =>
				env.readTextFile(resolved.layout.audit, ctx),
			);
			if (!audit.ok) throw audit.error;
			const agents = audit.value
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line).agent);
			expect(agents.slice(-2)).toEqual(['surveyor', 'planner']);
		} finally {
			await workspace.dispose();
		}
	});
});
