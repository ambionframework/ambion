/**
 * The two conformance suites on the backends this package ships. Every
 * workspace case runs on memory and on directory, and every SQL case runs on
 * SQLite in memory and on a file (`test/support/backends.ts`).
 */
import { describe, it } from 'vitest';
import { sqlConformance, workspaceConformance } from '../src/conformance.ts';
import { backends, sqlBackends } from './support/backends.ts';

describe.each(backends)('$name', (harness) => {
	for (const c of workspaceConformance(harness)) it(c.name, c.run);
});

describe.each(sqlBackends)('$name', (harness) => {
	for (const c of sqlConformance(harness)) it(c.name, c.run);
});
