/**
 * The workspace conformance suite on the two backends this package ships:
 * memory and directory. Each backend is a `ConformanceBackend`
 * (`test/support/backends.ts`), and every case in the suite runs on both.
 */
import { describe, it } from 'vitest';
import { workspaceConformance } from '../src/conformance.ts';
import { backends } from './support/backends.ts';

describe.each(backends)('$name', (harness) => {
	for (const c of workspaceConformance(harness)) it(c.name, c.run);
});
