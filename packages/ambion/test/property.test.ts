/**
 * The room under a random walk: people come and go, questions land under
 * repeated keys, the host seats and unseats, time moves, the wire loses and
 * repeats requests, the storage loses a write or its confirmation, and the
 * room crashes and resumes, up to three times. Whatever the walk, the
 * record keeps its shape.
 *
 * `AMBION_SEEDS` widens the walk; the seed prints on failure.
 */
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	inProcessTransport,
	isSummary,
	passive,
	type Runtime,
	resumeSession,
	type Session,
	type SessionEvent,
	startSession,
	stopSession,
	type Visit,
	visitSession,
} from '../src/index.ts';
import { liveLeases } from './support/chaos.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { invariants } from './support/invariants.ts';
import { roomName, rowsOf } from './support/room.ts';
import {
	answersLastQuestion,
	byAgent,
	quiet,
	scripted,
	summarise,
	toolNames,
	toolResultTexts,
} from './support/scripted.ts';
import { type FailMode, memory, tappedOpener } from './support/storage.ts';
import { type Fault, faultyTransport, type Operation, serializing } from './support/transport.ts';

/** A small, fast, seedable generator: the walk is the same for the same seed. */
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

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message a person reads.',
	instructions: 'Answer what was asked, once.',
	model: 'scripted/assistant',
});
const alpha = defineAgent({
	name: 'alpha',
	identity: 'Alpha.',
	instructions: 'x',
	model: 'scripted/alpha',
});
const beta = defineAgent({
	name: 'beta',
	identity: 'Beta.',
	instructions: 'x',
	model: 'scripted/beta',
});
const gamma = defineAgent({
	name: 'gamma',
	identity: 'Gamma.',
	instructions: 'x',
	model: 'scripted/gamma',
});
const people = [
	defineHuman({
		name: 'priya',
		identity: 'Project manager.',
		preferences: 'Lead with the decision.',
	}),
	defineHuman({ name: 'sam', identity: 'Site foreman.' }),
];
const names = people.map((p) => p.name);

const script = byAgent({
	alpha: answersLastQuestion(names),
	beta: answersLastQuestion(names),
	gamma: answersLastQuestion(names),
	assistant: (context) =>
		toolNames(context).includes('summarise') && !toolResultTexts(context).includes('delivered')
			? summarise('The one message.')
			: quiet(),
});

const STEPS = [
	'visit',
	'leave',
	'deliver',
	'seat',
	'unseat',
	'advance',
	'fault',
	'disk',
	'crash',
] as const;
type Step = (typeof STEPS)[number];
const OPERATIONS: Operation[] = ['wake', 'view', 'commit', 'lease'];

/**
 * What a step may hear back: the storage refused the write, the visit is
 * over, or the roster already says so. Anything else is a defect the walk
 * found, and the test fails on it.
 */
const EXPECTED =
	/the disk is full|visit has ended|one name names one participant|is not seated in this session/;

const expected = (error: unknown): undefined => {
	if (EXPECTED.test(String(error))) return undefined;
	throw error;
};

/** One walk: the room, the runtime it runs in, and what the walk did so far. */
class Walk {
	/** The events of the run that holds the room now. A crashed run's events are its own. */
	events: SessionEvent[] = [];
	/** What the run that holds the room now inherited: leases live at its resume, and an open exchange. */
	inherited = { activations: 0, exchange: false };
	readonly log: string[] = [];
	readonly faults: Fault[] = [];
	readonly clock: FakeClock = fakeClock();
	readonly visits = new Map<string, Visit>();
	session!: Session;
	runtime!: Runtime;
	crashes = 0;
	/** The one write the storage fails next, and how. */
	private disk: FailMode = false;
	private readonly sessions: Awaited<ReturnType<typeof memory.open>>['sessions'];
	private lastKey: string | undefined;
	private deliveries = 0;

