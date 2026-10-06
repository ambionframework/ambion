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

/** Where the data of a widget comes from. The canvas holds the pointer and reads no source. */
export type WidgetSource =
	| { readonly type: 'process'; readonly handle: string; readonly path: string }
	| { readonly type: 'file'; readonly path: string }
	| { readonly type: 'snapshot'; readonly ref: string };

/** One revision of a widget. A revision never changes. */
export interface CanvasWidget {
	readonly room: string;
	/** Unique in the room. The shared name syntax, 48 characters at most. */
	readonly name: string;
	/** A new id for each revision. */
	readonly revision: string;
	/** Counts the revisions of this name, from 1. */
	readonly rev: number;
	readonly state: 'shown' | 'hidden';
	/** One kind of the host catalog. */
	readonly kind: string;
	readonly source?: WidgetSource;
	/** One line, 80 characters at most. */
	readonly title?: string;
	/** The agent that wrote this revision. */
	readonly author: string;
	/** What a person can do. No actions: the widget is a view. */
	readonly actions: readonly WidgetAction[];
	/** The one person who may act. Absent: any person on a visit. */
	readonly for?: string;
}

/** One thing that a person can do on a widget. */
export interface WidgetAction {
	/** The shared name syntax. */
	readonly id: string;
	/** One line, 40 characters at most. */
	readonly label: string;
	/** The first act on the revision answers it. A later act with other content is `answered`. */
	readonly once?: boolean;
	/** A form: 8 fields at most. */
	readonly fields?: readonly WidgetField[];
}

/** One field of a form. `name` follows the name syntax, and `label` is one line of 40 characters at most. */
export type WidgetField =
	| { readonly name: string; readonly label: string; readonly type: 'text' }
	| {
			readonly name: string;
			readonly label: string;
			readonly type: 'number';
			readonly min?: number;
			readonly max?: number;
	  }
	| { readonly name: string; readonly label: string; readonly type: 'boolean' }
	| {
			readonly name: string;
			readonly label: string;
			readonly type: 'choice';
			readonly options: readonly string[];
	  };

/** One kind of the catalog that the host can draw. */
export interface WidgetKind {
	readonly name: string;
	/** One line for the guidance. */
	readonly description: string;
	/** The source types that the kind takes. A kind with none takes no source. */
	readonly sources: readonly WidgetSource['type'][];
	/** True when the host can draw actions on this kind. */
	readonly actions: boolean;
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
	/** Every widget revision, in the order of insertion. */
	revisions(): Promise<readonly CanvasWidget[]>;
	/** Appends one revision. A revision id that exists stays as it is. */
	appendRevision(widget: CanvasWidget): Promise<'inserted' | 'exists'>;
}

/** The error for a name with no row. */
export const missingRoom = (name: string): Error => new Error(`The canvas has no room "${name}".`);

/** The error for a state change on an archived row. */
export const archivedRoom = (name: string): Error =>
	new Error(`The room "${name}" is archived and does not change state.`);
