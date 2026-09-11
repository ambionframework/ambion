/**
 * The rules the room decides by, checked against the cases the callers
 * actually produce.
 *
 * Dafny proves each contract in `rules.verified.ts`. These tests hold the
 * rules to the one fact a contract cannot state: the shape of the arguments
 * `foldLeases` builds. `heard` reads `until` alone, and that is sound only
 * while every lease keeps `until >= since`.
 */
import { describe, expect, it } from 'vitest';
import { cameToNothing, foldLeases, pendingWakes } from '../src/room/lease.ts';
import { atWork, heard } from '../src/room/rules.verified.ts';
import type { Message } from '../src/types.ts';
import type { EndReason, LeaseChange } from '../src/wire.ts';

const at = '2026-01-01T09:00:00.000Z';
const running = (id: string, after: number): LeaseChange => ({
	id,
	after,
	phase: 'running',
	expiry: 60_000,
	at,
});
const ended = (id: string, after: number, reason: EndReason = 'released'): LeaseChange => ({
	id,
	after,
	phase: 'ended',
	reason,
	at,
});

/**
 * What `heard` said before it read `until` alone. The two agree for every
 * lease `foldLeases` builds, and this is the formula that says so.
 */
const heardOverSince = (
	liveOrFailed: boolean,
	since: number,
	isEnded: boolean,
	until: number,
	heardThrough: number,
	seq: number,
): boolean =>
	liveOrFailed ? atWork(since, isEnded, until, seq) || since >= seq : seq <= heardThrough;

/** Every lease shape `foldLeases` can build, over a small range of seqs. */
interface Case {
	liveOrFailed: boolean;
	since: number;
	isEnded: boolean;
	until: number;
	seq: number;
}

function cases(): Case[] {
	const out: Case[] = [];
	const flags = [true, false];
	for (let since = 0; since <= 6; since += 1) {
		// `foldLeases` never builds a lease whose end lands before its first entry.
		for (let until = since; until <= 6; until += 1) {
			for (let seq = 0; seq <= 7; seq += 1) {
				for (const liveOrFailed of flags) {
					for (const isEnded of flags) out.push({ liveOrFailed, since, isEnded, until, seq });
				}
			}
		}
	}
	return out;
}

describe('heard', () => {
	it('agrees with the rule it replaced, for every lease that keeps until >= since', () => {
		const disagreed = cases().filter(
			({ liveOrFailed, since, isEnded, until, seq }) =>
				heard(liveOrFailed, isEnded, until, since, seq) !==
				heardOverSince(liveOrFailed, since, isEnded, until, since, seq),
		);
		expect(disagreed).toEqual([]);
	});

	it('hears an entry that landed before the lease claimed, because its view held it', () => {
		// since = 4, until = 6, and the entry at 2 landed before the claim
		expect(heard(true, true, 6, 4, 2)).toBe(true);
		// the entry past the end reached no activation
		expect(heard(true, true, 6, 4, 7)).toBe(false);
	});

	it('hears through the last renewal for a lease that stood down', () => {
		expect(heard(false, true, 6, 4, 4)).toBe(true);
		expect(heard(false, true, 6, 4, 5)).toBe(false);
	});
});

describe('foldLeases', () => {
	it('holds every lease to until >= since, which is what lets heard read until alone', () => {
		const leases = foldLeases([
			running('2:solo', 2),
			running('2:solo', 3),
			ended('2:solo', 5),
			running('9:other', 9),
		]);
		for (const lease of leases.values()) {
			if (lease.until === undefined) continue;
			expect(lease.until).toBeGreaterThanOrEqual(lease.since);
		}
		expect(leases.get('2:solo')).toMatchObject({ since: 2, until: 5, heardThrough: 3 });
	});

	it('keeps until >= since for a lease a checkpoint carried, which ends later', () => {
		// The checkpoint holds the claim; the end lands after it. `since` comes
		// off the checkpoint, and `until` off the change, so the fold must still
		// order them.
		const held = foldLeases([running('2:solo', 2), running('2:solo', 3)]);
		const carried = [...held.values()];
		const leases = foldLeases([ended('2:solo', 5)], carried);
		const lease = leases.get('2:solo');
		expect(lease).toMatchObject({ since: 2, until: 5, heardThrough: 3 });
		expect(lease?.until).toBeGreaterThanOrEqual(lease?.since ?? 0);
	});
});

describe('the two questions a lease answers', () => {
	const spoken = (seq: number): Message => ({
		kind: 'said',
		seq,
		from: 'priya',
		text: 'When is the pour?',
		wakes: ['solo'],
		at,
	});
	const options = { backoff: () => 1_000 };

	/**
	 * One lease over the message at seq 2: it claimed, renewed at 4, and ended
	 * at 8. The message at seq 6 landed between the renewal and the end, so
	 * what the lease answers decides whether that message is still pending.
	 */
	const pendingIds = (reason: EndReason) =>
		pendingWakes(
			[spoken(2), spoken(6)],
			foldLeases([running('2:solo', 2), running('2:solo', 4), ended('2:solo', 8, reason)]),
			new Set(['solo']),
			options,
			'assistant',
		).map((wake) => wake.id);

	it('counts a refused attempt, and still answers only through the last renewal', () => {
		// A message never ends an activation `refused` today. The rule holds all
		// the same: the attempt counts, and the lease answers what it confirmed.
		const refused = foldLeases([running('c', 2), ended('c', 3, 'refused')]).get('c');
		expect(refused && cameToNothing(refused)).toBe(true);
		// seq 2 is answered; seq 6 landed past the last renewal and reached nobody.
		expect(pendingIds('refused')).toEqual(['6:solo']);
	});

	it('leaves every message pending when the lease answered nothing', () => {
		for (const reason of ['failed', 'expired'] as const) {
			expect(pendingIds(reason)).toEqual(['2:solo:2', '6:solo:2']);
		}
	});

	it('answers through the last renewal when the lease stood down', () => {
		for (const reason of ['released', 'revoked'] as const) {
			expect(pendingIds(reason)).toEqual(['6:solo']);
		}
	});
});
