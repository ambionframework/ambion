/**
 * The chaos harness: one room, driven the way a host drives it, through
 * crashes the harness places on purpose.
 *
 * A `World` holds a room over one storage and one clock. It crashes the
 * room at the append the test names — before the entry lands, or after it
 * landed and before the room hears — then resumes the name in a fresh
 * runtime, puts back the people who were present, and retries the host
 * action that failed under the same key. That is what a host does after a
 * process dies, and the world does it at every write the sweep names.
 *
 * `outcome` says what the scenario must have come to, whatever the walk
 * through it: every delivery on the record once, every answer once, every
 * summary owed written once.
 */
import { expect } from 'vitest';
import {
	createRuntime,
	type HumanDefinition,
	inProcessTransport,
	isSpoken,
	isSummary,
	type Message,
	type Runtime,
	resumeSession,
	type Session,
	type SessionEvent,
	type SessionOpener,
	startSession,
	visitSession,
} from '../../src/index.ts';
import { activationId, foldLeases, isLive } from '../../src/room/lease.ts';
import type { CloseRow, LeaseRow } from '../../src/wire.ts';
import {
	agents,
	assistant,
	colleague,
	priya,
	product,
	type Question,
	questions,
	sam,
	script,
} from './cast.ts';
import { type FakeClock, fakeClock } from './clock.ts';
import { invariants } from './invariants.ts';
import { rowsOf } from './room.ts';
import { scripted } from './scripted.ts';
import { type FailMode, type OpenedStorage, tappedOpener } from './storage.ts';
import { serializing } from './transport.ts';

/**
 * The record the scenario must come to, whatever happened on the way:
 * every delivery on it once, every answer at most once, and every
 * summary owed written once. A seat whose lease the dead run held answers
 * once at most: the lease expires, and the room does not send the wake
 * again (backlog item 35), so that answer is the one the record may lack.
 */
export async function outcome(session: Session, sessions: SessionOpener): Promise<void> {
	const record = await session.messages();
	const rows = await rowsOf(sessions, session.name);
	const expired = new Set(
		rows.flatMap((r) => {
			const lease = r.type === 'ambion/lease' ? (r.data as LeaseRow) : undefined;
			return lease?.phase === 'ended' && lease.reason === 'expired' ? [lease.id] : [];
		}),
	);
	for (const question of questions) {
		const landed = record.filter((m) => m.key === question.key);
		expect(landed, `delivery ${question.key}`).toHaveLength(1);
		const asked = landed[0] as Message;
		expect(asked).toMatchObject({ kind: 'said', from: question.person.name });
		for (const seat of question.answered) {
			const answers = record
				.filter(isSpoken)
				.filter((m) => m.from === seat && m.text === `${seat} on ${question.text}`);
			expect(answers.length, `${seat} on ${question.key}`).toBeLessThanOrEqual(1);
			if (!expired.has(activationId(asked.seq, seat))) {
				expect(answers, `${seat} on ${question.key}`).toHaveLength(1);
			}
		}
	}
	// every close that woke the assistant is one summary to the person whose exchange it was
	const closes = rows.flatMap((r) => (r.type === 'ambion/close' ? [r.data as CloseRow] : []));
	expect(closes).toHaveLength(3);
	const owed = closes.filter((c) => c.wakes?.includes(assistant.name)).map((c) => c.owner);
	expect(record.filter(isSummary).map((m) => m.to)).toEqual(owed);
	expect(session.exchange()).toBeUndefined();
	expect(session.seats().find((s) => s.name === priya.name)).toMatchObject({ presence: 'absent' });
	expect(session.seats().find((s) => s.name === sam.name)).toMatchObject({ presence: 'present' });
}

/** The record an untroubled run comes to: two answers to the first two questions owe a summary each. */
export async function wholeOutcome(session: Session, sessions: SessionOpener): Promise<void> {
	await outcome(session, sessions);
	const record = await session.messages();
	expect(record.filter(isSummary).map((m) => m.to)).toEqual([priya.name, sam.name]);
}

