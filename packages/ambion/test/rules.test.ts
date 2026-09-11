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
import { foldLeases } from '../src/room/lease.ts';
import { atWork, heard } from '../src/room/rules.verified.ts';
import type { LeaseChange } from '../src/wire.ts';

const at = '2026-01-01T09:00:00.000Z';
const running = (id: string, after: number): LeaseChange => ({
	id,
	after,
	phase: 'running',
	expiry: 60_000,
	at,
});
const ended = (id: string, after: number): LeaseChange => ({
	id,
	after,
	phase: 'ended',
	reason: 'released',
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
});
