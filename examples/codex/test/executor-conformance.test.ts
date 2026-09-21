/**
 * The executor suite on the Codex executor. The harness maps each neutral
 * plan of the suite to a scenario of the fake `codex` executable.
 */
import { fileURLToPath } from 'node:url';
import { executorConformance } from '@ambionframework/ambion/conformance';
import { describe, it } from 'vitest';
import { codexExecutorHarness } from '../src/testing.ts';

const executable = fileURLToPath(new URL('./fake/codex', import.meta.url));

describe('codex executor', () => {
	for (const c of executorConformance(codexExecutorHarness({ executable }))) it(c.name, c.run);
});
