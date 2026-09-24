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
	 * executor calls it once, at the start of the activation, and the text
	 * joins the turn context. A throw, a rejection, or no answer within
	 * `REMINDER_TIMEOUT_MS` gives no text. At that bound the executor aborts
	 * `signal`, so a reminder that records what it showed records nothing.
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

/** A bundle's text for one activation. It runs where the executor runs, and it can read I/O. */
export type Reminder = (
	seat: ReminderSeat,
	signal: AbortSignal,
) => string | undefined | Promise<string | undefined>;
