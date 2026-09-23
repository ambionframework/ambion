import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as entry from '../src/index.ts';
import * as testing from '../src/testing.ts';

it('exports the executor, its execution and the test harness, and names the package as package.json does', () => {
	expect(Object.keys(entry).sort()).toEqual([
		'PACKAGE_NAME',
		'claude',
		'claudeExecution',
		'createClaudeExecutor',
	]);
	expect(Object.keys(testing).sort()).toEqual(['claudeExecutorHarness', 'scenarioOf']);
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	expect(entry.PACKAGE_NAME).toBe(manifest.name);
	expect(manifest.dependencies).not.toHaveProperty('@ambionframework/pi');
	expect(manifest.dependencies).not.toHaveProperty('@ambionframework/pi-journal');
});
