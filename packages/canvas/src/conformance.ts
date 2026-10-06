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
import type { BreakoutStart, CanvasClose, CanvasRoom, CanvasStore, CanvasWidget } from './store.ts';

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
	start: {
		kind: 'root',
		agents: ['ada', 'max'],
		seats: { ada: 'broadcast' },
		assistant: 'max',
		summaryWriter: 'max',
		seating: false,
	},
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

/** A breakout row with no `to`: the start message goes to every worker. */
const toAll = (name: string, parent: string): CanvasRoom => {
	const { to: _to, ...start } = breakout(name, parent).start as BreakoutStart;
	return { ...breakout(name, parent), start };
};

const widget = (
	revision: string,
	rev: number,
	extra: Partial<CanvasWidget> = {},
): CanvasWidget => ({
	room: 'site',
	name: 'status',
	revision,
	rev,
	state: 'shown',
	kind: 'frame',
	source: { type: 'process', handle: 'bash-1', path: '/status' },
	title: 'Status',
	author: 'observer',
	actions: [],
	...extra,
});

const done: CanvasClose = { result: 'done', note: 'Shipped.' };
const failed: CanvasClose = { result: 'failed' };

/** JSON with the keys of each object in order, so key order is not a difference. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item !== null && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
			: item,
	);
}

function same(actual: unknown, expected: unknown, what: string): void {
	const left = canonical(actual);
	const right = canonical(expected);
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
		'keeps breakout starts and an archived row with its close',
		async (store) => {
			const archived: CanvasRoom = {
				...breakout('site-survey', 'site'),
				state: 'archived',
				close: done,
			};
			await store.insert(breakout('site-tests', 'site'));
			await store.insert(toAll('site-docs', 'site'));
			await store.insert(archived);
			same(
				await store.list(),
				[breakout('site-tests', 'site'), toAll('site-docs', 'site'), archived],
				'list of the starts',
			);
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
	[
		'starts with no widget revision',
		async (store) => {
			same(await store.revisions(), [], 'revisions of an empty store');
		},
	],
	[
		'appends revisions and lists them in the order of insertion, with every field',
		async (store) => {
			const first = widget('r-2', 1);
			const second = widget('r-1', 2, { state: 'hidden' });
			const third = widget('r-3', 1, {
				room: 'site-survey',
				name: 'plan',
				kind: 'markdown',
				source: { type: 'file', path: '/plan.md' },
				actions: [
					{
						id: 'keep',
						label: 'Keep',
						once: true,
						fields: [
							{ name: 'note', label: 'Note', type: 'text' },
							{ name: 'size', label: 'Size', type: 'number', min: 1, max: 9 },
							{ name: 'loud', label: 'Loud', type: 'boolean' },
							{ name: 'mode', label: 'Mode', type: 'choice', options: ['a', 'b'] },
						],
					},
				],
				for: 'mira',
			});
			const fourth = widget('r-4', 1, { name: 'proof', source: { type: 'snapshot', ref: 's1' } });
			const bare = widget('r-5', 1, { name: 'bare', kind: 'text' });
			const { source: _source, title: _title, ...plain } = bare;
			for (const one of [first, second, third, fourth, plain])
				same(await store.appendRevision(one), 'inserted', 'append of a new id');
			same(await store.revisions(), [first, second, third, fourth, plain], 'revisions');
		},
	],
	[
		'returns exists for a repeat revision id and keeps the old revision',
		async (store) => {
			await store.appendRevision(widget('r-1', 1));
			same(
				await store.appendRevision(widget('r-1', 2, { state: 'hidden' })),
				'exists',
				'append of a taken id',
			);
			same(await store.revisions(), [widget('r-1', 1)], 'revisions after the repeat');
		},
	],
	[
		'keeps widget revisions apart from the room rows',
		async (store) => {
			await store.insert(root('site'));
			await store.appendRevision(widget('r-1', 1));
			await store.archive('site', done);
			same(namesOf(await store.list()), ['site'], 'rows');
			same(await store.revisions(), [widget('r-1', 1)], 'revisions after an archive');
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
