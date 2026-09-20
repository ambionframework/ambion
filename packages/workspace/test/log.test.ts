import { posix } from 'node:path';
import type { ExecutionEnv } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import type { WorkspaceAgent } from '../src/index.ts';
import { BACKGROUND_CONTEXT, openLog } from '../src/index.ts';
import { backends } from './support/backends.ts';

const host: WorkspaceAgent = { name: 'host', identity: 'Writes the record.' };

/** Every line of one file, parsed as JSON. An unreadable file has no lines. */
async function linesOf(env: ExecutionEnv, path: string): Promise<unknown[]> {
	const read = await env.readTextFile(path, BACKGROUND_CONTEXT);
	if (!read.ok) return [];
	return read.value
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line) as unknown);
}

/** Every record across `path` and whatever it has rotated to, in no particular file order. */
async function allRecords(env: ExecutionEnv, path: string): Promise<{ i: number }[]> {
	const dir = posix.dirname(path);
	const listed = await env.listDir(dir, BACKGROUND_CONTEXT);
	if (!listed.ok) throw listed.error;
	const prefix = posix.basename(path);
	const names = listed.value
		.map((entry) => entry.name)
		.filter((name) => name === prefix || name.startsWith(`${prefix}.`));
	const records: { i: number }[] = [];
	for (const name of names) {
		records.push(...((await linesOf(env, posix.join(dir, name))) as { i: number }[]));
	}
	return records;
}

describe.each(backends)('a workspace log on $name', (backend) => {
	it('appends one JSON line per record, and creates its parent directory', async () => {
		const opened = await backend.open();
		const env = await opened.backend.connect(host);
		try {
			const log = openLog({ path: '/var/log/room/journal.jsonl' });
			expect(log.path).toBe('/var/log/room/journal.jsonl');

			await log.append(env, { kind: 'joined', who: 'alpha' }, BACKGROUND_CONTEXT);
			await log.append(env, { kind: 'said', text: 'hi' }, BACKGROUND_CONTEXT);

			expect(await linesOf(env, log.path)).toEqual([
				{ kind: 'joined', who: 'alpha' },
				{ kind: 'said', text: 'hi' },
			]);
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
			await opened.dispose();
		}
	});

	it('rotates the active file once it reaches the byte threshold, keeping every record', async () => {
		const opened = await backend.open();
		const env = await opened.backend.connect(host);
		try {
			const log = openLog({ path: '/logs/j.jsonl', rotateBytes: 24 });
			for (let i = 0; i < 8; i++) await log.append(env, { i }, BACKGROUND_CONTEXT);

			const listed = await env.listDir('/logs', BACKGROUND_CONTEXT);
			if (!listed.ok) throw listed.error;
			const names = listed.value.map((entry) => entry.name);
			expect(names).toContain('j.jsonl');
			expect(names.length).toBeGreaterThan(1);

			// Every rotated file (every file but the active one) met the threshold.
			for (const entry of listed.value) {
				if (entry.name === 'j.jsonl') continue;
				expect(entry.size).toBeGreaterThanOrEqual(24);
			}

			const records = await allRecords(env, log.path);
			expect(records.map((r) => r.i).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
			await opened.dispose();
		}
	});

	it('needs no memory of its own: a second openLog over the same path continues correctly', async () => {
		const opened = await backend.open();
		const env = await opened.backend.connect(host);
		try {
			const options = { path: '/logs/j.jsonl', rotateBytes: 24 } as const;
			const first = openLog(options);
			for (let i = 0; i < 4; i++) await first.append(env, { i }, BACKGROUND_CONTEXT);

			// A fresh `openLog` over the same path and env: no state carries over
			// but the path on disk, and none needs to.
			const second = openLog(options);
			for (let i = 4; i < 8; i++) await second.append(env, { i }, BACKGROUND_CONTEXT);

			const records = await allRecords(env, options.path);
			expect(records.map((r) => r.i).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
			await opened.dispose();
		}
	});

	it('scopes two logs at two paths on one workspace, with no collision', async () => {
		const opened = await backend.open();
		const env = await opened.backend.connect(host);
		try {
			const journal = openLog({ path: '/var/log/room/journal.jsonl' });
			const audit = openLog({ path: '/var/log/audit/audit.jsonl' });

			await journal.append(env, { kind: 'said' }, BACKGROUND_CONTEXT);
			await audit.append(env, { kind: 'checked' }, BACKGROUND_CONTEXT);

			expect(await linesOf(env, journal.path)).toEqual([{ kind: 'said' }]);
			expect(await linesOf(env, audit.path)).toEqual([{ kind: 'checked' }]);

			const roomDir = await env.listDir('/var/log/room', BACKGROUND_CONTEXT);
			expect(roomDir.ok && roomDir.value.map((entry) => entry.name)).toEqual(['journal.jsonl']);
			const auditDir = await env.listDir('/var/log/audit', BACKGROUND_CONTEXT);
			expect(auditDir.ok && auditDir.value.map((entry) => entry.name)).toEqual(['audit.jsonl']);
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
			await opened.dispose();
		}
	});

	it('refuses a relative path, since it would resolve inside whichever agent home connects first', () => {
		expect(() => openLog({ path: 'journal.jsonl' })).toThrow(/absolute/i);
		expect(() => openLog({ path: '' })).toThrow(/absolute/i);
	});

	it('refuses a non-positive rotateBytes', () => {
		expect(() => openLog({ path: '/logs/j.jsonl', rotateBytes: 0 })).toThrow(/rotateBytes/);
		expect(() => openLog({ path: '/logs/j.jsonl', rotateBytes: -1 })).toThrow(/rotateBytes/);
	});
});
