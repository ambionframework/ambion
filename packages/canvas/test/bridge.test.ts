import { DatabaseSync } from 'node:sqlite';
import { type Room, readRoom, startRoom } from '@ambionframework/ambion';
import { byAgent, type Script, settled } from '@ambionframework/ambion/testing';
import { sqliteJournals } from '@ambionframework/journal';
import { describe, expect, it, vi } from 'vitest';
import { type CanvasRoom, sqliteCanvas } from '../src/index.ts';
import { breakoutRow, cy, host, live, tooled } from './support/host.ts';
import { sqlOver } from './support/sql.ts';

const rootRow = (name: string, state: CanvasRoom['state'] = 'running'): CanvasRoom => ({
	name,
	goal: 'Plan.',
	depth: 0,
	state,
	start: { kind: 'root' },
});

/** The keys of the posts that the bridge made about the breakout rooms that start with `prefix`. */
const noticeKeys = (messages: readonly { key?: string | undefined }[], prefix: string) =>
	messages.flatMap((m) => (m.key?.startsWith(`breakout:${prefix}`) === true ? [m.key] : []));

const messagesOf = async (room: Room) => (await room.read()).messages;

describe('the bridge after a restart', () => {
	it('posts one notice when a resume closes an exchange that a stop left open, and none at the stop', async () => {
		const database = new DatabaseSync(':memory:');
		const storage = sqliteJournals(sqlOver(database));
		const store = sqliteCanvas(sqlOver(database));
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const held: Script = byAgent({
			cy: async () => {
				await gate;
				return [];
			},
		});
		const first = host({ store, storage, script: held });
		await store.insert(rootRow('site'));
		await store.insert(breakoutRow('site-a', 'site'));
		const agents = [tooled('ada', first.canvas.tools()), cy];
		await first.canvas.resume({ agents });
		await vi.waitFor(async () =>
			expect(
				(await live(first.canvas, 'site-a').read()).exchange?.activations.length,
			).toBeGreaterThan(0),
		);
		await first.canvas.close();
		release();
		const open = await readRoom('site-a', { runtime: first.runtime, messages: false });
		expect(open.exchange).toBeDefined();
		const record = await readRoom('site', { runtime: first.runtime });
		expect(noticeKeys(record.messages, 'site-a')).toEqual([]);

		const second = host({ store, storage });
		await second.canvas.resume({ agents: [tooled('ada', second.canvas.tools()), cy] });
		const site = live(second.canvas, 'site');
		await vi.waitFor(async () =>
			expect(noticeKeys(await messagesOf(site), 'site-a')).toHaveLength(1),
		);
		await settled(live(second.canvas, 'site-a'));
		await second.canvas.start('site-a');
		expect(noticeKeys(await messagesOf(site), 'site-a')).toHaveLength(1);
		expect(second.errors).toEqual([]);
	});

	it('posts each missing notice once, from stopped journals too, and none for an archived room', async () => {
		const database = new DatabaseSync(':memory:');
		const storage = sqliteJournals(sqlOver(database));
		const store = sqliteCanvas(sqlOver(database));
		const seed = host({ store, storage });
		await store.insert(rootRow('site'));
		await store.insert(rootRow('idle', 'stopped'));
		const rows: [string, string, CanvasRoom['state']][] = [
			['site-a', 'site', 'running'],
			['site-b', 'site', 'stopped'],
			['site-c', 'site', 'archived'],
			['idle-a', 'idle', 'running'],
		];
		for (const [name, parent, state] of rows) {
			await store.insert({ ...breakoutRow(name, parent), state });
			const room = await startRoom({ name, agents: [cy], runtime: seed.runtime });
			await room.post({ text: 'Start.', key: `breakout-start:${name}` });
			await settled(room);
			await room.stop();
		}
		for (let run = 0; run < 2; run++) {
			const next = host({ store, storage });
			await next.canvas.resume({ agents: [tooled('ada', next.canvas.tools()), cy] });
			const site = live(next.canvas, 'site');
			const keys = noticeKeys(await messagesOf(site), 'site-');
			expect(keys.map((key) => key.split(':')[1]).sort()).toEqual(['site-a', 'site-b']);
			expect(next.canvas.room('site-b')).toBeUndefined();
			expect(next.canvas.room('idle')).toBeUndefined();
			expect(next.canvas.room('idle-a')).toBeUndefined();
			expect(next.errors).toEqual([]);
			await next.canvas.close();
		}
		expect((await readRoom('idle', { runtime: seed.runtime })).initialized).toBe(false);
	});
});
