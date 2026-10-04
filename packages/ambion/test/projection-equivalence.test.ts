/**
 * The incremental projection against the oracle fold in `support/fold.ts`.
 *
 * A seeded walk writes journal entries straight at the fold layer: people
 * come and go, messages are directed at people, seats are seated and unseated, a summary lands long after its
 * close, a cancellation cuts running work, and new leases follow it. A seat
 * schedules a say. The room returns it, or the seat or the host dismisses
 * it, possibly after an unseating or a cancellation dropped it. After
 * every entry the projection that `advance` built must equal `foldRoom` over
 * the whole history. At a random cut the walk drops the projection and
 * rebuilds it with `replay`, as a resumed room does, and goes on. A state a
 * caller holds must never change under a later entry.
 *
 * `AMBION_SEEDS` widens the walk; the seed prints on failure.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Close, Composition, Lease } from '../src/journal/entries.ts';
import type { RoomEntry } from '../src/journal/journal.ts';
import { seatAuthority } from '../src/room/activation.ts';
import type { RoomState } from '../src/room/fold.ts';
import { advance, emptyProjection, projectState, replay } from '../src/room/projection.ts';
import { toRoomRead } from '../src/room/read.ts';
import {
	copyMessage,
	isSaid,
	type MessageSnapshot,
	type SaidMessage,
	type SummaryMessage,
} from '../src/types.ts';
import { freeze, mulberry32 } from './support/core-failure.ts';
import { foldRoom } from './support/fold.ts';

const SEEDS = Number(process.env.AMBION_SEEDS ?? 50);
const STEPS = 160;
const retry = { backoff: (attempt: number) => attempt * 30_000 };
const start = Date.parse('2026-01-01T09:00:00.000Z');
const PEOPLE = ['priya', 'sam'];
const SEATS = ['scout', 'writer', 'critic', 'extra'];

/** The walk: what it has written so far, and the random source. */
class Walk {
	readonly entries: RoomEntry[] = [];
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

	next(): RoomEntry {
		const entry = this.build();
		this.entries.push(entry);
		return entry;
	}

