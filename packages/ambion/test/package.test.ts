/**
 * The package's two entries, and what each one names. `index.ts` is what a
 * host needs to build a room. `transport.ts` is the wire between a room and
 * a seat, for a host that runs the two apart.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import * as main from '../src/index.ts';
import { PACKAGE_NAME } from '../src/index.ts';
import * as transport from '../src/transport.ts';

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
	expect(built).toEqual(['src/index.ts', 'src/transport.ts']);
	// Each subpath names a file the build writes, under the name it builds it by.
	for (const [path, target] of Object.entries(exports)) {
		if (path === './package.json') continue;
		const file = typeof target === 'string' ? target : target.import;
		const stem = path === '.' ? 'index' : path.slice(2);
		expect(file).toBe(`./dist/${stem}.mjs`);
		expect(built).toContain(`src/${stem}.ts`);
	}
});

it('keeps the wire off the entry a host builds a room with', () => {
	// A host that never runs a seat elsewhere reads none of these.
	for (const name of ['SeatActor', 'inProcessTransport', 'assertWire', 'roundTrip']) {
		expect(transport).toHaveProperty(name);
		expect(main).not.toHaveProperty(name);
	}
	// The room primitives stay where a host looks for them.
	for (const name of ['defineAgent', 'defineHuman', 'defineTool', 'startRoom']) {
		expect(main).toHaveProperty(name);
		expect(transport).not.toHaveProperty(name);
	}
});
