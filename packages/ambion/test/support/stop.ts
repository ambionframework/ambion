/**
 * Test-scoped cleanup. Child processes import the other support files, so
 * this file alone imports the test runner.
 */
import { onTestFinished } from 'vitest';
import type { OpenedStorage, Storage } from './storage.ts';

/**
 * Stop the room when the test ends, whatever the result. `stop` is
 * idempotent, so the test can also stop the room itself.
 */
export function stopAtEnd<T extends { stop(): Promise<void> }>(room: T): T {
	onTestFinished(() => room.stop());
	return room;
}

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
