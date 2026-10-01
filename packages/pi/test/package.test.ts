/**
 * The package entries, and what each one exports. The Pi executor builds on
 * the experimental pi-durable harness, so the manifest pins its exact
 * version and the install resolves to that version.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import * as entry from '../src/index.ts';
import * as testing from '../src/testing.ts';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	name: string;
	dependencies: Record<string, string>;
};

it('exports the executor, its execution, its services, and the test tools, and names the package as package.json does', () => {
	expect(Object.keys(entry).sort()).toEqual([
		'PACKAGE_NAME',
		'createExecutionServices',
		'fileCredentials',
		'fromPiTool',
		'loginPi',
		'memorySessions',
		'pi',
		'piExecution',
		'runAgent',
		'stubModel',
		'terminalInteraction',
	]);
	expect(Object.keys(testing).sort()).toEqual([
		'contextText',
		'isClosingContext',
		'piExecutorFixture',
		'scriptOf',
		'scriptedStream',
		'toolNames',
		'toolResultTexts',
	]);
	expect(entry.PACKAGE_NAME).toBe(manifest.name);
});

it('pins pi-durable to one exact version, and installs that version', () => {
	const pinned = manifest.dependencies['@earendil-works/pi-durable'];
	expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
	const installed = createRequire(import.meta.url)('@earendil-works/pi-durable/package.json') as {
		version: string;
	};
	expect(installed.version).toBe(pinned);
	// The model loop lives in pi-durable. The package imports no other harness.
	expect(manifest.dependencies).not.toHaveProperty('@earendil-works/pi-agent-core');
});
