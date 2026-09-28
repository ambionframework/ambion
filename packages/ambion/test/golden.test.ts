import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/journal/journal.ts';
import { projectState, replay } from '../src/room/projection.ts';
import { readView } from '../src/room/read.ts';
import type { ExchangeView, RoomRead } from '../src/types.ts';
import { goldenScenarios } from './support/golden.ts';

/**
 * Golden journals: journals the runtime wrote, each with the fold a reader
 * must derive from it. A later runtime replays the same file and reads the
 * same fold. The suite also runs each scenario again, and the runtime must
 * write the same journal, so a fixture that no runtime writes any more
 * fails. `GOLDEN=write pnpm --filter @ambionframework/ambion exec vitest run
 * test/golden.test.ts` writes them again.
 */
const dir = fileURLToPath(new URL('./golden/', import.meta.url));
const REGENERATE =
	'Run "GOLDEN=write pnpm --filter @ambionframework/ambion exec vitest run test/golden.test.ts" and review the diff.';
const now = Date.parse('2026-01-01T09:30:00.000Z');
const backoff = () => 0;

const load = async <T>(file: string): Promise<T> =>
	JSON.parse(await readFile(`${dir}${file}`, 'utf8')) as T;

function foldOf(entries: readonly Entry[]): RoomRead {
	const state = projectState(replay(entries, { backoff }));
	return readView('golden', state, now, entries.length, false);
}

const json = (value: unknown) => `${JSON.stringify(value, null, '\t')}\n`;

/**
 * The runtime makes run ids and idempotency keys from random numbers. The
 * fixture names them in order of first use, so a regeneration writes the
 * same bytes.
 */
function named(entries: readonly Entry[]): Entry[] {
	const runs = new Map<string, string>();
	const keys = new Map<string, string>();
	const rename = (table: Map<string, string>, prefix: string, value: string) => {
		const found = table.get(value) ?? `${prefix}-${table.size + 1}`;
		table.set(value, found);
		return found;
	};
	return entries.map((entry) => {
		const { key, run } = entry as { key?: string; run: string };
		return {
			...entry,
			...(key === undefined ? {} : { key: rename(keys, 'key', key) }),
			run: rename(runs, 'run', run),
		} as Entry;
	});
}

/** The journal that a scenario writes now, with its runs and keys named. */
const written = async (run: () => Promise<readonly unknown[]>): Promise<Entry[]> =>
	named((await run()) as readonly Entry[]);

if (process.env.GOLDEN === 'write') {
	it('writes the golden journals', async () => {
		await mkdir(dir, { recursive: true });
		for (const [name, run] of Object.entries(goldenScenarios)) {
			const entries = await written(run);
			await writeFile(`${dir}${name}.journal.json`, json(entries));
			await writeFile(`${dir}${name}.fold.json`, json(foldOf(entries)));
		}
	}, 60_000);
} else {
	const names = Object.keys(goldenScenarios);
	const outcomes = (read: RoomRead) =>
		read.exchanges.map((exchange: ExchangeView) =>
			exchange.status === 'closed' ? exchange.outcome.kind : exchange.status,
		);

	describe('golden journals', () => {
		it('holds one fixture pair for each scenario', async () => {
			const files = (await readdir(dir)).sort();
			expect(files).toEqual(names.flatMap((n) => [`${n}.fold.json`, `${n}.journal.json`]).sort());
		});

		it.each(Object.entries(goldenScenarios))('writes %s again as committed', async (name, run) => {
			const committed = await load<Entry[]>(`${name}.journal.json`);
			expect(JSON.parse(JSON.stringify(await written(run))), REGENERATE).toEqual(committed);
		});

		it.each(names)('replays %s to the committed fold', async (name) => {
			const entries = await load<Entry[]>(`${name}.journal.json`);
			const expected = await load<RoomRead>(`${name}.fold.json`);
			expect(JSON.parse(JSON.stringify(foldOf(entries))), REGENERATE).toEqual(expected);
		});

		it('covers every exchange outcome and every entry kind', async () => {
			const kinds = new Set<string>();
			const seen = new Set<string>();
			for (const name of names) {
				const entries = await load<Entry[]>(`${name}.journal.json`);
				for (const entry of entries) kinds.add(entry.kind);
				for (const outcome of outcomes(foldOf(entries))) seen.add(outcome);
			}
			expect([...seen].sort()).toEqual(['awaiting', 'cancelled', 'complete', 'exhausted']);
			expect([...kinds].sort()).toEqual([
				'cancel',
				'close',
				'composition',
				'lease',
				'message',
				'run',
			]);
		});

		it('writes the time alone on every fence, and two fences after a resume', async () => {
			const entries = await load<Entry[]>('resumed.journal.json');
			const fences = entries.filter((entry) => entry.kind === 'run');
			expect(fences).toHaveLength(2);
			for (const fence of fences) expect(Object.keys(fence.body)).toEqual(['at']);
		});

		it('records a session on each ended activation, and keeps it inside one exchange', async () => {
			const entries = await load<Entry[]>('session.journal.json');
			const ended = entries.flatMap((entry) =>
				entry.kind === 'lease' && entry.body.phase === 'ended' ? [entry.body] : [],
			);
			for (const change of ended) expect(change.session?.harness).toBe('pi');
			const [first = [], second = []] = foldOf(entries).exchanges.map((exchange) =>
				exchange.activations.flatMap((activation) =>
					activation.seat === 'worker' ? [activation.session?.id] : [],
				),
			);
			expect(first.length).toBeGreaterThanOrEqual(2);
			expect(new Set(first).size).toBe(1);
			expect(second).toHaveLength(1);
			expect(second).not.toContain(first[0]);
		});
	});
}