/** The leases running and not expired on the log at `now`: what a resumed room inherits. */
export async function liveLeases(
	sessions: SessionOpener,
	name: string,
	now: number,
): Promise<number> {
	const rows = (await rowsOf(sessions, name)).flatMap((r) =>
		r.type === 'ambion/lease' ? [r.data as LeaseRow] : [],
	);
	return [...foldLeases(rows).values()].filter((lease) => isLive(lease, now)).length;
}

// -- the world ----------------------------------------------------------------

export interface CrashPoint {
	/** The append to crash at, counting the room's own log alone. */
	at: number;
	mode: Exclude<FailMode, false>;
}

export class Crashed extends Error {}

/** Nothing this world sees fails but the crash. */
const notCrashed = (error: unknown): boolean => !(error instanceof Crashed);

/**
 * One room, one storage, one clock, and as many runtimes as crashes. Every
 * host action goes through here, so a crash under it is resumed and the
 * action is retried, under the same key.
 */
export class World {
	readonly clock: FakeClock = fakeClock();
	/** The events of the run that holds the room now. A crashed run's events are its own. */
	events: SessionEvent[] = [];
	/** How many times the room crashed. */
	crashes = 0;
	/** How many appends the room's log took, across every run. */
	writes = 0;
	/** What the run that holds the room now inherited: leases live at its resume, and an open exchange. */
	inherited = { activations: 0, exchange: false };
	private runtime!: Runtime;
	private session!: Session;
	private off: () => void = () => {};
	private dead = false;
	private readonly present = new Map<string, HumanDefinition>();
	private readonly sessions: SessionOpener;

	constructor(
		readonly name: string,
		readonly opened: OpenedStorage,
		private readonly crashAt?: CrashPoint,
	) {
		this.sessions = tappedOpener(opened.sessions, (id, _n, phase) => this.appended(id, phase));
	}

	/** The room the world holds now. A test reads it after `quiet()`. */
	get room(): Session {
		return this.session;
	}

	private appended(id: string, phase: 'before' | 'after'): void {
		if (id !== this.name) return;
		if (phase === 'before') this.writes += 1;
		if (this.dead) throw new Crashed('the process is gone');
		if (this.crashAt === undefined || this.crashes > 0) return;
		if (this.writes !== this.crashAt.at || phase !== this.crashAt.mode) return;
		this.crash();
		throw new Crashed(`crashed ${phase} write ${this.writes}`);
	}

	/** The run dies here: nothing it holds writes again, and nothing it emits from now on counts. */
	private crash(): void {
		this.crashes += 1;
		this.dead = true;
		this.off();
		this.runtime.evict(this.name);
	}

	private host(): Runtime {
		return createRuntime({
			sessions: this.sessions,
			clock: this.clock,
			agents,
			transport: serializing(inProcessTransport()),
		});
	}

	private watch(): void {
		this.events = [];
		this.off = this.session.subscribe((event) => this.events.push(event));
	}

	async start(): Promise<void> {
		this.open();
		await this.retrying(async () => {
			await this.session.messages();
		});
	}

	/** A room started from the composition: the first run, or a run whose log never took one. */
	private open(): void {
		this.runtime = this.host();
		this.session = startSession({
			name: this.name,
			runtime: this.runtime,
			assistant,
			agents: [product, colleague],
			streamFn: scripted(script),
		});
		this.watch();
	}

	/**
	 * A dead room is resumed by a fresh host, with the people who were present
	 * put back. A log that never took its composition is started again instead.
	 */
	private async ensure(): Promise<void> {
		if (!this.dead) return;
		this.dead = false;
		this.runtime = this.host();
		try {
			this.session = await resumeSession(this.name, {
				runtime: this.runtime,
				streamFn: scripted(script),
			});
		} catch (error) {
			if (!/no composition/.test(String(error))) throw error;
			this.open();
			await this.session.messages();
			return;
		}
		this.inherited = {
			activations: await liveLeases(this.opened.sessions, this.name, this.clock.now()),
			exchange: this.session.exchange() !== undefined,
		};
		this.watch();
		for (const person of this.present.values()) await visitSession(this.session, person);
	}

