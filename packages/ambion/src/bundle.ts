/**
 * The tool bundle: tools, the guidance that explains their use, and the
 * reminder that a bundle gives each activation of a seat. The core
 * flattens bundles at definition time (`define.ts`).
 */
import type { AmbionTool } from './types.ts';

/** A composable set of tools and the guidance that explains their use. */
export interface ToolBundle {
	readonly tools: readonly AmbionTool[];
	readonly guidance?: string;
	/**
	 * Text for one respond activation of one seat, or undefined for none. The
	 * room adds it to the turn context. The same activation can call it more
	 * than once, and each call gives the same text. A throw gives no text.
	 */
	readonly remind?: Reminder;
}

/** The seat and the activation that a reminder writes for. */
export interface ReminderSeat {
	/** The name of the agent that the seat runs. */
	readonly agent: string;
	/** The room of the activation. */
	readonly room: string;
	/** The id of the activation. */
	readonly activation: string;
}

/** A bundle's text for one activation. It runs where the executor runs, synchronously. */
export type Reminder = (seat: ReminderSeat) => string | undefined;
