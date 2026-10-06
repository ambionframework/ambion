/**
 * The host dies at each crash point of the canvas, and a fresh host resumes over the same
 * storage. Each case matches a row of the crash table in `docs/canvas.md`, and the last case
 * of the seeded walk matches a crash between an archive and the stop of its room.
 *
 * A crash is a fault that fires at one write. The write lands or does not land, as the case says,
 * and every later call of the first host fails, the way a dead process fails. The seed picks
 * the number of breakout rooms, the room that the crash hits, and the mode of a shutdown crash.
 *
 * `AMBION_SEEDS` widens the walk, and the seed prints on failure. `AMBION_CHAOS=all` is the
 * switch of the other chaos files, and this file needs none.
 */
import { DatabaseSync } from 'node:sqlite';
import { createRuntime, readRoom } from '@ambionframework/ambion';
import {
	byAgent,
	type FakeClock,
	fakeClock,
	type Script,
	settled,
} from '@ambionframework/ambion/testing';
import {
	type JournalOpener,
	type JournalStorage,
	memoryJournals,
	sqliteJournals,
} from '@ambionframework/journal';
import { describe, expect, it, vi } from 'vitest';
import { type CanvasRoom, type CanvasStore, memoryCanvas, sqliteCanvas } from '../src/index.ts';
import { callOf, contextOf, type Host, host, live, statesOf, tooled } from './support/host.ts';
import { sqlOver } from './support/sql.ts';

const seeds = Number(process.env.AMBION_SEEDS ?? 6);

interface Base {
	readonly store: CanvasStore;
	readonly storage: JournalOpener;
}

const storages: { name: string; open: () => Base }[] = [
	{ name: 'memory', open: () => ({ store: memoryCanvas(), storage: memoryJournals() }) },
	{
		name: 'SQLite',
		open: () => {
			const database = new DatabaseSync(':memory:');
			return { store: sqliteCanvas(sqlOver(database)), storage: sqliteJournals(sqlOver(database)) };
		},
	},
];

/** Whether a write lands before the crash, or the crash comes after the write landed. */
type Mode = 'before' | 'after' | 'skip';

/** The first host over a base: every write passes through the fault until the fault kills the host. */
class Fault {
	dead = false;
	/** Decides for a journal write: the room, and the entry as text. */
	journal: ((room: string, text: string) => Mode | undefined) | undefined;
	/** Decides for a store write: the kind of write, and the room. */
	store: ((write: 'insert' | 'archive' | 'appendRevision', room: string) => boolean) | undefined;

	constructor(private readonly base: Base) {}

	private alive(): void {
		if (this.dead) throw new Error('The host died.');
	}

	private die(): never {
		this.dead = true;
		throw new Error('The host died.');
	}

	readonly storage: JournalOpener = {
		open: async (name) => {
			this.alive();
			const inner = await this.base.storage.open(name);
			return this.journalOf(name, inner);
		},
	};

	private journalOf(name: string, inner: JournalStorage): JournalStorage {
		return {
			read: async (after) => {
				this.alive();
				return inner.read(after);
			},
			append: async (entry, expected) => {
				this.alive();
				const mode = this.journal?.(name, JSON.stringify(entry));
				if (mode === 'skip') throw new Error('The disk is full.');
				if (mode === 'before') this.die();
				const stored = await inner.append(entry, expected);
				if (mode === 'after') this.die();
				return stored;
			},
		};
	}

	readonly store_: CanvasStore = {
		list: async () => {
			this.alive();
			return this.base.store.list();
		},
		insert: async (room) => {
			this.alive();
			const result = await this.base.store.insert(room);
			if (this.store?.('insert', room.name) === true) this.die();
			return result;
		},
		setState: async (name, state) => {
			this.alive();
			await this.base.store.setState(name, state);
		},
		archive: async (name, close) => {
			this.alive();
			const result = await this.base.store.archive(name, close);
			if (this.store?.('archive', name) === true) this.die();
			return result;
		},
		revisions: async () => {
			this.alive();
			return this.base.store.revisions();
		},
		appendRevision: async (revision) => {
			this.alive();
			const result = await this.base.store.appendRevision(revision);
			if (this.store?.('appendRevision', revision.room) === true) this.die();
			return result;
		},
	};
}