	/** One host action, retried across a crash under it. */
	private async retrying(action: () => Promise<void>): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await this.ensure();
			try {
				await action();
				return;
			} catch (error) {
				if (notCrashed(error) && !this.dead) throw error;
			}
		}
		throw new Error('the action never landed');
	}

	async visit(person: HumanDefinition): Promise<void> {
		this.present.set(person.name, person);
		await this.retrying(async () => {
			await visitSession(this.session, person);
		});
	}

	async deliver(question: Question): Promise<void> {
		await this.retrying(async () => {
			const visit = await visitSession(this.session, question.person);
			await visit.deliver({
				text: question.text,
				key: question.key,
				...(question.to === undefined ? {} : { to: question.to }),
			});
		});
	}

	async leave(person: HumanDefinition): Promise<void> {
		await this.retrying(async () => {
			const visit = await visitSession(this.session, person);
			await visit.leave();
		});
		this.present.delete(person.name);
	}

	/**
	 * Time moves until the room is quiet with nothing owed: every lease the
	 * dead run held expires, every retry's backoff passes, and every draft is
	 * written. A crash on the way is resumed like any other.
	 */
	async quiet(): Promise<void> {
		for (let round = 0; round < 12; round += 1) {
			await this.ensure();
			// quiet on its own, or waiting on the clock: a lease to expire, a backoff to pass
			const settled = await Promise.race([
				this.session.quiet().then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
			]);
			if (this.dead) continue;
			if (settled && this.idle()) return;
			await this.clock.advance(31_000);
		}
		throw new Error('the room never went quiet');
	}

	/** Nothing live and nothing open, on the fold the room holds now. */
	private idle(): boolean {
		const seats = this.session.seats();
		return (
			this.session.exchange() === undefined &&
			seats.every((s) => s.kind !== 'agent' || s.status === 'idle')
		);
	}

	/** The scenario, start to end. */
	async run(): Promise<void> {
		await this.start();
		await this.visit(priya);
		await this.deliver(questions[0] as Question);
		await this.quiet();
		await this.leave(priya);
		await this.visit(sam);
		await this.deliver(questions[1] as Question);
		await this.quiet();
		await this.deliver(questions[2] as Question);
		await this.quiet();
	}

	/** The record's shape, then the scenario's outcome. */
	async check(): Promise<void> {
		const errors = this.events.flatMap((e) => (e.type === 'error' ? [e.error.message] : []));
		// the one error a crash leaves: the lease the dead run held expired
		expect(errors.filter((m) => !/past its lease/.test(m))).toEqual([]);
		await invariants(this.session, this.events, {
			sessions: this.opened.sessions,
			allowErrors: this.inherited.activations,
			inherited: this.inherited.activations,
			inheritedExchange: this.inherited.exchange,
		});
		await outcome(this.session, this.opened.sessions);
	}

	/** What the world looks like when a check fails: the log rows, for the failure message. */
	async describe(): Promise<string> {
		const rows = await rowsOf(this.opened.sessions, this.name);
		const messages = (await this.session.messages()).map(
			(m: Message) => `#${m.seq} ${m.kind} ${m.from}${m.key ? ` (${m.key})` : ''}`,
		);
		return [
			`crashes: ${this.crashes}, writes: ${this.writes}`,
			`messages: ${messages.join('; ')}`,
			`rows: ${rows.map((r) => `${r.type.slice(7)} ${JSON.stringify(r.data)}`).join('\n  ')}`,
		].join('\n');
	}
}

/** The promise, or an error naming what did not happen within `ms`. */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`'${what}' did not finish within ${ms} ms.`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
