/**
 * The room under a random walk: people come and go, questions land under
 * repeated keys, the host seats and unseats, time moves, the wire loses and
 * repeats requests, and the room crashes once and resumes. Whatever the
 * walk, the record keeps its shape.
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
import { type FakeClock, fakeClock } from './support/clock.ts';
import { invariants } from './support/invariants.ts';
import { roomName } from './support/room.ts';
import {
	answersLastQuestion,
	byAgent,
	quiet,
	scripted,
	summarise,
	toolNames,
	toolResultTexts,
} from './support/scripted.ts';
import { memory } from './support/storage.ts';
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

const STEPS = ['visit', 'leave', 'deliver', 'seat', 'unseat', 'advance', 'fault', 'crash'] as const;
type Step = (typeof STEPS)[number];
const OPERATIONS: Operation[] = ['wake', 'steer', 'view', 'commit', 'lease'];

/** One walk: the room, the runtime it runs in, and what the walk did so far. */
class Walk {
	readonly events: SessionEvent[] = [];
	readonly log: string[] = [];
	readonly faults: Fault[] = [];
	readonly clock: FakeClock = fakeClock();
	readonly visits = new Map<string, Visit>();
	session!: Session;
	runtime!: Runtime;
	crashed = false;
	private lastKey: string | undefined;
	private deliveries = 0;

	constructor(
		readonly name: string,
		private readonly random: () => number,
		private readonly sessions: Awaited<ReturnType<typeof memory.open>>['sessions'],
	) {}

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
		if (step === 'seat') return this.session.seat(gamma).catch(() => {});
		if (step === 'unseat') return this.session.unseat(gamma).catch(() => {});
		if (step === 'advance') return this.clock.advance(Math.floor(this.random() * 70_000));
		if (step === 'fault') return this.fault();
		return this.crash();
	}

	private async visit(): Promise<void> {
		const person = this.pick(people);
		if (this.visits.has(person.name)) return;
		this.visits.set(person.name, await visitSession(this.session, person));
	}

	private async leave(): Promise<void> {
		const person = this.pick(names);
		const visit = this.visits.get(person);
		if (visit === undefined) return;
		this.visits.delete(person);
		await visit.leave();
	}

	private async deliver(): Promise<void> {
		const visit = this.pick([...this.visits.values()]);
		if (visit === undefined) return;
		// One delivery in ten repeats the last key: the host never learned whether it landed.
		const repeated = this.lastKey !== undefined && this.random() < 0.1;
		const key = repeated ? this.lastKey : `d${++this.deliveries}`;
		this.lastKey = key;
		this.log.push(`  ${visit.human.name} ${repeated ? 'repeats' : 'delivers'} ${key}`);
		await visit.deliver({ text: `Question ${key}?`, key: key as string }).catch(() => {});
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

	/** Once: the room is dropped from memory and resumed by a new host over the same log. */
	private async crash(): Promise<void> {
		if (this.crashed) return;
		this.crashed = true;
		this.runtime.evict(this.name);
		this.visits.clear();
		this.runtime = this.host();
		this.session = await resumeSession(this.name, {
			runtime: this.runtime,
			streamFn: scripted(script),
		});
		this.watch();
	}

	/** Time moves until nothing is live: every lease expires, every wake is sent again, every draft is due. */
	async drain(): Promise<void> {
		this.faults.length = 0;
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
				throw new Error(`seed ${seed} failed after:\n${walk.log.join('\n')}\n\n${detail}`, {
					cause: error,
				});
			}
		},
		30_000,
	);
});
