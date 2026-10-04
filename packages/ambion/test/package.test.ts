/**
 * The package's two entries, and what each one names. `index.ts` is what an
 * application needs to build a room. `hosting.ts` is the wire between a room
 * and a seat, and everything beyond the application view a host needs from a
 * `Runtime`, for a host that runs the two apart.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, expectTypeOf, it } from 'vitest';
import * as conformance from '../src/conformance.ts';
import * as hosting from '../src/hosting.ts';
import * as main from '../src/index.ts';
import { PACKAGE_NAME, type Seq } from '../src/index.ts';
import * as names from '../src/names.ts';

const read = async (name: string) =>
	readFile(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

const manifest = async () =>
	JSON.parse(await read('package.json')) as {
		name: string;
		exports: Record<string, { import?: string } | string>;
	};

it('keeps the exported package name in step with the manifest', async () => {
	expect(PACKAGE_NAME).toBe((await manifest()).name);
});

it('builds every entry the manifest names', async () => {
	const { exports } = await manifest();
	const config = await read('tsdown.config.ts');
	const built = [...config.matchAll(/'(src\/[^']+)'/g)].map((m) => m[1]);
	expect(built).toEqual([
		'src/index.ts',
		'src/hosting.ts',
		'src/conformance.ts',
		'src/testing.ts',
		'src/names.ts',
	]);
	// Each subpath names a file the build writes, under the name it builds it by.
	for (const [path, target] of Object.entries(exports)) {
		if (path === './package.json') continue;
		const file = typeof target === 'string' ? target : target.import;
		const stem = path === '.' ? 'index' : path.slice(2);
		expect(file).toBe(`./dist/${stem}.mjs`);
		expect(built).toContain(`src/${stem}.ts`);
	}
});

it('exports exactly what an application needs to build a room, and nothing a host needs beyond it', () => {
	expect(Object.keys(main).sort()).toEqual([
		'AmbionError',
		'COMPOSE_GUIDANCE',
		'DEFAULT_SPEAKING',
		'PACKAGE_NAME',
		'REF_LIMITS',
		'addUsage',
		'awaitingFor',
		'commitUri',
		'composeMacro',
		'contentText',
		'createRuntime',
		'defaultRuntime',
		'defineAgent',
		'definePerson',
		'defineTool',
		'isPosted',
		'isPresence',
		'isSaid',
		'isSummary',
		'loggedToolResult',
		'messageUri',
		'parseCommitUri',
		'parseRoomUri',
		'parseSnapshotUri',
		'readExchange',
		'readRoom',
		'resumeRoom',
		'roomUri',
		'snapshotUri',
		'startRoom',
		'systemClock',
	]);
});

it('exports exactly the wire and the hosting escape hatch, and nothing an application already has', () => {
	expect(Object.keys(hosting).sort()).toEqual([
		'AgentRunner',
		'PermanentError',
		'ROOM_SERVER',
		'classifyCause',
		'defineExecution',
		'describeExecutor',
		'executorOfKind',
		'failedPass',
		'hostingOf',
		'invokeChecked',
		'invokeTool',
		'localExecution',
		'pickPresent',
		'present',
		'providerMessage',
		'runningRoom',
		'toolContext',
		'visitOf',
	]);
	for (const name of Object.keys(main)) {
		expect(hosting).not.toHaveProperty(name);
	}
});

it('exports exactly the conformance suites, their shared parts, and the in-process executor', () => {
	expect(Object.keys(conformance).sort()).toEqual([
		'check',
		'composeRuntimeConformance',
		'conformanceSuite',
		'executorConformance',
		'portConformance',
		'speakOnce',
	]);
});

it('names the ports, the reads, and the visit by their final names', () => {
	expectTypeOf<hosting.AgentPort>().toHaveProperty('wake');
	expectTypeOf<hosting.RoomProtocol>().toHaveProperty('view');
	expectTypeOf<hosting.SeatContext>().toHaveProperty('opener');
	expectTypeOf<main.Visit['lastDeparture']>().toEqualTypeOf<Seq | undefined>();
	expectTypeOf<
		Extract<
			hosting.ActivationView['context']['participants'][number],
			{ kind: 'person' }
		>['messagesSinceDeparture']
	>().toEqualTypeOf<number>();
	expectTypeOf<Awaited<ReturnType<typeof main.readExchange>>>().toEqualTypeOf<
		main.ExchangeRead | undefined
	>();
	expectTypeOf<Awaited<ReturnType<typeof main.readRoom>>>().toEqualTypeOf<main.RoomRead>();
	expectTypeOf<main.ExchangeRead['exchange']>().toEqualTypeOf<main.Exchange>();
	expectTypeOf<main.RoomRead['through']>().toEqualTypeOf<Seq>();
	expectTypeOf<
		Extract<main.RoomEvent, { type: 'exchange_closed' }>['exchange']
	>().toEqualTypeOf<main.ExchangeRange>();
	expectTypeOf<main.StartRoomOptions>().toHaveProperty('execution');
	expectTypeOf<main.StartRoomOptions>().not.toHaveProperty('stream');
	expectTypeOf<main.VendorSession>().toEqualTypeOf<hosting.VendorSession>();
	expectTypeOf<hosting.ActivationSpec['resume']>().toEqualTypeOf<main.VendorSession | undefined>();
	expectTypeOf<hosting.RunningActivation['session']>().toEqualTypeOf<string | undefined>();
	// The room windows the record: a view names one message at most, and a seat names its estimator.
	expectTypeOf<Parameters<hosting.RoomProtocol['view']>>().toEqualTypeOf<
		[activation: string, message?: Seq]
	>();
	expectTypeOf<hosting.ActivationView['context']>().not.toHaveProperty('earliest');
	expectTypeOf<main.Executor['estimateTokens']>().toEqualTypeOf<string | undefined>();
	expectTypeOf<main.CreateRuntimeOptions>().toHaveProperty('estimators');
});

/** The specifiers one built file imports, whatever the quote or the form. */
const importsOf = (code: string): string[] =>
	[...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');

it('names no model library: the manifest lists none, and no source file imports one', async () => {
	const {
		dependencies = {},
		peerDependencies = {},
		optionalDependencies = {},
	} = JSON.parse(await read('package.json')) as Record<string, Record<string, string> | undefined>;
	const declared = Object.keys({ ...dependencies, ...peerDependencies, ...optionalDependencies });
	expect(declared.filter((name) => /^@earendil-works\/|\/pi$/.test(name))).toEqual([]);
	const root = fileURLToPath(new URL('../src', import.meta.url));
	const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith('.ts'));
	expect(files.length).toBeGreaterThan(20);
	for (const file of files) {
		const imported = importsOf(await read(`src/${file}`));
		// A relative path into the Pi package counts: `/testing` must import none.
		const models = imported.filter((name) => /^@earendil-works\/|\/pi(\/|$)/.test(name));
		expect({ file, models }).toEqual({ file, models: [] });
	}
});

it('exports only the name syntax and predicate from the neutral entry', () => {
	expect(Object.keys(names).sort()).toEqual(['NAME_SYNTAX', 'isName']);
});
