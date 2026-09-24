/**
 * Where one tool call ran, as the audit log and the SQL resource stamp it.
 * The module imports types alone, so the SQL entry stays small.
 */
import type { ToolContext } from '@ambionframework/ambion';

/** The agent of a call, and the room, activation, and exchange when the call ran in a room. */
export interface CallEnvelope {
	readonly agent: string;
	readonly room?: string;
	readonly activation?: string;
	readonly exchange?: { readonly owner: string; readonly from: number };
}

/** The envelope of the call that `ctx` describes. */
export function callEnvelope(ctx: ToolContext): CallEnvelope {
	return {
		agent: ctx.agent.name,
		...(ctx.room === undefined ? {} : { room: ctx.room }),
		...(ctx.activation === undefined ? {} : { activation: ctx.activation }),
		...(ctx.exchange === undefined ? {} : { exchange: ctx.exchange }),
	};
}
