/**
 * The room under concurrent clients and a nemesis, checked as a history.
 * Two people and the host act at once against whichever run holds the
 * room, while the nemesis crashes the run, fails the storage, and loses,
 * repeats and delays requests on the wire. Every action is recorded as
 * an invocation and an outcome, and the checks in `support/history.ts`
 * hold the history to the record the room ends with.
 *
 * `AMBION_SEEDS` widens the walk; the seed prints on failure.
 */
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	inProcessTransport,
	type Runtime,
	resumeSession,
	type Session,
	type SessionEvent,
	startSession,
	stopSession,
	type Visit,
	visitSession,
} from '../src/index.ts';
import { foldRoom } from '../src/room/fold.ts';
import { agents, assistant, colleague, priya, product, sam, troubled } from './support/cast.ts';
import { liveLeases } from './support/chaos.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { type Entry, History, violations } from './support/history.ts';
import { invariants } from './support/invariants.ts';
import { roomName, rowsOf } from './support/room.ts';
import { scripted } from './support/scripted.ts';
import { type FailMode, gatedOpener, memory, tappedOpener } from './support/storage.ts';
import { type Fault, faultyTransport, type Operation, serializing } from './support/transport.ts';

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

const OPERATIONS: Operation[] = ['wake', 'view', 'commit', 'lease'];
const RETRY = { attempts: 3, backoff: (attempt: number) => attempt * 30_000 };

/** One room over one storage, and the run that holds it now. */
class Cluster {
	readonly clock: FakeClock = fakeClock();
	readonly history = new History(this.clock);
	readonly faults: Fault[] = [];
	readonly cast = troubled();
	/** Which run holds the room: a visit taken on an earlier run is over. */
	epoch = 0;
	events: SessionEvent[] = [];
	inherited = { activations: 0, exchange: false };
	runtime!: Runtime;
	session!: Session;
	private disk: FailMode = false;
	private failedBefore = 0;
	/** Room calls the nemesis dropped, counted when taken: every one fails an activation, and that is one error. A dropped wake is sent again and fails nothing. */
	private dropped = 0;
	private droppedBefore = 0;
	/** Leases live when time jumped past the whole expiry: every one expires, and that is one error. */
	private jumped = 0;
	private jumpedBefore = 0;
	private readonly sessions;

