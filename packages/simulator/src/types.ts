/**
 * The values of one simulation: what the actor does, what the person saw,
 * and the run that the checks and the judge read.
 */
import type {
	ClosedExchangeView,
	HumanDefinition,
	Message,
	RoomNotification,
	RoomRead,
	SummaryMessage,
	Usage,
} from '@ambionframework/ambion';

/** One tool call of an actor before its move. */
export interface MoveCall {
	readonly tool: string;
	readonly args: unknown;
}

/** What the person does next: send a message, or stop and give the reason. */
export type Move = ({ readonly text: string; readonly to?: string } | { readonly stop: string }) & {
	/** The tools the actor called before the move, in order. */
	readonly calls?: readonly MoveCall[];
	readonly usage?: Usage;
};

/** One exchange as the person saw it. */
export interface SeenExchange {
	/** The text the person sent. */
	readonly sent: string;
	/** What `waitForClose()` returned: the discussion, without summaries. */
	readonly discussion: readonly Message[];
	/** What `waitForSummary()` returned. */
	readonly summary?: SummaryMessage;
}

/** What the person has seen: one entry for each exchange the loop ran. */
export interface Seen {
	readonly person: HumanDefinition;
	readonly exchanges: readonly SeenExchange[];
}

/** The person's next move, from what the person has seen. */
export type Actor = (seen: Seen) => Move | Promise<Move>;

/** One exchange of a run: what the person saw, and the closed view of the room. */
export interface RunExchange extends SeenExchange {
	readonly view: ClosedExchangeView;
}

/** Why the loop ended. */
export type Ended = 'stopped' | 'limit' | 'timeout' | 'failed';

/** A detached record of one simulation, for checks and for a judge. */
export interface Run {
	readonly person: HumanDefinition;
	/** Every move the actor made, in order, the last `stop` included. */
	readonly moves: readonly Move[];
	/** One entry for each message the actor sent, in order. */
	readonly exchanges: readonly RunExchange[];
	/** One `room.read()` after the loop, with every message. */
	readonly room: RoomRead;
	/** Every notification after the subscription. */
	readonly events: readonly RoomNotification[];
	readonly ended: Ended;
	readonly error?: string;
	/** `room` sums `exchanges[].view.usage`, and `actor` sums `moves[].usage`. */
	readonly usage: { readonly room: Usage; readonly actor: Usage };
}

export interface SimulateOptions {
	readonly person: HumanDefinition;
	readonly actor: Actor;
	/** The most messages the actor sends. Required, so that every eval states its bound. */
	readonly exchanges: number;
	/** Real milliseconds for one exchange: its close and its summary. The default is 150 000. */
	readonly exchangeMs?: number;
}