	constructor(
		readonly name: string,
		private readonly random: () => number,
		sessions: Awaited<ReturnType<typeof memory.open>>['sessions'],
	) {
		this.sessions = tappedOpener(sessions, (id, _n, phase) => {
			if (id !== name || this.disk !== phase) return;
			this.disk = false;
			throw new Error('the disk is full');
		});
	}

	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.random() * items.length)] as T;
	}

	private host(): Runtime {
		return createRuntime({
			sessions: this.sessions,
			clock: this.clock,
			agents: [assistant, alpha, beta, gamma],
			transport: serializing(faultyTransport(inProcessTransport(), this.faults, this.clock)),
		});
	}

	async start(): Promise<void> {
		this.runtime = this.host();
		this.session = startSession({
			name: this.name,
			runtime: this.runtime,
			assistant,
			agents: [alpha, passive(beta)],
			available: [gamma],
			streamFn: scripted(script),
		});
		this.watch();
		await this.session.messages();
	}

	private watch(): void {
		this.events = [];
		this.session.subscribe((event) => this.events.push(event));
	}

	/** One step, under a deadline: a step that hangs names itself instead of the test's timeout. */
	step(step: Step): Promise<void> {
		this.log.push(step);
		return within(this.take(step), 10_000, step);
	}

	private async take(step: Step): Promise<void> {
		if (step === 'visit') return this.visit();
		if (step === 'leave') return this.leave();
		if (step === 'deliver') return this.deliver();
		if (step === 'seat') return this.session.seat(gamma).catch(expected);
		if (step === 'unseat') return this.session.unseat(gamma).catch(expected);
		if (step === 'advance') return this.clock.advance(Math.floor(this.random() * 70_000));
		if (step === 'fault') return this.fault();
		if (step === 'disk') return this.fail();
		return this.crash();
	}

	/** The storage fails the next write: it never lands, or it lands and the confirmation is lost. */
	private fail(): void {
		this.disk = this.pick(['before', 'after'] as const);
		this.log.push(`  disk fails the next write ${this.disk}`);
	}

	/** A visit the storage refused is no visit: the host tries again another time. */
	private async visit(): Promise<void> {
		const person = this.pick(people);
		if (this.visits.has(person.name)) return;
		const visit = await visitSession(this.session, person).catch(expected);
		if (visit !== undefined) this.visits.set(person.name, visit);
	}

	private async leave(): Promise<void> {
		const person = this.pick(names);
		const visit = this.visits.get(person);
		if (visit === undefined) return;
		this.visits.delete(person);
		await visit.leave().catch(expected);
	}

	private async deliver(): Promise<void> {
		const visit = this.pick([...this.visits.values()]);
		if (visit === undefined) return;
		// One delivery in ten repeats the last key: the host never learned whether it landed.
		const repeated = this.lastKey !== undefined && this.random() < 0.1;
		const key = repeated ? this.lastKey : `d${++this.deliveries}`;
		this.lastKey = key;
		this.log.push(`  ${visit.human.name} ${repeated ? 'repeats' : 'delivers'} ${key}`);
		await visit.deliver({ text: `Question ${key}?`, key: key as string }).catch(expected);
	}

	private fault(): void {
		const kind = this.pick(['drop', 'duplicate', 'delay'] as const);
		const fault: Fault = {
			on: this.pick(OPERATIONS),
			kind,
			...(kind === 'delay' ? { ms: 2_000 } : {}),
		};
		this.log.push(`  fault ${fault.kind} ${fault.on}`);
		this.faults.push(fault);
	}

	/** Up to three times: the room is dropped from memory and resumed by a new host over the same log. */
	private async crash(): Promise<void> {
		if (this.crashes >= 3) return;
		this.crashes += 1;
		this.runtime.evict(this.name);
		this.visits.clear();
		const activations = await liveLeases(this.sessions, this.name, this.clock.now());
		this.runtime = this.host();
		this.session = await resumeSession(this.name, {
			runtime: this.runtime,
			streamFn: scripted(script),
		});
		this.inherited = { activations, exchange: this.session.exchange() !== undefined };
		this.watch();
	}

	/** Time moves until nothing is live: every lease expires, every wake is sent again, every draft is due. */
	async drain(): Promise<void> {
		this.faults.length = 0;
		this.disk = false;
		for (let i = 0; i < 6; i += 1) await this.clock.advance(61_000);
		await within(this.session.quiet(), 10_000, 'quiet after the drain');
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

const seeds = Number(process.env.AMBION_SEEDS ?? 25);

/** One event in a few characters, for the failure message. */
function brief(event: SessionEvent): string {
	if (event.type === 'message') return `m${event.message.seq}:${event.message.kind}`;
	if (event.type === 'activation_start') return `+${event.agent}`;
	if (event.type === 'activation_end') return `-${event.agent}`;
	if (event.type === 'error') return `!${event.agent}`;
	return event.type;
}

describe('the room under a random walk', () => {
	it.each(Array.from({ length: seeds }, (_, i) => i + 1))(
		'keeps its shape on seed %i',
		async (seed) => {
			const opened = await memory.open();
			const walk = new Walk(roomName(`property-${seed}`), mulberry32(seed), opened.sessions);
			try {
				await walk.start();
				for (let i = 0; i < 20; i += 1) await walk.step(walk.pick(STEPS));
				await walk.drain();
				await invariants(walk.session, walk.events, {
					allowErrors: 100,
					sessions: opened.sessions,
					inherited: walk.inherited.activations,
					inheritedExchange: walk.inherited.exchange,
				});
				// every summary stands for a range that ends right before it, whatever the walk did
				for (const summary of (await walk.session.messages()).filter(isSummary)) {
					expect(summary.covers.through).toBe(summary.seq - 1);
				}
				await stopSession(walk.session);
			} catch (error) {
				const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
				const seats = walk.session
					.seats()
					.map((s) => [s.name, s.kind === 'agent' ? s.status : s.presence]);
				walk.log.push(`seats: ${JSON.stringify(seats)}`);
				walk.log.push(`events: ${walk.events.map(brief).join(' ')}`);
				const rows = await rowsOf(opened.sessions, walk.name);
				walk.log.push(
					`rows:\n  ${rows.map((r) => `${r.type.slice(7)} ${JSON.stringify(r.data)}`).join('\n  ')}`,
				);
				throw new Error(`seed ${seed} failed after:\n${walk.log.join('\n')}\n\n${detail}`, {
					cause: error,
				});
			}
		},
		30_000,
	);
});
