/**
 * The exchange: a question, and everything the room does until it goes quiet
 * again. The room goes from idle, to active, and back to idle, and one person
 * owns what happens in between.
 *
 * This is the room's own unit of work, not the assistant's. An assistant is the first
 * thing that reads it — it writes one message per exchange — and it is not the
 * last: a client folds the working under the question it answered, a host
 * measures what an exchange cost, and a later compactor stands over a stretch of
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
 * This module also holds the two ends the room reports, `settled` and
 * `quiet`, because they are the two edges of this span. What is running is
 * a fact about the seats, so the room reads it off them and passes it in.
 * Every transition here is synchronous and takes no model, so the whole
 * lifecycle is provable with no room around it.
 *
 * The design contract is `docs/exchange.md`; `docs/assistant.md` says what an
 * assistant makes of one.
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

/** The seats settled: what that closed, and whether a seat worked since they last settled. */
export interface Settled {
	/** The exchange the room was working on, or nothing when it worked on its own account. */
	readonly closed: ClosedExchange | undefined;
	/**
	 * Whether an activation that counts as work began since the last settle.
	 * A second settle at one quiescence — a question that woke nobody, an
	 * aborted activation ending after the exchange closed — is not the seats
	 * stopping again, and the assistant reads the difference.
	 */
	readonly worked: boolean;
}

/**
 * The room's exchanges: the open one, and the two ends the room reports.
 *
 * Run state: an exchange belongs to a running room, and a restart begins with
 * none — the record keeps what was said, and nobody is mid-question after a
 * restart.
 *
 * Two facts arrive from the room at every transition, and this holds neither:
 * whether a seat that speaks for itself is taking an activation (*working*),
 * and whether nothing at all is (*idle*). The room draws that one distinction
 * about its assistant, and the seats hold the activations, so there is no
 * count here to keep in step.
 */
export class Exchanges {
	private open: Exchange | undefined;
	/** Whether an activation that counts as work began since the seats last settled. */
	private stirred = false;
	private readonly settledWaiters: (() => void)[] = [];
	private readonly quietWaiters: (() => void)[] = [];

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

	/** An activation that counts as work began: the next settle is the seats stopping. */
	stir(): void {
		this.stirred = true;
	}

	/**
	 * Something stopped. While a seat is working nothing settles, and the
	 * result says so. Otherwise the seats have settled: whoever waited hears
	 * it first, then the open exchange closes with the range it reached, and
	 * the result says whether a seat worked since the last settle.
	 */
	settle(working: boolean, through: Seq): Settled | undefined {
		if (working) return undefined;
		for (const resolve of this.settledWaiters.splice(0)) resolve();
		const worked = this.stirred;
		this.stirred = false;
		const open = this.open;
		this.open = undefined;
		return { closed: open === undefined ? undefined : { ...open, through }, worked };
	}

	/**
	 * Nothing at all is taking an activation, so the room is quiet: whoever
	 * waited hears it, and the result says the room should say so. An active
	 * room is not quiet, and the result says nothing.
	 */
	quiesce(idle: boolean): boolean {
		if (!idle) return false;
		for (const resolve of this.quietWaiters.splice(0)) resolve();
		return true;
	}

	/** Resolves when no seat that speaks for itself is taking an activation. */
	settled(working: boolean): Promise<void> {
		if (!working) return Promise.resolve();
		return new Promise((resolve) => this.settledWaiters.push(resolve));
	}

	/** Resolves when nothing at all is taking an activation. */
	quiet(idle: boolean): Promise<void> {
		if (idle) return Promise.resolve();
		return new Promise((resolve) => this.quietWaiters.push(resolve));
	}

	/** A stopped room never goes quiet on its own, so nobody waits on it. */
	drain(): void {
		for (const resolve of this.quietWaiters.splice(0)) resolve();
	}
}
