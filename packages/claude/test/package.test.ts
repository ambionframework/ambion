import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as entry from '../src/index.ts';
import * as testing from '../src/testing.ts';

it('exports the executor, its execution and the test fixture', () => {
	expect(Object.keys(entry).sort()).toEqual(['PACKAGE_NAME', 'claude', 'claudeExecution']);
	expect(Object.keys(testing).sort()).toEqual(['claudeExecutorFixture', 'scenarioOf']);
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	expect(manifest.dependencies).not.toHaveProperty('@ambionframework/pi');
});