/** Whether the storage name belongs to the journal of the room. */
const journalOf = (storageName: string, room: string): boolean =>
	storageName === room || storageName.includes(JSON.stringify(room));

const rootRow: CanvasRoom = {
	name: 'site',
	goal: 'Plan.',
	depth: 0,
	state: 'running',
	start: { kind: 'root' },
};

/** The first host of a run, and the means to open a second host over the same storage. */
function world(base: Base, script: Script = byAgent({}), clock?: FakeClock) {
	const fault = new Fault(base);
	const first = host({
		store: fault.store_,
		storage: fault.storage,
		script,
		...(clock === undefined ? {} : { clock }),
	});
	let count = 0;
	const agents = (of: Host) => [
		tooled('ada', of.canvas.tools()),
		tooled('cy', of.canvas.workerTools()),
	];
	const call = (of: Host, tool: 'breakout' | 'archive', args: Record<string, unknown>) =>
		callOf(of.canvas.tools(), tool, args, contextOf('ada', 'site', `call-${++count}`));
	const open = (of: Host, name: string) =>
		call(of, 'breakout', { name, goal: 'Survey.', message: 'Survey it.', agents: ['cy'] });
	/** A fresh runtime and canvas over the same base, as a restart gives. */
	const restart = async (): Promise<Host> => {
		await first.canvas.close();
		const second = host({ ...base, ...(clock === undefined ? {} : { clock }) });
		await second.canvas.resume({ agents: agents(second) });
		return second;
	};
	return { fault, first, base, agents, open, call, restart };
}

/** The messages of a room with a key, read from the base with a runtime of its own. */
async function keyed(base: Base, room: string, prefix: string): Promise<string[]> {
	const runtime = createRuntime({ storage: base.storage });
	const read = await readRoom(room, { runtime });
	return read.messages.flatMap((m) => (m.key?.startsWith(prefix) === true ? [m.key] : []));
}

/** The rooms of the second host come to the same record: one start post and one notice each. */
async function expectWhole(second: Host, base: Base, rooms: readonly string[]): Promise<void> {
	for (const room of rooms) {
		await vi.waitFor(async () =>
			expect(await keyed(base, 'site', `breakout:${room}:`)).toHaveLength(1),
		);
		const live = second.canvas.room(room);
		if (live !== undefined) await settled(live);
		expect(await keyed(base, room, 'breakout-start:')).toEqual([`breakout-start:${room}`]);
		expect(await keyed(base, 'site', `breakout:${room}:`)).toHaveLength(1);
	}
	expect(second.errors).toEqual([]);
}

const seedList = Array.from({ length: seeds }, (_, i) => i + 1);

/** The names of the breakout rooms of a run, and the one that the crash hits. */
function plan(seed: number): { names: string[]; hit: number } {
	const rng = mulberry32(seed);
	const count = 2 + Math.floor(rng() * 2);
	return {
		names: Array.from({ length: count }, (_, i) => `r${i}`),
		hit: Math.floor(rng() * count),
	};
}

/** Opens the rooms before the hit room, and waits until each one has run whole. */
async function openBefore(
	w: ReturnType<typeof world>,
	names: readonly string[],
	hit: number,
): Promise<void> {
	for (const name of names.slice(0, hit)) {
		await w.open(w.first, name);
		await vi.waitFor(async () =>
			expect(await keyed(w.base, 'site', `breakout:site-${name}:`)).toHaveLength(1),
		);
	}
}

/** Opens the rooms before the hit room, then the hit room, which the crash cuts. */
async function openUntilCrash(
	w: ReturnType<typeof world>,
	names: readonly string[],
	hit: number,
): Promise<void> {
	await openBefore(w, names, hit);
	await expect(w.open(w.first, names[hit] as string)).rejects.toThrow('The host died.');
}

