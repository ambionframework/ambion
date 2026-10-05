/**
 * The canvas store: one durable row for each room of a deployment.
 *
 * ```ts
 * const store = sqliteCanvas(sql);
 * await store.insert({ name: 'site', goal: 'Plan the site.', depth: 0, state: 'running', start: { kind: 'root' } });
 * ```
 *
 * The contract is `docs/canvas.md`.
 */

export { openCanvas } from './canvas.ts';
export { memoryCanvas } from './memory.ts';
export { sqliteCanvas } from './sqlite.ts';
export type { BreakoutStart, CanvasClose, CanvasRoom, CanvasStore, RootStart } from './store.ts';
export type {
	BreakoutOptions,
	Canvas,
	CanvasError,
	CanvasEvent,
	CanvasOperation,
	CanvasRoomOptions,
	OpenCanvasOptions,
} from './types.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/canvas';
