/**
 * The workspace conformance cases on both just-bash backends: in memory, and
 * over a temporary directory (`test/support/backends.ts`).
 */
import { workspaceConformance } from '@ambionframework/workspace/conformance';
import { describe, it } from 'vitest';
import { backends } from './support/backends.ts';

describe.each(backends)('$name', (harness) => {
	for (const c of workspaceConformance(harness)) it(c.name, c.run);
});