describe.each(storages)('a host that crashes on $name', (kind) => {
	describe.each(seedList)('seed %i', (seed) => {
		const { names, hit } = plan(seed);
		const rooms = names.slice(0, hit + 1).map((name) => `site-${name}`);

		/** A first host with the root room `site` running. */
		async function begin() {
			const base = kind.open();
			const w = world(base);
			await base.store.insert(rootRow);
			await w.first.canvas.resume({ agents: w.agents(w.first) });
			return w;
		}

		it('starts the room from its row, after the row and before the room starts', async () => {
			const w = await begin();
			w.fault.store = (write, room) => write === 'insert' && room === `site-${names[hit]}`;
			await openUntilCrash(w, names, hit);
			const runtime = createRuntime({ storage: w.base.storage });
			expect(await statesOf(w.base.store)).toMatchObject({ [`site-${names[hit]}`]: 'running' });
			expect((await readRoom(`site-${names[hit]}`, { runtime, messages: false })).initialized).toBe(
				false,
			);
			const second = await w.restart();
			await expectWhole(second, w.base, rooms);
			expect(await statesOf(w.base.store)).toMatchObject(
				Object.fromEntries(rooms.map((room) => [room, 'running'])),
			);
		});

		it.each(['before', 'after'] as const)(
			'posts the start under its key, after the room starts and %s the start post lands',
			async (mode) => {
				const w = await begin();
				const target = `site-${names[hit]}`;
				w.fault.journal = (room, text) =>
					journalOf(room, target) && text.includes(`"key":"post:breakout-start:${target}"`)
						? mode
						: undefined;
				await openUntilCrash(w, names, hit);
				const runtime = createRuntime({ storage: w.base.storage });
				expect((await readRoom(target, { runtime, messages: false })).initialized).toBe(true);
				expect(await keyed(w.base, target, 'breakout-start:')).toHaveLength(
					mode === 'after' ? 1 : 0,
				);
				const second = await w.restart();
				await expectWhole(second, w.base, rooms);
			},
		);

		it.each(['before', 'after'] as const)(
			'posts the notice under its key, after an exchange closes and %s the notice lands',
			async (mode) => {
				const w = await begin();
				const target = `site-${names[hit]}`;
				w.fault.journal = (room, text) =>
					journalOf(room, 'site') && text.includes(`"key":"post:breakout:${target}:`)
						? mode
						: undefined;
				await openBefore(w, names, hit);
				await w.open(w.first, names[hit] as string);
				await vi.waitFor(() => expect(w.fault.dead).toBe(true));
				expect(await keyed(w.base, 'site', `breakout:${target}:`)).toHaveLength(
					mode === 'after' ? 1 : 0,
				);
				const second = await w.restart();
				await expectWhole(second, w.base, rooms);
			},
		);

		it('starts each running room again after a crash during a host shutdown', async () => {
			const base = kind.open();
			let hold = false;
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const clock = fakeClock();
			const w = world(
				base,
				byAgent({
					cy: async () => {
						if (hold) await gate;
						return [];
					},
				}),
				clock,
			);
			await base.store.insert(rootRow);
			await w.first.canvas.resume({ agents: w.agents(w.first) });
			const all = names.map((name) => `site-${name}`);
			const [stopped, busy, ...rest] = all as [string, string, ...string[]];
			for (const name of names) await w.open(w.first, name);
			for (const room of all)
				await vi.waitFor(async () =>
					expect(await keyed(base, 'site', `breakout:${room}:`)).toHaveLength(1),
				);
			await w.first.canvas.stop(stopped);
			// One room is mid-activation at the shutdown, so the stop must write a lease revocation.
			hold = true;
			const room = live(w.first.canvas, busy);
			await room.post({ text: 'More.', key: 'more' });
			await vi.waitFor(async () =>
				expect((await room.read()).exchange?.activations.length).toBeGreaterThan(0),
			);
			const mode: Mode = seed % 2 === 0 ? 'before' : 'after';
			w.fault.journal = (name) => (journalOf(name, busy) ? mode : undefined);
			await w.first.canvas.close();
			expect(w.fault.dead).toBe(true);
			hold = false;
			release();
			const second = await w.restart();
			for (const name of ['site', busy, ...rest]) expect(second.canvas.room(name)).toBeDefined();
			expect(second.canvas.room(stopped)).toBeUndefined();
			expect(await statesOf(base.store)).toEqual({
				site: 'running',
				[stopped]: 'stopped',
				...Object.fromEntries([busy, ...rest].map((name) => [name, 'running'])),
			});
			// The lease of the dead host expires, and the second exchange of the room closes.
			await vi.waitFor(async () => {
				await clock.advance(31_000);
				expect(await keyed(base, 'site', `breakout:${busy}:`)).toHaveLength(2);
			});
			expect(second.errors).toEqual([]);
		});

		it('keeps an archived room stopped, and posts it no notice, after a crash between the archive and the stop', async () => {
			const w = await begin();
			const target = `site-${names[hit]}`;
			await openBefore(w, names, hit);
			// The notice of the target fails once without a crash, so its exchange closes with no notice.
			w.fault.journal = (room, text) =>
				journalOf(room, 'site') && text.includes(`"key":"post:breakout:${target}:`)
					? 'skip'
					: undefined;
			await w.open(w.first, names[hit] as string);
			await settled(live(w.first.canvas, target));
			// The bridge tries the notice after the exchange closes, so wait for its failure.
			await vi.waitFor(() =>
				expect(w.first.errors.some((error) => error.operation === 'notice')).toBe(true),
			);
			w.fault.journal = undefined;
			expect(await keyed(w.base, 'site', `breakout:${target}:`)).toEqual([]);
			w.fault.store = (write, room) => write === 'archive' && room === target;
			const close = { result: 'failed', note: 'No use.' } as const;
			await expect(w.call(w.first, 'archive', { room: target, ...close })).rejects.toThrow(
				'The host died.',
			);
			expect(await statesOf(w.base.store)).toMatchObject({ [target]: 'archived' });
			const second = await w.restart();
			expect(second.canvas.room(target)).toBeUndefined();
			expect(second.canvas.rooms().find((row) => row.name === target)).toMatchObject({
				state: 'archived',
				close,
			});
			await expect(second.canvas.start(target)).rejects.toMatchObject({ code: 'refused' });
			await expect(second.canvas.archive(target, { result: 'done' })).resolves.toEqual(close);
			expect(await keyed(w.base, 'site', `breakout:${target}:`)).toEqual([]);
			expect(await keyed(w.base, target, 'breakout-start:')).toHaveLength(1);
			expect(second.errors).toEqual([]);
			await expectWhole(second, w.base, rooms.slice(0, hit));
		});
	});
});