	private build(): RoomEntry {
		this.seq += 1;
		const r = this.random();
		if (r < 0.04) return { kind: 'run', seq: this.seq, body: { at: this.at() } };
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

	private message(body: Record<string, unknown>): RoomEntry {
		this.messages.push(this.seq);
		return {
			kind: 'message',
			seq: this.seq,
			key: `k${this.seq}`,
			body: { at: this.at(), ...body },
		} as RoomEntry;
	}

	private composition(): RoomEntry {
		const seated = SEATS.filter(() => this.chance(0.5));
		const seat = (name: string) => ({
			name,
			identity: `${name}.`,
			attention: this.pick(['broadcast', 'named', 'presence'] as const),
		});
		const body: Composition = {
			seq: 0,
			at: this.at(),
			seated: seated.map(seat),
			reserve: SEATS.filter((name) => !seated.includes(name)).map(seat),
			...(this.chance(0.7) ? { summaryWriter: this.pick(SEATS) } : {}),
		};
		return { kind: 'composition', seq: this.seq, body };
	}

	private presence(): RoomEntry {
		const person = this.pick(PEOPLE);
		const kind = this.chance(0.6) ? 'arrived' : 'left';
		return this.message({ kind, from: person, subject: person, identity: `${person}.` });
	}

	private seating(): RoomEntry {
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

	/** A seat schedules a say to itself, stamped with the owner the room would give it. */
	private scheduled(): RoomEntry {
		const seat = this.pick(SEATS);
		this.scheduledSays.push({ seq: this.seq, seat });
		return this.message({
			kind: 'said',
			from: seat,
			to: seat,
			text: 'Check later.',
			after: 1 + Math.floor(this.random() * 600),
			person: this.pick(PEOPLE),
		});
	}

	/**
	 * The room returns a say, or its seat or the host dismisses it: often a
	 * scheduled one, sometimes one that no longer waits.
	 */
	private returned(): RoomEntry {
		const say = this.scheduledSays.length ? this.pick(this.scheduledSays) : undefined;
		if (say === undefined) return this.scheduled();
		if (this.chance(0.3))
			return this.message({
				kind: 'dismissed',
				message: say.seq,
				...(this.chance(0.5) ? { from: say.seat, activation: `message:1:${say.seat}:1` } : {}),
			});
		return this.message({
			kind: 'posted',
			to: say.seat,
			returns: say.seq,
			text: 'Check later.',
		});
	}

	private said(): RoomEntry {
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

	private change(): Lease {
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

	private lease(): RoomEntry {
		return { kind: 'lease', seq: this.seq, body: this.change() };
	}

	/** A close names the range up to the last entry, and only ever moves forward. */
	private range(): { person: string; from: number; through: number; at: string } | undefined {
		const through = this.seq - 1;
		if (through <= this.lastThrough || this.messages.length === 0) return undefined;
		const from = this.pick(this.messages);
		return { person: this.pick(PEOPLE), from, through, at: this.at() };
	}

	private close(): RoomEntry | undefined {
		const range = this.range();
		if (range === undefined) return undefined;
		const body: Close = this.chance(0.8) ? { ...range, summaryWriter: this.pick(SEATS) } : range;
		this.lastThrough = body.through;
		this.closes.push(body);
		return { kind: 'close', seq: this.seq, body };
	}

	/** A cancellation closes the exchange it finds open, at the last message before it. */
	private cancel(): RoomEntry {
		return { kind: 'cancel', seq: this.seq, body: { at: this.at() } };
	}

	/** A summary for an earlier close, possibly long after it. */
	private summary(): RoomEntry | undefined {
		if (this.closes.length === 0) return undefined;
		const close = this.pick(this.closes);
		const covers = { from: close.from, through: close.through };
		return this.message({
			kind: 'summary',
			from: close.summaryWriter ?? this.pick(SEATS),
			to: this.chance(0.9) ? close.person : this.pick(PEOPLE),
			text: 'Summary.',
			covers: this.chance(0.9) ? covers : { from: covers.from, through: covers.through + 1 },
		});
	}
}

/** The compiler rejects changes to shared containers and records. These functions never run. */
function rejectContainerChanges(state: RoomState, entry: RoomEntry): void {
	// @ts-expect-error A consumer cannot clear the people index.
	state.people.clear();
	// @ts-expect-error A consumer cannot delete a lease.
	state.leases.delete('message:1:scout:1');
	// @ts-expect-error A consumer cannot replace a delivery.
	state.deliveries.set(1, { wakes: [], steers: [] });
	// @ts-expect-error A consumer cannot append a seat.
	state.roster.push({ name: 'extra', identity: '', attention: 'broadcast' });
	// @ts-expect-error A consumer cannot clear the reserve.
	state.reserve.length = 0;
	// @ts-expect-error A consumer cannot remove a close.
	state.closes.pop();
	// @ts-expect-error A consumer cannot remove due work.
	state.due.splice(0, 1);
	// @ts-expect-error A consumer cannot append a message.
	state.messages.push({ kind: 'posted', text: '', seq: 1, at: '' });
	// @ts-expect-error A consumer cannot reorder scheduled says.
	state.scheduled.reverse();
	// @ts-expect-error Only replay can select the owned step.
	advance(emptyProjection(), entry, retry, true);
}

function rejectRecordChanges(state: RoomState): void {
	const composition = state.composition;
	if (composition !== undefined) {
		// @ts-expect-error A consumer cannot change the composition.
		composition.goal = 'Changed';
		// @ts-expect-error A consumer cannot remove a configured seat.
		composition.seated.pop();
		const configured = composition.reserve[0];
		// @ts-expect-error A consumer cannot rename a configured reserve seat.
		if (configured !== undefined) configured.name = 'Changed';
	}
	const seat = state.roster[0];
	// @ts-expect-error A consumer cannot change a shared seat.
	if (seat !== undefined) seat.attention = 'none';
	const person = state.people.get('priya');
	// @ts-expect-error A consumer cannot change a shared person.
	if (person !== undefined) person.presence = 'absent';
	const close = state.closes[0];
	// @ts-expect-error A consumer cannot change a shared close.
	if (close !== undefined) close.through = 100;
	const due = state.due[0];
	// @ts-expect-error A consumer cannot change shared due work.
	if (due !== undefined) due.attempt = 100;
	const lease = state.leases.get('message:1:scout:1');
	if (lease !== undefined) {
		// @ts-expect-error A consumer cannot change a shared lease.
		lease.readThrough = 100;
		// @ts-expect-error A consumer cannot change the lease's activation.
		lease.activation.seat = 'Changed';
		// @ts-expect-error A consumer cannot change recorded usage.
		if (lease.usage !== undefined) lease.usage.input = 100;
		// @ts-expect-error A consumer cannot change a recorded vendor session.
		if (lease.session !== undefined) lease.session.id = 'Changed';
	}
	const authority = seatAuthority(state, 'message:1:scout:1', start);
	// @ts-expect-error A decision cannot change the lease through the authority view.
	if (!('stale' in authority)) authority.lease.readThrough = 100;
}

function rejectMessageChanges(state: RoomState): void {
	const message = state.messages[0];
	if (message !== undefined) {
		// @ts-expect-error A consumer cannot change a shared message.
		message.at = 'Changed';
		// @ts-expect-error A consumer cannot change a message's wakes.
		message.wakes?.push('extra');
		if (message.kind === 'summary') {
			expectTypeOf(copyMessage(message)).toEqualTypeOf<SummaryMessage>();
			// @ts-expect-error A consumer cannot change a summary's range.
			message.covers.through = 100;
		}
		if (isSaid(message)) {
			expectTypeOf(message).toEqualTypeOf<MessageSnapshot<SaidMessage>>();
			// @ts-expect-error A consumer cannot change a message's refs.
			message.refs?.push('https://changed.example');
		}
	}
	const scheduled = state.scheduled[0];
	// @ts-expect-error A consumer cannot change a scheduled say's refs.
	if (scheduled !== undefined) scheduled.refs?.push('https://changed.example');
	const delivery = state.deliveries.get(1);
	if (delivery !== undefined) {
		// @ts-expect-error A consumer cannot change delivery wakes.
		delivery.wakes.push('extra');
		// @ts-expect-error A consumer cannot replace a delivery steer.
		delivery.steers[0] = { seat: 'extra', activation: 'message:1:extra:1' };
		const steer = delivery.steers[0];
		// @ts-expect-error A consumer cannot change a delivery steer.
		if (steer !== undefined) steer.activation = 'Changed';
	}
}

it('types shared room snapshots as read-only', () => {
	expectTypeOf(rejectContainerChanges).returns.toBeVoid();
	expectTypeOf(rejectRecordChanges).returns.toBeVoid();
	expectTypeOf(rejectMessageChanges).returns.toBeVoid();
	expectTypeOf<
		MessageSnapshot<SaidMessage & { refs: ['reference']; text: 'Words.' }>
	>().toMatchTypeOf<{ readonly refs: readonly ['reference']; readonly text: 'Words.' }>();
});

it('shares untouched containers when a replayed projection advances', () => {
	const arrived: RoomEntry = {
		kind: 'message',
		seq: 1,
		body: {
			kind: 'arrived',
			subject: 'priya',
			identity: 'Priya.',
			at: new Date(start).toISOString(),
		},
	};
	const posted: RoomEntry = {
		kind: 'message',
		seq: 2,
		body: {
			kind: 'posted',
			text: 'Start.',
			wakes: ['scout'],
			refs: ['https://example.com'],
			at: new Date(start).toISOString(),
		},
	};
	const lease: RoomEntry = {
		kind: 'lease',
		seq: 3,
		body: {
			id: 'message:2:scout:1',
			phase: 'running',
			expiresAt: start + 1000,
			readThrough: 2,
			at: new Date(start).toISOString(),
		},
	};
	const before = replay([arrived, posted], retry);
	const held = projectState(before);
	const snapshot = structuredClone(held);
	const after = advance(before, lease, retry);
	const next = projectState(after);
	expect(next.leases).not.toBe(held.leases);
	expect(next.leases.size).toBe(1);
	expect(next.messages).toBe(held.messages);
	expect(next.people).toBe(held.people);
	expect(next.roster).toBe(held.roster);
	expect(next.closes).toBe(held.closes);
	expect(next.deliveries).toBe(held.deliveries);
	expect(held).toEqual(snapshot);
	expect(next).toEqual(foldRoom([arrived, posted, lease], retry));
});

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
				const seen = toRoomRead('room', state, start, entry.seq, false);
				expect(seen.exchanges, `seed ${seed} step ${step} exchanges`).toEqual(
					toRoomRead('room', reference, start, entry.seq, false).exchanges,
				);
				retained.push({ state, snapshot: structuredClone(state) });
				freeze(state);
				if (step === cut) {
					// A restart: the resumed room replays the record and goes on.
					projection = replay(walk.entries, retry);
					expect(projectState(projection), `seed ${seed} replay`).toEqual(reference);
					expect(
						toRoomRead('room', projectState(projection), start, entry.seq, false).exchanges,
					).toEqual(toRoomRead('room', reference, start, entry.seq, false).exchanges);
				}
			}
			for (const held of retained) expect(held.state).toEqual(held.snapshot);
		});
	}
});