	constructor(
		readonly name: string,
		readonly opened: Awaited<ReturnType<typeof memory.open>>,
		readonly random: () => number,
	) {
		this.sessions = tappedOpener(opened.sessions, (id, _n, phase) => {
			if (id !== name || this.disk !== phase) return;
			this.disk = false;
			throw new Error('the disk is full');
		});
	}

	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.random() * items.length)] as T;
	}

	/**
	 * One host action, recorded. An answer from a run that lost the name
	 * while the action ran is no answer: the run is gone, and what it held
	 * is not the record.
	 */
	act<T>(
		client: string,
		op: string,
		key: string | undefined,
		action: () => Promise<T>,
		seen?: (value: T) => Entry['seen'],
	): Promise<T | undefined> {
		const epoch = this.epoch;
		return this.history.run(client, op, key, action, seen, () => this.epoch !== epoch);
	}

	/** The run that holds the room now, and the gate that holds its next append when the nemesis says so. */
	private current = { gate: undefined as Promise<void> | undefined, release: () => {}, held: 0 };

	private host(): Runtime {
		const current = { gate: undefined as Promise<void> | undefined, release: () => {}, held: 0 };
		this.current = current;
		// every run's appends go through its own gate, so a cut holds the old run's write alone
		const sessions = gatedOpener(this.sessions, () => {
			if (current.gate !== undefined) current.held += 1;
			return current.gate;
		});
		return createRuntime({
			sessions,
			clock: this.clock,
			agents,
			transport: serializing(faultyTransport(inProcessTransport(), this.faults, this.clock)),
		});
	}

	/**
	 * The run dies with a write in flight: the next append is held, the run
	 * is evicted and the name resumed while it is held, and then the write
	 * lands, past the fence. The fence makes it void.
	 */
	async cut(): Promise<void> {
		const run = this.current;
		run.gate = new Promise<void>((resolve) => {
			run.release = resolve;
		});
		for (let i = 0; i < 40 && run.held === 0; i += 1) await yields();
		await this.crash();
		run.release();
	}

	async start(): Promise<void> {
		this.runtime = this.host();
		this.session = startSession({
			name: this.name,
			runtime: this.runtime,
			assistant,
			agents: [product, colleague],
			streamFn: scripted(this.cast.script),
		});
		this.watch();
		await this.session.messages();
	}

	private watch(): void {
		this.events = [];
		this.failedBefore = this.cast.failures();
		this.droppedBefore = this.dropped;
		this.jumpedBefore = this.jumped;
		this.session.subscribe((event) => this.events.push(event));
	}

	/** The errors a run may carry: what it inherited, the cast's failures, the drops and the jumps it saw. */
	private allowance(): number {
		return (
			this.inherited.activations +
			(this.cast.failures() - this.failedBefore) +
			(this.dropped - this.droppedBefore) +
			(this.jumped - this.jumpedBefore)
		);
	}

	/** Every run is held to its own bound: a run that dies is checked before the next one starts. */
	private bounded(): void {
		const errors = this.events.flatMap((e) =>
			e.type === 'error' ? [`${e.agent}: ${e.error.message}`] : [],
		);
		expect(errors.length, `errors on a run: ${errors.join('; ')}`).toBeLessThanOrEqual(
			this.allowance(),
		);
	}

	/** The run dies and a fresh host resumes the name over the same log. */
	async crash(): Promise<void> {
		this.bounded();
		this.runtime.evict(this.name);
		this.epoch += 1;
		const activations = await liveLeases(this.opened.sessions, this.name, this.clock.now());
		// A resume writes the run row first, and a host tries again when the storage fails it.
		for (let attempt = 0; ; attempt += 1) {
			this.runtime = this.host();
			try {
				this.session = await resumeSession(this.name, {
					runtime: this.runtime,
					streamFn: scripted(this.cast.script),
				});
				break;
			} catch (error) {
				if (attempt === 2 || !/disk is full/.test(String(error))) throw error;
			}
		}
		this.inherited = { activations, exchange: this.session.exchange() !== undefined };
		this.watch();
	}

	/** The storage fails the next write: it never lands, or it lands and the confirmation is lost. */
	failDisk(): string {
		this.disk = this.pick(['before', 'after'] as const);
		return this.disk;
	}

	failWire(): string {
		const kind = this.pick(['drop', 'duplicate', 'delay'] as const);
		const on = this.pick(OPERATIONS);
		const taken = () => {
			if (kind === 'drop' && on !== 'wake') this.dropped += 1;
			return true;
		};
		this.faults.push({ on, kind, match: taken, ...(kind === 'delay' ? { ms: 2_000 } : {}) });
		return `${kind} ${on}`;
	}

	/** Time jumps, the way a paused process sees it: a lease live across a jump past its expiry ends. */
	async advance(ms: number): Promise<void> {
		if (ms >= this.runtime.wake.expiry) {
			this.jumped += await liveLeases(this.opened.sessions, this.name, this.clock.now());
		}
		await this.clock.advance(ms);
	}

	/** Time moves until nothing is live: every lease expires, every backoff passes, every draft is due. */
	async drain(): Promise<void> {
		this.faults.length = 0;
		this.disk = false;
		// in steps under the expiry, so an activation in flight renews across them
		for (let i = 0; i < 14; i += 1) await this.advance(31_000);
		await within(this.session.quiet(), 10_000, 'quiet after the drain');
	}

	async check(): Promise<void> {
		await invariants(this.session, this.events, {
			allowErrors: this.allowance(),
			sessions: this.opened.sessions,
			inherited: this.inherited.activations,
			inheritedExchange: this.inherited.exchange,
		});
		const rows = await rowsOf(this.opened.sessions, this.name);
		const entries = rows.flatMap((row) => {
			const type = row.type.slice('ambion/'.length);
			if (type === 'message') return [{ type, message: row.data } as never];
			if (type === 'lease') return [{ type, lease: row.data } as never];
			if (type === 'close') return [{ type, close: row.data } as never];
			if (type === 'composition') return [{ type, composition: row.data } as never];
			return [];
		});
		const state = foldRoom(entries, RETRY);
		expect(
			violations(this.history, { record: await this.session.messages(), rows, state }),
		).toEqual([]);
	}
}

/** The promise, or an error naming what did not happen within `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`'${what}' did not finish within ${ms} ms.`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const yields = () => new Promise((resolve) => setImmediate(resolve));

/** A person: visits, asks, reads, leaves, and retries a delivery it never heard back on. */
class Person {
	private visit: { handle: Visit; epoch: number } | undefined;
	private deliveries = 0;

	constructor(
		private readonly cluster: Cluster,
		readonly definition: typeof priya,
	) {}

	get name(): string {
		return this.definition.name;
	}

	async step(): Promise<void> {
		const { cluster } = this;
		const op = cluster.pick(['visit', 'deliver', 'deliver', 'read', 'leave'] as const);
		if (op === 'visit') return this.arrive();
		if (op === 'read') return this.read();
		if (op === 'leave') return this.leave();
		return this.deliver();
	}

	private current(): Visit | undefined {
		if (this.visit === undefined || this.visit.epoch !== this.cluster.epoch) return undefined;
		return this.visit.handle;
	}

