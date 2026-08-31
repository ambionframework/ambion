/**
 * The exchange: a question, and everything the room does until it goes quiet
 * again. The room goes from idle, to active, and back to idle, and one person
 * owns what happens in between.
 *
 * This is the room's own unit of work, not the aide's. An aide is the first
 * thing that reads it — it writes one message per exchange — and it is not the
 * last: a client folds the working under the question it answered, a host
 * measures what a round cost, and a later compactor stands over a stretch of
 * them. So the rule lives here, on its own, and every reader takes it from the
 * same place.
 *
 * The rule, in three sentences:
 *
 * - **A person's question opens one**, when no exchange is open. Nothing else
 *   does: an agent speaking into a quiet room opens nothing, and arriving or
 *   leaving asks nobody anything.
 * - **Quiescence closes it.** The room settles when no agent is active, and a
 *   room that settles has finished — a seat that says something wakes its
 *   readers inside its own `say`, so the active count never dips to zero in
 *   the middle of a burst.
 * - **What lands while it is open steers it and changes nothing.** Not the
 *   owner, not the range, not who the answer belongs to.
 *
 * The design contract is `docs/agent.md`; `docs/aide.md` says what an aide
 * makes of one.
 */
import { isSpoken, type Message, type Seq } from './types.ts';

/** A question the room is working on. */
export interface Exchange {
	/** The person whose question opened it, and who owns what follows. */
	readonly owner: string;
	/** The seq of that question: where the exchange starts. */
	readonly from: Seq;
	/** When it opened, ISO. */
	readonly at: string;
}

/** An exchange the room has finished, and the range it turned out to hold. */
export interface ClosedExchange extends Exchange {
	/** The last seq on the record when the room went quiet. */
	readonly through: Seq;
}

/**
 * The open exchange, if there is one. Run state: an exchange belongs to a
 * running room, and a restart begins with none — the record keeps what was
 * said, and nobody is mid-question after a restart.
 */
export class Exchanges {
	private open: Exchange | undefined;

	/** What the room is working on, or nothing when nobody has asked. */
	current(): Exchange | undefined {
		return this.open;
	}

	/**
	 * A message landed. It opens an exchange when a person asked something into
	 * a room that has none open, and returns the one it opened.
	 *
	 * The clause is written on the exchange rather than on the room's status,
	 * for the case that is busy and has no owner: somebody arrives, the seat
	 * that watches the door wakes, and a question lands on top of work nobody
	 * asked for. That question still owns what follows.
	 */
	note(message: Message, fromPerson: boolean): Exchange | undefined {
		if (this.open !== undefined) return undefined;
		if (!fromPerson || !isSpoken(message)) return undefined;
		this.open = { owner: message.from, from: message.seq, at: message.at };
		return this.open;
	}

	/**
	 * The room went quiet. Closes whatever was open and returns it with the
	 * range it held, or nothing when the room was working on its own account.
	 */
	close(through: Seq): ClosedExchange | undefined {
		const open = this.open;
		this.open = undefined;
		return open === undefined ? undefined : { ...open, through };
	}
}
