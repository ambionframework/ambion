/** The host interface of the canvas. The contract is `docs/canvas.md`. */
import type {
	AgentDefinition,
	PersonDefinition,
	Room,
	Runtime,
	StartRoomOptions,
	ToolBundle,
} from '@ambionframework/ambion';
import type { Workspace } from '@ambionframework/workspace';
import type { CanvasClose, CanvasRoom, CanvasStore, CanvasWidget, WidgetKind } from './store.ts';

/** The bounds and the worker team of the breakout rooms. */
export interface BreakoutOptions {
	/** The worker team. No root room seats these definitions. */
	readonly team: readonly string[];
	/** The most running breakout rooms for one opener in one parent. Default 3. */
	readonly perOpener?: number;
}

/** The widget catalog of the host. */
export interface WidgetOptions {
	/** The kinds that the host draws. A `show` names one of them. */
	readonly kinds: readonly WidgetKind[];
}

/** The operation that failed, as `onError` reports it. */
export type CanvasOperation =
	| 'resume'
	| 'open'
	| 'start'
	| 'stop'
	| 'close'
	| 'breakout'
	| 'tell'
	| 'archive'
	| 'report'
	| 'notice'
	| 'mirror'
	| 'show'
	| 'hide'
	| 'widget'
	| 'act';

/** A failure that the canvas reports and survives. */
export interface CanvasError {
	readonly room: string;
	readonly operation: CanvasOperation;
	readonly error: unknown;
}

export interface OpenCanvasOptions {
	readonly name: string;
	/** The runtime gives every room its execution. The canvas adds no execution option. */
	readonly runtime: Runtime;
	readonly store: CanvasStore;
	/** With a workspace, the canvas attaches the mirror of each room. */
	readonly workspace?: Workspace;
	readonly breakout: BreakoutOptions;
	/** The catalog of widget kinds that the host draws. Without it, `widgetTools` is a refusal. */
	readonly widgets?: WidgetOptions;
	/** A failed start keeps its row `running`. The next `resume` tries again. */
	readonly onError?: (error: CanvasError) => void;
}

export type CanvasRoomOptions = Pick<StartRoomOptions, 'seats' | 'seating'> & {
	readonly name: string;
	readonly goal: string;
	/** The definitions of this room. Default: every definition outside the worker team. */
	readonly agents?: readonly string[];
	/**
	 * The name of a definition given at resume. A name that no definition resolves is a
	 * refusal. The row keeps the name, so a later start resolves it again.
	 */
	readonly assistant?: string;
	/** The name of a definition given at resume. It resolves as `assistant` does. */
	readonly summaryWriter?: string;
};

export type CanvasEvent =
	| { readonly type: 'opened'; readonly room: CanvasRoom }
	| { readonly type: 'started' | 'stopped'; readonly room: string }
	| { readonly type: 'archived'; readonly room: string; readonly close: CanvasClose }
	| { readonly type: 'widget'; readonly widget: CanvasWidget }
	| {
			readonly type: 'answered';
			readonly room: string;
			readonly revision: string;
			readonly seq: number;
	  };

/** One press of a person on a widget. */
export interface WidgetAct {
	readonly room: string;
	readonly widget: string;
	/** The revision that the person saw. */
	readonly revision: string;
	readonly action: string;
	readonly values?: Readonly<Record<string, string | number | boolean>>;
	/** A token for one press. The host saves it before the call and reuses it on a retry. */
	readonly press: string;
}

/** What an act did. `stale` and `answered` are results, since the host draws them. */
export type WidgetActResult =
	| { readonly kind: 'sent'; readonly seq: number }
	| { readonly kind: 'stale'; readonly widget: CanvasWidget }
	| { readonly kind: 'answered'; readonly seq: number };

export interface Canvas {
	readonly name: string;
	/** The opener bundle: `breakout`, `tell`, `archive`, and the reminder. Call it before `defineAgent`. */
	tools(): ToolBundle;
	/** The worker bundle: `report`. Call it before `defineAgent`. */
	workerTools(): ToolBundle;
	/** The widget bundle: `show`, `hide`, and the reminder. A refusal with no `widgets.kinds`. Call it before `defineAgent`. */
	widgetTools(): ToolBundle;
	/**
	 * Takes the definitions once, then starts or resumes each running root room,
	 * then each running breakout room whose parent runs. A second call is a refusal.
	 */
	resume(options: { readonly agents: readonly AgentDefinition[] }): Promise<void>;
	/**
	 * Opens a root room. Needs resume first. A root row returns its live handle, or starts
	 * from its row; the other options of the repeat are ignored. A breakout name is a refusal.
	 */
	open(options: CanvasRoomOptions): Promise<Room>;
	/**
	 * With a root name, sets the room to running, starts it, then starts its breakout
	 * rooms whose rows are running. With a breakout name, sets that room to running and
	 * starts it, under a live parent only. An archived room is a refusal.
	 */
	start(name: string): Promise<void>;
	/**
	 * Sets the row to stopped, and stops the room. A root stops with its breakout rooms;
	 * their rows do not change.
	 */
	stop(name: string): Promise<void>;
	/**
	 * Archives a breakout room: records the close, then stops it.
	 * A stopped row records the close and stops nothing. A repeat returns the recorded close.
	 */
	archive(name: string, close: CanvasClose): Promise<CanvasClose>;
	/** Stops every handle of this run. Each row keeps its state. Every call after it is a refusal. */
	close(): Promise<void>;
	/** The live handle of a room of this run, or undefined. */
	room(name: string): Room | undefined;
	/** The rows of the store, read at `resume`. Empty before `resume`. */
	rooms(): readonly CanvasRoom[];
	/** The current revision of each widget of a room, hidden ones included. Empty before `resume`. */
	widgets(room: string): readonly CanvasWidget[];
	/** One revision by id, or undefined. Read at `resume`. */
	revision(id: string): CanvasWidget | undefined;
	/** The act that answers each answered revision of a room: its seq and the person. Empty before `resume`. */
	answers(room: string): ReadonlyMap<string, { readonly seq: number; readonly by: string }>;
	/** Checks an act, then sends it through the visit of the person in that room. */
	act(person: PersonDefinition, act: WidgetAct): Promise<WidgetActResult>;
	subscribe(listener: (event: CanvasEvent) => void): () => void;
}
