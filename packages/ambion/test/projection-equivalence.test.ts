/**
 * The incremental projection against the fold.
 *
 * A seeded walk writes journal entries straight at the fold layer: people
 * come and go, messages are directed at people, seats are seated and unseated, a summary lands long after its
 * close, a cancellation cuts running work, and new leases follow it. A seat
 * schedules a say, and the room returns one, possibly after an unseating or
 * a cancellation dropped it. After
 * every entry the projection that `advance` built must equal `foldRoom` over
 * the whole history. At a random cut the walk drops the projection and
 * rebuilds it with `replay`, as a resumed room does, and goes on. A state a
 * caller holds must never change under a later entry.
 *
 * `AMBION_SEEDS` widens the walk; the seed prints on failure.
 */
import { describe, expect, it } from 'vitest';
import type { Close, Composition, LeaseChange } from '../src/journal/events.ts';
import type { Entry } from '../src/journal/journal.ts';
import { foldRoom } from '../src/room/fold.ts';
import { advance, emptyProjection, projectState, replay } from '../src/room/projection.ts';
import { readView } from '../src/room/read.ts';
import { freeze, mulberry32 } from './support/core-failure.ts';

const SEEDS = Number(process.env.AMBION_SEEDS ?? 50);
const STEPS = 160;
const retry = { backoff: (attempt: number) => attempt * 30_000 };
const start = Date.parse('2026-01-01T09:00:00.000Z');
const PEOPLE = ['priya', 'sam'];
const SEATS = ['scout', 'writer', 'critic', 'extra'];

/** The walk: what it has written so far, and the random source. */
class Walk {
	readonly entries: Entry[] = [];
	private seq = 0;
	private lastThrough = 0;
	private readonly messages: number[] = [];
	private readonly closes: Close[] = [];
	private readonly leases: string[] = [];
	private readonly scheduledSays: { seq: number; seat: string }[] = [];

	constructor(private readonly random: () => number) {}