describe.each(storages)('a host that shows a widget on $name', (kind) => {
	it('finds the revision after the revision lands and before the seat reads the result', async () => {
		const base = kind.open();
		const fault = new Fault(base);
		const kinds = [{ name: 'frame', description: 'A frame.', sources: ['process'] }] as const;
		const first = host({ store: fault.store_, storage: fault.storage, widgets: { kinds } });
		const args = {
			name: 'front',
			kind: 'frame',
			source: { type: 'process', handle: 'bash-1', path: '/' },
		};
		const agentsOf = (of: Host) => [
			tooled('ada', of.canvas.widgetTools()),
			tooled('cy', of.canvas.workerTools()),
		];
		const call = (of: Host, tool: 'show' | 'hide', params: Record<string, unknown>, id: string) =>
			callOf(of.canvas.widgetTools(), tool, params, contextOf('ada', 'site', id));
		await base.store.insert(rootRow);
		await first.canvas.resume({ agents: agentsOf(first) });
		fault.store = (write) => write === 'appendRevision';
		await expect(call(first, 'show', args, 'call-1')).rejects.toThrow('The host died.');
		await first.canvas.close();
		const second = host({ ...base, widgets: { kinds } });
		await second.canvas.resume({ agents: agentsOf(second) });
		const [shown] = second.canvas.widgets('site');
		expect(shown).toMatchObject({ name: 'front', rev: 1, state: 'shown' });
		expect(second.canvas.revision(shown?.revision ?? '')).toEqual(shown);
		expect(await call(second, 'show', args, 'call-2')).toMatchObject({ rev: 1, changed: false });
		expect(await base.store.revisions()).toHaveLength(1);
		expect(await call(second, 'hide', { name: 'front' }, 'call-3')).toMatchObject({
			rev: 2,
			state: 'hidden',
		});
		expect(await base.store.revisions()).toHaveLength(2);
		expect(second.errors).toEqual([]);
	});
});

/** A small seeded generator, so a seed replays the same choices. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
