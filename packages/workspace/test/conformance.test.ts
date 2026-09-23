/**
 * The two conformance suites. The workspace cases run on the just-bash memory
 * backend, which proves the suite itself; `@ambionframework/just-bash` and
 * `@ambionframework/workstation` run them on their own backends. Every SQL
 * case runs on SQLite in memory and on a file (`test/support/backends.ts`).
 */
import { describe, it } from 'vitest';
import { backends } from '../../just-bash/test/support/backends.ts';
import { sqlConformance, workspaceConformance } from '../src/conformance.ts';
import { sqlBackends } from './support/backends.ts';

const memory = backends.find((harness) => harness.name === 'memory');
if (memory === undefined) throw new Error('The just-bash harnesses have no memory backend.');

describe.each([memory])('$name', (harness) => {
	for (const c of workspaceConformance(harness)) it(c.name, c.run);
});

describe.each(sqlBackends)('$name', (harness) => {
	for (const c of sqlConformance(harness)) it(c.name, c.run);
});
