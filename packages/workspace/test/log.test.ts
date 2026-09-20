import { posix } from 'node:path';
import type { ExecutionEnv } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import type { WorkspaceAgent } from '../src/index.ts';
import { BACKGROUND_CONTEXT, DEFAULT_LOG_FILE, openLog } from '../src/index.ts';
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

describe.each(backends)('a workspace log on $name', (backend) => {
	it('appends one JSON line per record, and creates its root', async () => {
		const opened = await backend.open();
		const env = await opened.backend.connect(host);
		try {
			const log = openLog(env, { root: '/var/log/room' });
			expect(log.root).toBe('/var/log/room');
			expect(log.fileName).toBe(DEFAULT_LOG_FILE);
			expect(log.activePath).toBe('/var/log/room/log.jsonl');

			await log.append({ kind: 'joined', who: 'alpha' }, BACKGROUND_CONTEXT);
			await log.append({ kind: 'said', text: 'hi' }, BACKGROUND_CONTEXT);

			expect(await linesOf(env, log.activePath)).toEqual([
				{ kind: 'joined', who: 'alpha' },
				{ kind: 'said', text: 'hi' },
			]);
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
			await opened.dispose();
		}
	});

	it('rotates the active file once it reaches the byte threshold, never splitting a record', async () => {
		const opened = await backend.open();
		const env = await opened.backend.connect(host);
		try {
			const log = openLog(env, { root: '/logs', fileName: 'j.jsonl', rotateBytes: 24 });
			for (let i = 0; i < 8; i++) await log.append({ i }, BACKGROUND_CONTEXT);

			const listed = await env.listDir('/logs', BACKGROUND_CONTEXT);
			if (!listed.ok) throw listed.error;
			const names = listed.value.map((entry) => entry.name).sort();
			expect(names).toContain('j.jsonl');
			expect(names.length).toBeGreaterThan(1);

			// Every rotated file (every file but the active one) met the threshold.
			for (const entry of listed.value) {
				if (entry.name === 'j.jsonl') continue;
				expect(entry.size).toBeGreaterThanOrEqual(24);
			}

			// Every record survives, across whichever files it landed in, in order.
			const all: number[] = [];
			for (const name of names) {
				const records = (await linesOf(env, posix.join('/logs', name))) as { i: number }[];
				all.push(...records.map((r) => r.i));
			}
			expect(all).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
			await opened.dispose();
		}
	});

	it('recovers its rotation count from disk, so a fresh log continues numbering after a restart', async () => {
		const opened = await backend.open();
		const env = await opened.backend.connect(host);
		try {
			const options = { root: '/logs', fileName: 'j.jsonl', rotateBytes: 24 } as const;
			const first = openLog(env, options);
			for (let i = 0; i < 8; i++) await first.append({ i }, BACKGROUND_CONTEXT);

			const before = await env.listDir('/logs', BACKGROUND_CONTEXT);
			if (!before.ok) throw before.error;
			const rotatedBefore = before.value.map((entry) => entry.name).filter((n) => n !== 'j.jsonl');
			expect(rotatedBefore.length).toBeGreaterThan(0);

			// A fresh `openLog` over the same env and root: no in-memory count survives.
			const second = openLog(env, options);
			for (let i = 8; i < 16; i++) await second.append({ i }, BACKGROUND_CONTEXT);

			const after = await env.listDir('/logs', BACKGROUND_CONTEXT);
			if (!after.ok) throw after.error;
			const rotatedAfter = after.value.map((entry) => entry.name).filter((n) => n !== 'j.jsonl');
			// The restart never overwrote a file the first log had already rotated.
			for (const name of rotatedBefore) expect(rotatedAfter).toContain(name);
			expect(rotatedAfter.length).toBeGreaterThan(rotatedBefore.length);

			const all: number[] = [];
			for (const name of rotatedAfter.concat('j.jsonl').sort()) {
				const records = (await linesOf(env, posix.join('/logs', name))) as { i: number }[];
				all.push(...records.map((r) => r.i));
			}
			expect(all).toEqual(Array.from({ length: 16 }, (_v, i) => i));
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
			await opened.dispose();
		}
	});

	it('scopes two logs at two roots on one workspace, with no collision', async () => {
		const opened = await backend.open();
		const env = await opened.backend.connect(host);
		try {
			const journal = openLog(env, { root: '/var/log/room', fileName: 'journal.jsonl' });
			const audit = openLog(env, { root: '/var/log/audit', fileName: 'audit.jsonl' });

			await journal.append({ kind: 'said' }, BACKGROUND_CONTEXT);
			await audit.append({ kind: 'checked' }, BACKGROUND_CONTEXT);

			expect(await linesOf(env, journal.activePath)).toEqual([{ kind: 'said' }]);
			expect(await linesOf(env, audit.activePath)).toEqual([{ kind: 'checked' }]);

			const roomDir = await env.listDir('/var/log/room', BACKGROUND_CONTEXT);
			expect(roomDir.ok && roomDir.value.map((entry) => entry.name)).toEqual(['journal.jsonl']);
			const auditDir = await env.listDir('/var/log/audit', BACKGROUND_CONTEXT);
			expect(auditDir.ok && auditDir.value.map((entry) => entry.name)).toEqual(['audit.jsonl']);
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
			await opened.dispose();
		}
	});

	it('refuses a file name with a path separator', async () => {
		const opened = await backend.open();
		const env = await opened.backend.connect(host);
		try {
			expect(() => openLog(env, { root: '/logs', fileName: 'a/b.jsonl' })).toThrow(/path/i);
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
			await opened.dispose();
		}
	});

	it('refuses a non-positive rotateBytes', async () => {
		const opened = await backend.open();
		const env = await opened.backend.connect(host);
		try {
			expect(() => openLog(env, { root: '/logs', rotateBytes: 0 })).toThrow(/rotateBytes/);
			expect(() => openLog(env, { root: '/logs', rotateBytes: -1 })).toThrow(/rotateBytes/);
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
			await opened.dispose();
		}
	});
});
