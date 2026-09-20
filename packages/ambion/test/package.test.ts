/**
 * The package's two entries, and what each one names. `index.ts` is what an
 * application needs to build a room. `hosting.ts` is the wire between a room
 * and a seat, and everything beyond the application view a host needs from a
 * `Runtime`, for a host that runs the two apart.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import * as hosting from '../src/hosting.ts';
import * as main from '../src/index.ts';
import { PACKAGE_NAME } from '../src/index.ts';

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
	expect(built).toEqual(['src/index.ts', 'src/hosting.ts']);
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
		'PACKAGE_NAME',
		'createRuntime',
		'defaultRuntime',
		'defineAgent',
		'defineHuman',
		'defineTool',
		'fromPiTool',
		'isPresence',
		'isSpoken',
		'isSummary',
		'pi',
		'readExchange',
		'readRoom',
		'resumeRoom',
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
