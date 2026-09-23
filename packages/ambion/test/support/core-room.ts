/**
 * Test-scoped helpers for the room tests. This file imports the test
 * runner, so a child process must not import it.
 */
import { expect, onTestFinished } from 'vitest';
import type { AmbionErrorCode } from '../../src/index.ts';
import type { OpenedStorage, Storage } from './storage.ts';

/**
 * Open a storage for one test, and dispose it when the test ends. Vitest
 * runs the end hooks in reverse order, so every room that `stopAtEnd`
 * registers later stops before the storage closes.
 */
export async function openFor(storage: Storage): Promise<OpenedStorage> {
	const opened = await storage.open();
	onTestFinished(() => opened.dispose());
	return opened;
}

/** Matches the error the room throws on purpose, by its code and its message. */
export const refusedAs = (code: AmbionErrorCode, message: RegExp) =>
	expect.objectContaining({ name: 'AmbionError', code, message: expect.stringMatching(message) });