	private pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.random() * items.length)] as T;
	}

	private chance(p: number): boolean {
		return this.random() < p;
	}

	private at(): string {
		return new Date(start + this.seq * 1000).toISOString();
	}

	next(): Entry {
		const entry = this.build();
		this.entries.push(entry);
		return entry;
	}

	private build(): Entry {
		this.seq += 1;
		const r = this.random();
		if (r < 0.04) return { kind: 'run', seq: this.seq, body: { at: this.at(), format: 1 } };
		if (r < 0.09) return this.composition();
		if (r < 0.19) return this.presence();
		if (r < 0.36) return this.said();
		if (r < 0.42) return this.seating();
		if (r < 0.66) return this.lease();
		if (r < 0.74) return this.close() ?? this.said();
		if (r < 0.8) return this.summary() ?? this.said();
		if (r < 0.84) return this.cancel();
		if (r < 0.9) return this.returned();
		return this.said();
	}

	private message(body: Record<string, unknown>): Entry {
		this.messages.push(this.seq);
		return {
			kind: 'message',
			seq: this.seq,
			key: `k${this.seq}`,
			body: { at: this.at(), ...body },
		} as Entry;
	}

	private composition(): Entry {
		const seated = SEATS.filter(() => this.chance(0.5));
		const seat = (name: string) => ({
			name,
			identity: `${name}.`,
			attention: this.pick(['broadcast', 'named', 'presence'] as const),
		});
		const body: Composition = {
			version: 2,
			seq: 0,
			at: this.at(),
			agents: seated.map(seat),
			available: SEATS.filter((name) => !seated.includes(name)).map(seat),
			...(this.chance(0.7) ? { summary: this.pick(SEATS) } : {}),
		};
		return { kind: 'composition', seq: this.seq, body };
	}

	private presence(): Entry {
		const person = this.pick(PEOPLE);
		const kind = this.chance(0.6) ? 'arrived' : 'left';
		return this.message({ kind, from: person, subject: person, identity: `${person}.` });
	}

	private seating(): Entry {
		const subject = this.pick(SEATS);
		if (this.chance(0.5)) return this.message({ kind: 'unseated', subject });
		return this.message({
			kind: 'seated',
			subject,
			identity: `${subject}.`,
			attention: this.pick(['broadcast', 'named'] as const),
			...(this.chance(0.3) ? { fixed: this.chance(0.5) } : {}),
		});
	}

	/** A seat says to itself with `after`, stamped with the owner the room would give it. */
	private scheduled(): Entry {
		const seat = this.pick(SEATS);
		this.scheduledSays.push({ seq: this.seq, seat });
		return this.message({
			kind: 'said',
			from: seat,
			to: seat,
			text: 'Check later.',
			after: 1 + Math.floor(this.random() * 600),
			owner: this.pick(PEOPLE),
		});
	}

	/** The room returns a say: often a scheduled one, sometimes one that no longer waits. */
	private returned(): Entry {
		const say = this.scheduledSays.length ? this.pick(this.scheduledSays) : undefined;
		if (say === undefined) return this.scheduled();
		return this.message({
			kind: 'returned',
			to: say.seat,
			message: say.seq,
			owner: this.pick(PEOPLE),
			text: 'Check later.',
		});
	}

	private said(): Entry {
		if (this.chance(0.15)) return this.scheduled();
		const from = this.chance(0.55) ? this.pick(PEOPLE) : this.pick(SEATS);
		const wakes = SEATS.filter(() => this.chance(0.3));
		const to = this.chance(0.3) ? this.pick([...PEOPLE, ...SEATS]) : undefined;
		return this.message({
			kind: 'said',
			from,
			text: 'Words.',
			...(to === undefined ? {} : { to }),
			...(wakes.length ? { wakes } : {}),
		});
	}

	private change(): LeaseChange {
		const id = this.chance(0.6) && this.leases.length ? this.pick(this.leases) : this.newId();
		const readThrough = Math.floor(this.random() * this.seq);
		const at = this.at();
		if (this.chance(0.55))
			return { id, phase: 'running', expiresAt: start + this.seq * 2000, at, readThrough };
		const reason = this.pick(['released', 'failed', 'revoked', 'expired', 'abandoned'] as const);
		const cause = reason === 'failed' ? this.pick(['permanent', 'transient'] as const) : undefined;
		return { id, phase: 'ended', reason, at, readThrough, ...(cause ? { cause } : {}) };
	}

	private newId(): string {
		const seat = this.pick(SEATS);
		const attempt = 1 + Math.floor(this.random() * 3);
		const closing = this.closes.length > 0 && this.chance(0.35);
		const id = closing
			? `closed:${(this.pick(this.closes) as Close).through}:${seat}:${attempt}`
			: `message:${this.pick(this.messages.length ? this.messages : [1])}:${seat}:${attempt}`;
		this.leases.push(id);
		return id;
	}

	private lease(): Entry {
		return { kind: 'lease', seq: this.seq, body: this.change() };
	}

	/** A close names the range up to the last entry, and only ever moves forward. */
	private range(): Omit<Close, 'summary'> | undefined {
		const through = this.seq - 1;
		if (through <= this.lastThrough || this.messages.length === 0) return undefined;
		const from = this.pick(this.messages);
		return { owner: this.pick(PEOPLE), from, through, at: this.at() };
	}

	private close(): Entry | undefined {
		const range = this.range();
		if (range === undefined) return undefined;
		const body: Close = { ...range, ...(this.chance(0.8) ? { summary: this.pick(SEATS) } : {}) };
		this.lastThrough = body.through;
		this.closes.push(body);
		return { kind: 'close', seq: this.seq, body };
	}

	private cancel(): Entry {
		const range = this.chance(0.5) ? this.range() : undefined;
		if (range !== undefined) this.lastThrough = range.through;
		return {
			kind: 'cancel',
			seq: this.seq,
			body: { at: this.at(), ...(range ? { close: range } : {}) },
		};
	}

	/** A summary for an earlier close, possibly long after it. */
	private summary(): Entry | undefined {
		if (this.closes.length === 0) return undefined;
		const close = this.pick(this.closes);
		const covers = { from: close.from, through: close.through };
		return this.message({
			kind: 'summary',
			from: close.summary ?? this.pick(SEATS),
			to: this.chance(0.9) ? close.owner : this.pick(PEOPLE),
			text: 'Summary.',
			covers: this.chance(0.9) ? covers : { from: covers.from, through: covers.through + 1 },
		});
	}
}

describe('the incremental projection equals the fold', () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		it(`seed ${seed}`, () => {
			const random = mulberry32(seed);
			const walk = new Walk(random);
			const cut = 20 + Math.floor(random() * (STEPS - 40));
			let projection = emptyProjection();
			const retained: { state: ReturnType<typeof projectState>; snapshot: unknown }[] = [];
			for (let step = 0; step < STEPS; step++) {
				const entry = walk.next();
				freeze(entry);
				projection = advance(projection, entry, retry);
				const state = projectState(projection);
				const reference = foldRoom(walk.entries, retry);
				expect(state, `seed ${seed} step ${step} (${entry.kind})`).toEqual(reference);
				// The outcomes and the summaries of every closed exchange agree as well.
				const seen = readView('room', state, start, entry.seq, false);
				expect(seen.exchanges, `seed ${seed} step ${step} exchanges`).toEqual(
					readView('room', reference, start, entry.seq, false).exchanges,
				);
				retained.push({ state, snapshot: structuredClone(state) });
				freeze(state);
				if (step === cut) {
					// A restart: the resumed room replays the record and goes on.
					projection = replay(walk.entries, retry);
					expect(projectState(projection), `seed ${seed} replay`).toEqual(reference);
					expect(
						readView('room', projectState(projection), start, entry.seq, false).exchanges,
					).toEqual(readView('room', reference, start, entry.seq, false).exchanges);
				}
			}
			for (const held of retained) expect(held.state).toEqual(held.snapshot);
		});
	}
});
