/**
 * Test-scoped helpers for the room tests. This file imports the test
 * runner, so a child process must not import it.
 */
import { expect } from 'vitest';
import type { AmbionErrorCode } from '../../src/index.ts';

/** Matches the error the room throws on purpose, by its code and its message. */
export const refusedAs = (code: AmbionErrorCode, message: RegExp) =>
	expect.objectContaining({ name: 'AmbionError', code, message: expect.stringMatching(message) });
