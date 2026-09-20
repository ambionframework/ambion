/** Matches the error the room throws on purpose, by its code. */
import { expect } from 'vitest';
import type { AmbionErrorCode } from '../../src/index.ts';

export const refusal = (code: AmbionErrorCode) =>
	expect.objectContaining({ name: 'AmbionError', code });
