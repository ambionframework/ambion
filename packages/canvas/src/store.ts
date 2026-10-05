/** The canvas store port: the one durable row for each room. */
import type { StartRoomOptions } from '@ambionframework/ambion';

/** How an archived room ended. */
export interface CanvasClose {
	readonly result: 'done' | 'failed';
	readonly note?: string;
}

/** What a host needs to start a root room again. */
export interface RootStart {
	readonly kind: 'root';
	readonly agents?: readonly string[];
	readonly seats?: StartRoomOptions['seats'];
	readonly assistant?: string;
	readonly summaryWriter?: string;
	readonly seating?: boolean;
}

/** What the canvas needs to start a breakout room again. */
export interface BreakoutStart {
	readonly kind: 'breakout';
	readonly parent: string;
	readonly opener: string;
	readonly agents: readonly string[];
	readonly message: string;
	readonly to?: string;
}

/** The row of one room. The row holds no message, no lease, and no exchange. */
export interface CanvasRoom {
	readonly name: string;
	readonly goal: string;
	readonly depth: 0 | 1;
	readonly state: 'running' | 'stopped' | 'archived';
	readonly start: RootStart | BreakoutStart;
	readonly close?: CanvasClose;
}

/**
 * The rows of a canvas. The store has no fence: one host owns a canvas.
 *
 * An archived row is permanent. `setState` on an archived row throws, so
 * the row never returns to `running`. `setState` and `archive` on a name
 * with no row throw an `Error` that names the room.
 */
export interface CanvasStore {
	/** Every row, in the order of insertion. */
	list(): Promise<readonly CanvasRoom[]>;
	/** Writes the row when the name is free. A row of that name stays as it is. */
	insert(room: CanvasRoom): Promise<'inserted' | 'exists'>;
	setState(name: string, state: 'running' | 'stopped'): Promise<void>;
	/**
	 * Sets the row to archived with its close, from `running` or from `stopped`.
	 * An archived row stays as it is, and the call returns the close that the row holds.
	 */
	archive(name: string, close: CanvasClose): Promise<CanvasClose>;
}

/** The error for a name with no row. */
export const missingRoom = (name: string): Error => new Error(`The canvas has no room "${name}".`);

/** The error for a state change on an archived row. */
export const archivedRoom = (name: string): Error =>
	new Error(`The room "${name}" is archived and does not change state.`);
