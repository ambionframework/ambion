/**
 * The workspace conformance cases on both just-bash backends: in memory, and
 * over a temporary directory (`test/support/backends.ts`).
 */
import { workspaceConformance } from '@ambionframework/workspace/conformance';
import { describe, it } from 'vitest';
import { backends } from './support/backends.ts';

describe.each(backends)('$name', (fixture) => {
	for (const c of workspaceConformance(fixture)) it(c.name, c.run);
});
