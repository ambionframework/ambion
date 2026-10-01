/**
 * The git conformance cases for `justGitBackend`, on both just-bash
 * backends: in memory, and over a temporary directory
 * (`test/support/git-fixture.ts`).
 */
import { gitConformance } from '@ambionframework/workspace/conformance';
import { describe, it } from 'vitest';
import { fixtures } from './support/git-fixture.ts';

describe.each(fixtures)('$name', (fixture) => {
	for (const c of gitConformance(fixture)) it(c.name, c.run);
});
