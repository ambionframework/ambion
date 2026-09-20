/**
 * The package's four entries, and what each one names. `index.ts` is what an
 * application needs to build a room. `hosting.ts` is the wire between a room
 * and a seat, and everything beyond the application view a host needs from a
 * `Runtime`, for a host that runs the two apart. `conformance.ts` is the
 * transport suite. `testing.ts` is the deterministic stream, clock, and wait
 * a test needs.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, expectTypeOf, it } from 'vitest';
import * as conformance from '../src/conformance.ts';
import * as hosting from '../src/hosting.ts';
import * as main from '../src/index.ts';
import { PACKAGE_NAME, type Seq } from '../src/index.ts';
import * as testing from '../src/testing.ts';

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
	expect(built).toEqual(['src/index.ts', 'src/hosting.ts', 'src/conformance.ts', 'src/testing.ts']);
	// The manifest names every entry the build writes, so a merge that drops one fails here.
	expect(Object.keys(exports).sort()).toEqual([
		'.',
		'./conformance',
		'./hosting',
		'./package.json',
		'./testing',
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
		'PACKAGE_NAME',
		'createRuntime',
		'defaultRuntime',
		'defineAgent',
		'defineHuman',
		'defineTool',
		'exchangeUri',
		'fromPiTool',
		'isPresence',
		'isSpoken',
		'isSummary',
		'parseRoomUri',
		'pi',
		'readExchange',
		'readRoom',
		'resumeRoom',
		'roomUri',
		'startRoom',
		'systemClock',
	]);
});

it('exports exactly the wire and the hosting escape hatch, and nothing an application already has', () => {
	expect(Object.keys(hosting).sort()).toEqual([
		'AgentRunner',
		'assertWire',
		'createExecutionServices',
		'createPiExecutor',
		'hostingOf',
		'inProcessTransport',
		'roundTrip',
		'runningRoom',
		'seatSessionId',
	]);
	for (const name of Object.keys(main)) {
		expect(hosting).not.toHaveProperty(name);
	}
});

it('exports exactly the conformance suite and its in-process executor', () => {
	expect(Object.keys(conformance).sort()).toEqual(['speakOnce', 'transportConformance']);
});

it('exports exactly the deterministic test tools, and nothing an application or a host has', () => {
	expect(Object.keys(testing).sort()).toEqual([
		'byAgent',
		'callTool',
		'fakeClock',
		'isClosing',
		'quiet',
		'scripted',
		'settled',
		'speak',
	]);
	for (const name of Object.keys(testing)) {
		expect(main).not.toHaveProperty(name);
		expect(hosting).not.toHaveProperty(name);
	}
	expectTypeOf<testing.Script>().toBeFunction();
	expectTypeOf<testing.FakeClock>().toHaveProperty('advance');
});

it('names the ports, the reads, and the visit by their final names', () => {
	expectTypeOf<hosting.AgentPort>().toHaveProperty('wake');
	expectTypeOf<hosting.RoomProtocol>().toHaveProperty('view');
	expectTypeOf<hosting.AgentExecutionContext>().toHaveProperty('executor');
	expectTypeOf<main.Visit['lastDeparture']>().toEqualTypeOf<Seq | undefined>();
	expectTypeOf<
		Extract<hosting.ContextParticipant, { kind: 'human' }>['messagesSinceDeparture']
	>().toEqualTypeOf<number>();
	expectTypeOf<Awaited<ReturnType<typeof main.readExchange>>>().toEqualTypeOf<
		main.ExchangeRead | undefined
	>();
	expectTypeOf<Awaited<ReturnType<typeof main.readRoom>>>().toEqualTypeOf<main.RoomRead>();
	expectTypeOf<main.StartRoomOptions>().toHaveProperty('stream');
});
