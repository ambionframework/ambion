/**
 * One activation: the room wakes a seat, it reads the room, it acts, it stops.
 *
 * A seat is seated for as long as the room runs. An activation lasts seconds.
 * They held one record between them until now — which is how "how much of the
 * record have I heard" came to live on a thing that outlives the answer. An
 * activation owns what belongs to one:
 *
 * - **What it has heard.** `readThrough` is the seq this activation can commit
 *   against: the record as it stood when the activation read it, advanced as steers
 *   land in its transcript and by its own says. Rule 5 refuses anything
 *   drafted against a record that moved past it.
 * - **What arrived while it worked.** A message that lands mid-activation is steered
 *   in; the seqs wait in order until the transcript shows they were read.
 * - **Whether it left a mark.** `spoke` is the one thing the room asks a
 *   finished activation.
 *
 * The room builds what it needs — the model, the prompt, the tools, where to
 * persist — because only the room knows those. The activation runs it,
 * rebuilds it while the room keeps moving underneath, and stops.
 *
 * **Three spans, and only two are ours.** Pi has a *turn* — one request to a
 * provider and the tools it calls — and a *run*, which is one `prompt()` and
 * the turns inside it. An activation is wider than both: it is one or more
 * runs, because a message landing mid-activation rebuilds it against the
 * record as it now stands. The word for what a room does to a seat is
 * `activation` ([`agent.md`](../../../docs/agent.md) rule 1), and the record
 * has called it that all along: every one lands in the seat's downstream
 * session as an `ambion/activation` entry.
 */
import type { Agent, AgentEvent } from '@earendil-works/pi-agent-core';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { Message, Seq, SessionEvent } from './types.ts';

/** What only the room can give an activation. Three things, and it asks for no more. */
export interface ActivationRoom {
	/**
	 * Build this activation's model and the context it reads, against the record as
	 * it stands now. Called again for each pass, so a rebuilt activation reads the
	 * room as it is rather than as it was.
	 */
	open(activation: Activation): { agent: Agent; context: string };
	/** Keep what the model did, in the seat's own downstream session. */
	persist(agent: Agent): Promise<void>;
	emit(event: SessionEvent): void;
}

/** One activation, from the moment the room wakes a seat until it stops. */
export class Activation {
	/** How much of the record this activation has provably heard. */
	private heardThrough: Seq;
	/** Record seqs steered to the live agent, awaiting their drain (FIFO). */
	private pending: Seq[] = [];
	private agent: Agent | undefined;
	private cancelled = false;
	/** Whether it left a mark on the record. The room's first question. */
	spoke = false;
	/** Whether it ended without reaching the record at all. The room's second. */
	failed = false;

	constructor(
		readonly name: string,
		lastSeq: Seq,
		private readonly room: ActivationRoom,
	) {
		this.heardThrough = lastSeq;
	}

	/** The seq this activation may commit against: rule 5's `readThrough`. */
	get readThrough(): Seq {
		return this.heardThrough;
	}

	/** It has now heard the record through here — its own say, or a refusal's news. */
	heard(seq: Seq): void {
		this.heardThrough = Math.max(this.heardThrough, seq);
	}

	/**
	 * A message landed while this activation was working. It reaches the model as a
	 * steer (rule 2), and its seq waits until the transcript shows it arrived.
	 */
	steer(message: Message, line: string): void {
		this.pending.push(message.seq);
		this.agent?.steer(userMessage(`[new] ${line}`));
	}

	/** Pi's abort ends the run but not its queues; this stops the rebuild too. */
	abort(): void {
		this.cancelled = true;
		this.agent?.abort();
	}

	/**
	 * Take it: read, act, and read again while the room keeps moving. One pass
	 * is the whole activation when nothing landed underneath it.
	 */
	async run(rebuilds: boolean, lastSeq: () => Seq): Promise<void> {
		while (await this.pass(rebuilds, lastSeq)) {
			// nothing: the next pass reads the record as it now stands.
		}
		this.agent = undefined;
	}

	/** One pass. True when a message landed and it must read again. */
	private async pass(rebuilds: boolean, lastSeq: () => Seq): Promise<boolean> {
		try {
			// A fresh view hands the seat the whole record: heard up to here.
			this.heardThrough = lastSeq();
			this.pending = [];
			const { agent, context } = this.room.open(this);
			this.agent = agent;
			agent.subscribe((event) => this.note(event));
			await agent.prompt(userMessage(context));
			await this.room.persist(agent);
			const failure = failureOf(agent);
			if (failure) return this.broke(failure);
			// An aborted activation stays cancelled, and one that does not rebuild
			// is a single pass whatever landed: a summarising activation answers a room
			// that moved with a redraft inside its own tool.
			if (this.cancelled || !rebuilds) return false;
			// A steer that raced past the run's last drain is not lost: the
			// message is already on the record, so a fresh view carries it.
			if (!agent.hasQueuedMessages()) return false;
			agent.clearAllQueues();
			return true;
		} catch (error) {
			return this.broke(error instanceof Error ? error : new Error(String(error)));
		}
	}

	/**
	 * A steer has landed in the transcript, so this activation has now heard it, and
	 * the room hears what its hands did. Steers drain FIFO, so the oldest
	 * pending seq is the one that landed.
	 */
	private note(event: AgentEvent): void {
		if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
			// `say` is the room's own event, not a tool's.
			if (event.toolName !== 'say') {
				this.room.emit({ type: event.type, agent: this.name, toolName: event.toolName });
			}
			return;
		}
		if (event.type !== 'message_start' || event.message.role !== 'user') return;
		const content = event.message.content;
		if (typeof content !== 'string' || !content.startsWith('[new] ')) return;
		const seq = this.pending.shift();
		if (seq !== undefined) this.heard(seq);
	}

	/** An activation that never reached the record. The room hears it and moves on. */
	private broke(error: Error): false {
		this.failed = true;
		this.room.emit({ type: 'error', agent: this.name, error });
		return false;
	}
}

function userMessage(text: string): UserMessage {
	return { role: 'user', content: text, timestamp: Date.now() };
}

function failureOf(agent: Agent): Error | undefined {
	const last = agent.state.messages.at(-1);
	if (last && 'stopReason' in last && last.stopReason === 'error') {
		return new Error(('errorMessage' in last && last.errorMessage) || 'The activation failed.');
	}
	return undefined;
}
