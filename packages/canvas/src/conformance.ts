/**
 * The cases every `CanvasStore` must pass. A case is a name and a `run`
 * that throws when the store breaks the contract. The suite needs no test
 * framework: a runner names each case and awaits it.
 *
 * ```ts
 * describe.each(fixtures)('$name', (fixture) => {
 * 	for (const c of canvasStoreConformance(fixture)) it(c.name, c.run);
 * });
 * ```
 */
import type { CanvasClose, CanvasRoom, CanvasStore } from './store.ts';

/** One case a test runner names and awaits. It throws on failure. */
export interface ConformanceCase {
	readonly name: string;
	run(): Promise<void>;
}

/** The store a case writes to, and how the case releases it. */
export interface OpenedCanvasStore {
	readonly store: CanvasStore;
	dispose?(): void | Promise<void>;
}

/** A store under test. `open` runs inside every case and returns an empty store. */
export interface CanvasStoreFixture {
	readonly name: string;
	open(): OpenedCanvasStore | Promise<OpenedCanvasStore>;
}

const root = (name: string, state: CanvasRoom['state'] = 'running'): CanvasRoom => ({
	name,
	goal: `Goal of ${name}.`,
	depth: 0,
	state,
	start: { kind: 'root', agents: ['ada'], seating: false },
});

const breakout = (name: string, parent: string): CanvasRoom => ({
	name,
	goal: `Goal of ${name}.`,
	depth: 1,
	state: 'running',
	start: {
		kind: 'breakout',
		parent,
		opener: 'ada',
		agents: ['bea', 'cy'],
		message: 'Start.',
		to: 'bea',
	},
});

const done: CanvasClose = { result: 'done', note: 'Shipped.' };
const failed: CanvasClose = { result: 'failed' };

function same(actual: unknown, expected: unknown, what: string): void {
	const left = JSON.stringify(actual);
	const right = JSON.stringify(expected);
	if (left !== right) throw new Error(`${what}: expected ${right}, got ${left}`);
}

const namesOf = (rooms: readonly CanvasRoom[]) => rooms.map((room) => room.name);

/** Throws unless `action` rejects with an `Error` whose message names `room`. */
async function refuses(action: () => Promise<unknown>, room: string, what: string): Promise<void> {
	try {
		await action();
	} catch (error) {
		if (error instanceof Error && error.message.includes(`"${room}"`)) return;
		throw new Error(`${what}: the error does not name the room "${room}".`);
	}
	throw new Error(`${what}: the call did not throw.`);
}

type Body = (store: CanvasStore) => Promise<void>;

const cases: readonly (readonly [name: string, body: Body])[] = [
	[
		'starts empty',
		async (store) => {
			same(await store.list(), [], 'list of an empty store');
		},
	],
	[
		'inserts a row and lists it with every field',
		async (store) => {
			same(await store.insert(root('site')), 'inserted', 'insert of a free name');
			same(await store.list(), [root('site')], 'list after insert');
		},
	],
	[
		'keeps a breakout start and an archived row with its close',
		async (store) => {
			const archived: CanvasRoom = {
				...breakout('site-survey', 'site'),
				state: 'archived',
				close: done,
			};
			await store.insert(breakout('site-tests', 'site'));
			await store.insert(archived);
			same(await store.list(), [breakout('site-tests', 'site'), archived], 'list of both starts');
		},
	],
	[
		'lists rows in the order of insertion',
		async (store) => {
			for (const name of ['zeta', 'alpha', 'mid']) await store.insert(root(name));
			same(namesOf(await store.list()), ['zeta', 'alpha', 'mid'], 'order');
			await store.setState('zeta', 'stopped');
			same(namesOf(await store.list()), ['zeta', 'alpha', 'mid'], 'order after update');
		},
	],
	[
		'returns exists for a repeat insert and keeps the old row',
		async (store) => {
			await store.insert(root('site'));
			same(
				await store.insert({ ...root('site', 'stopped'), goal: 'Another goal.' }),
				'exists',
				'insert of a taken name',
			);
			same(await store.list(), [root('site')], 'list after the repeat');
		},
	],
	[
		'sets the state of a row in both directions',
		async (store) => {
			await store.insert(root('site'));
			await store.setState('site', 'stopped');
			same((await store.list())[0]?.state, 'stopped', 'state after stop');
			await store.setState('site', 'running');
			same((await store.list())[0]?.state, 'running', 'state after start');
		},
	],
	[
		'archives a running row and records the close',
		async (store) => {
			await store.insert(breakout('site-survey', 'site'));
			same(await store.archive('site-survey', done), done, 'close returned');
			same(
				await store.list(),
				[{ ...breakout('site-survey', 'site'), state: 'archived', close: done }],
				'list after archive',
			);
		},
	],
	[
		'archives a stopped row',
		async (store) => {
			await store.insert(root('site', 'stopped'));
			same(await store.archive('site', failed), failed, 'close returned');
			same((await store.list())[0], { ...root('site', 'archived'), close: failed }, 'row');
		},
	],
	[
		'returns the first close for a repeat archive and changes nothing',
		async (store) => {
			await store.insert(root('site'));
			await store.archive('site', done);
			same(await store.archive('site', failed), done, 'close of the repeat');
			same((await store.list())[0], { ...root('site', 'archived'), close: done }, 'row');
		},
	],
	[
		'refuses a state change of an archived row and keeps it archived',
		async (store) => {
			await store.insert(root('site'));
			await store.archive('site', done);
			await refuses(() => store.setState('site', 'running'), 'site', 'setState to running');
			await refuses(() => store.setState('site', 'stopped'), 'site', 'setState to stopped');
			same((await store.list())[0], { ...root('site', 'archived'), close: done }, 'row');
		},
	],
	[
		'refuses a missing name, and names the room',
		async (store) => {
			await refuses(() => store.setState('ghost', 'running'), 'ghost', 'setState');
			await refuses(() => store.archive('ghost', done), 'ghost', 'archive');
			same(await store.list(), [], 'list after the refusals');
		},
	],
];

/** The cases of one fixture. Each case opens an empty store, runs, and disposes it. */
export function canvasStoreConformance(fixture: CanvasStoreFixture): readonly ConformanceCase[] {
	return cases.map(([name, body]) => ({
		name,
		async run() {
			const opened = await fixture.open();
			try {
				await body(opened.store);
			} finally {
				await opened.dispose?.();
			}
		},
	}));
}
