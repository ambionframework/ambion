/**
 * `openLog` on both bash backends: one JSON line per record, rotation at a
 * byte threshold with no memory of its own, and two logs side by side. Both
 * logs, `openLog` and `openAuditLog`, refuse a relative path.
 */
import { posix } from 'node:path';
import type { ExecutionEnv } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT, openAuditLog, openLog } from '../src/index.ts';
import { backends } from './support/backends.ts';

const ctx = BACKGROUND_CONTEXT;

/** Every line of one file, parsed as JSON. An unreadable file has no lines. */
async function linesOf(env: ExecutionEnv, path: string): Promise<unknown[]> {
	const read = await env.readTextFile(path, ctx);
	if (!read.ok) return [];
	return read.value
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line) as unknown);
}

async function namesIn(env: ExecutionEnv, dir: string): Promise<string[]> {
	const listed = await env.listDir(dir, ctx);
	if (!listed.ok) throw listed.error;
	return listed.value.map((entry) => entry.name);
}

/** Every record across the named files in `/logs`, in no particular file order. */
async function recordsIn(env: ExecutionEnv, names: string[]): Promise<{ i: number }[]> {
	const records: { i: number }[] = [];
	for (const name of names)
		records.push(...((await linesOf(env, posix.join('/logs', name))) as { i: number }[]));
	return records;
}

describe.each(backends)('a workspace log on $name', (backend) => {
	async function withEnv(run: (env: ExecutionEnv) => Promise<void>) {
		const opened = await backend.open();
		const env = await opened.backend.connect({ name: 'host' });
		try {
			await run(env);
		} finally {
			await env.cleanup();
			await opened.dispose();
		}
	}

	it('appends one JSON line per record, creates its parent directory, and scopes two logs at two paths', () =>
		withEnv(async (env) => {
			const journal = openLog({ path: '/var/log/room/journal.jsonl' });
			const audit = openLog({ path: '/var/log/audit/audit.jsonl' });
			expect(journal.path).toBe('/var/log/room/journal.jsonl');
			await journal.append(env, { kind: 'joined', who: 'alpha' }, ctx);
			await audit.append(env, { kind: 'checked' }, ctx);
			await journal.append(env, { kind: 'said', text: 'hi' }, ctx);
			expect(await linesOf(env, journal.path)).toEqual([
				{ kind: 'joined', who: 'alpha' },
				{ kind: 'said', text: 'hi' },
			]);
			expect(await linesOf(env, audit.path)).toEqual([{ kind: 'checked' }]);
			expect(await namesIn(env, '/var/log/room')).toEqual(['journal.jsonl']);
			expect(await namesIn(env, '/var/log/audit')).toEqual(['audit.jsonl']);
		}));

	it('rotates the active file at the byte threshold, keeps every record, and needs no memory of its own', () =>
		withEnv(async (env) => {
			const options = { path: '/logs/j.jsonl', rotateBytes: 24 } as const;
			const first = openLog(options);
			for (let i = 0; i < 4; i++) await first.append(env, { i }, ctx);
			// A fresh `openLog` over the same path: no state carries over but the file.
			const second = openLog(options);
			for (let i = 4; i < 8; i++) await second.append(env, { i }, ctx);

			const listed = await env.listDir('/logs', ctx);
			if (!listed.ok) throw listed.error;
			const names = listed.value.map((entry) => entry.name);
			expect(names).toContain('j.jsonl');
			expect(names.length).toBeGreaterThan(1);
			const rotated = listed.value.filter((entry) => entry.name !== 'j.jsonl');
			expect(Math.min(...rotated.map((entry) => entry.size))).toBeGreaterThanOrEqual(24);
			const records = await recordsIn(
				env,
				names.filter((name) => name.startsWith('j.jsonl')),
			);
			expect(records.map((r) => r.i).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		}));
});

describe('a log path', () => {
	it.each([
		['openLog', (path: string) => openLog({ path })],
		['openAuditLog', (path: string) => openAuditLog({ path })],
	])(
		'%s refuses a relative path, since it would resolve inside the home that connects first',
		(_name, open) => {
			expect(() => open('journal.jsonl')).toThrow(/absolute/i);
			expect(() => open('')).toThrow(/absolute/i);
		},
	);

	it('refuses a non-positive rotateBytes', () => {
		expect(() => openLog({ path: '/logs/j.jsonl', rotateBytes: 0 })).toThrow(/rotateBytes/);
		expect(() => openLog({ path: '/logs/j.jsonl', rotateBytes: -1 })).toThrow(/rotateBytes/);
	});
});
