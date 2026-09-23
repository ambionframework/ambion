/**
 * Test-scoped cleanup. Child processes import the other support files, so
 * this file alone imports the test runner.
 */
import { onTestFinished } from 'vitest';

/**
 * Stop the room when the test ends, whatever the result. `stop` is
 * idempotent, so the test can also stop the room itself.
 */
export function stopAtEnd<T extends { stop(): Promise<void> }>(room: T): T {
	onTestFinished(() => room.stop());
	return room;
}
