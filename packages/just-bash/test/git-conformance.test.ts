/**
 * The git conformance cases for `justGitBackend`, on both just-bash
 * backends: in memory, and over a temporary directory
 * (`test/support/git-harness.ts`).
 */
import { gitConformance } from '@ambionframework/workspace/conformance';
import { describe, it } from 'vitest';
import { harnesses } from './support/git-harness.ts';

describe.each(harnesses)('$name', (harness) => {
	for (const c of gitConformance(harness)) it(c.name, c.run);
});