	private async arrive(): Promise<void> {
		if (this.current() !== undefined) return;
		const { cluster } = this;
		const epoch = cluster.epoch;
		const handle = await cluster.act(this.name, 'visit', undefined, () =>
			visitSession(cluster.session, this.definition),
		);
		if (handle !== undefined) this.visit = { handle, epoch };
	}

	private async deliver(): Promise<void> {
		const visit = this.current();
		if (visit === undefined) return this.arrive();
		const key = `${this.name}-${++this.deliveries}`;
		const { cluster } = this;
		const landed = await cluster.act(this.name, 'deliver', key, () =>
			visit.deliver({ text: `${key}?`, key }).then(() => true),
		);
		// A delivery the person never heard back on is delivered again under the same key.
		if (landed === undefined) {
			await this.arrive();
			const again = this.current();
			if (again === undefined) return;
			await cluster.act(this.name, 'deliver', key, () =>
				again.deliver({ text: `${key}?`, key }).then(() => true),
			);
		}
	}

	private async read(): Promise<void> {
		const { cluster } = this;
		await cluster.act(
			this.name,
			'read',
			undefined,
			() => cluster.session.messages(),
			(record) => record.map((m) => ({ seq: m.seq, key: m.key })),
		);
	}

	private async leave(): Promise<void> {
		const visit = this.current();
		if (visit === undefined) return;
		this.visit = undefined;
		await this.cluster.act(this.name, 'leave', undefined, () => visit.leave());
	}
}

/** The host: seats and unseats, reads, moves the clock, and is the nemesis. */
class Host {
	constructor(readonly cluster: Cluster) {}

	async step(): Promise<void> {
		const { cluster } = this;
		const op = cluster.pick([
			'seat',
			'unseat',
			'read',
			'advance',
			'advance',
			'wire',
			'disk',
			'crash',
			'cut',
		] as const);
		if (op === 'seat') {
			await cluster.act('host', 'seat', undefined, () => cluster.session.seat(colleague));
		} else if (op === 'unseat') {
			await cluster.act('host', 'unseat', undefined, () => cluster.session.unseat(colleague));
		} else if (op === 'read') {
			await cluster.act(
				'host',
				'read',
				undefined,
				() => cluster.session.messages(),
				(record) => record.map((m) => ({ seq: m.seq, key: m.key })),
			);
		} else if (op === 'advance') {
			const ms = Math.floor(cluster.random() * 70_000);
			await cluster.history.run('host', `advance ${ms}`, undefined, () => cluster.advance(ms));
		} else if (op === 'wire') {
			await cluster.history.run('host', 'wire', undefined, async () => cluster.failWire());
		} else if (op === 'disk') {
			await cluster.history.run('host', 'disk', undefined, async () => cluster.failDisk());
		} else if (op === 'cut') {
			await cluster.history.run('host', 'cut', undefined, () => cluster.cut());
		} else {
			await cluster.history.run('host', 'crash', undefined, () => cluster.crash());
		}
	}
}

const seeds = Number(process.env.AMBION_SEEDS ?? 25);
const STEPS = 12;

describe('the room under concurrent clients and a nemesis', () => {
	it.each(Array.from({ length: seeds }, (_, i) => i + 1))(
		'keeps every guarantee on seed %i',
		async (seed) => {
			const opened = await memory.open();
			const cluster = new Cluster(roomName(`consistency-${seed}`), opened, mulberry32(seed));
			try {
				await cluster.start();
				const clients = [new Person(cluster, priya), new Person(cluster, sam), new Host(cluster)];
				await within(
					Promise.all(
						clients.map(async (client) => {
							for (let i = 0; i < STEPS; i += 1) {
								await client.step();
								await yields();
							}
						}),
					),
					20_000,
					'the clients',
				);
				await cluster.drain();
				await cluster.check();
				await stopSession(cluster.session);
			} catch (error) {
				const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
				const rows = await rowsOf(opened.sessions, cluster.name);
				const errors = cluster.events.flatMap((e) =>
					e.type === 'error' ? [`${e.agent}: ${e.error.message}`] : [],
				);
				const brief = cluster.events
					.map((e) => {
						if (e.type === 'message') return `m${e.message.seq}:${e.message.kind}`;
						if ('agent' in e) return `${e.type}:${e.agent}`;
						return e.type;
					})
					.join(' ');
				throw new Error(
					`seed ${seed} failed:\n${cluster.history.describe()}\nerrors on the last run: ${errors.join('; ')} (inherited ${cluster.inherited.activations})\nevents on the last run: ${brief}\nrows:\n  ${rows
						.map((r) => `${r.type.slice(7)} ${JSON.stringify(r.data)}`)
						.join('\n  ')}\n\n${detail}`,
					{ cause: error },
				);
			} finally {
				await opened.dispose();
			}
		},
		40_000,
	);
});
