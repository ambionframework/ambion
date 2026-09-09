/**
 * One activation: the room wakes a seat, it reads the room, it acts, it stops.
 *
 * A seat is seated for as long as the room runs. An activation lasts seconds,
 * and it owns what belongs to one:
 *
 * - **Its id.** Derived from the log: the message that woke the seat and the
 *   seat's name, or the close it answers and the attempt. Every entry it
 *   writes carries it.
 * - **What it has heard.** `readThrough` is the seq this activation can commit
 *   against: the record as it stood when the activation read it, advanced as steers
 *   land in its transcript and by its own says. Rule 5 refuses anything
 *   drafted against a record that moved past it.
 * - **What arrived while it worked.** A message that lands mid-activation is steered
 *   in; the seqs wait in order until the transcript shows they were read.
 * - **Whether it left a mark.** `spoke` is the one thing the room asks a
 *   finished activation.
 *
 * The room renders what the activation reads and hands it over as a view;
 * the seat side builds the model, the prompt and the hands from it, runs it,
 * and reads again while the room keeps moving underneath.
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
import type { ActivationView, EndReason, LeaseResponse, ViewResponse } from './wire.ts';

/** What only the seat side can give an activation: the room's view, and a model over it. */
export interface ActivationHost {
	/** What this activation reads, as the room renders it now. */
	view(): Promise<ViewResponse>;
	/** Renew the lease. The answer says how far the record has moved. */
	renew(): Promise<LeaseResponse>;
	/** Build the model over the view, with the hands the view names. */
	build(view: ActivationView, activation: Activation): Agent;
	/** Keep what the model did, in the seat's own downstream session. */
	persist(agent: Agent): Promise<void>;
	emit(event: SessionEvent): void;
	/** The room's clock: Pi stamps every message it is handed. */
	now(): number;
}

/** One activation, from the moment the room wakes a seat until it stops. */
export class Activation {
	/** How much of the record this activation has provably heard. */
	private heardThrough: Seq = 0;
	/** Record seqs steered to the live agent, awaiting their drain (FIFO). */
	private pending: Seq[] = [];
	private agent: Agent | undefined;
	private cancelled = false;
	/** Whether it left a mark on the record. The room's first question. */
	spoke = false;
	/** Whether it ended without reaching the record at all. The room's second. */
	failed = false;
	/** Whether the record kept moving past its drafts, so it stood down without writing. */
	refused = false;

	constructor(
		readonly id: string,
		readonly seat: string,
		private readonly host: ActivationHost,
	) {}

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
		this.agent?.steer(userMessage(`[new] ${line}`, this.host.now()));
	}

	/** Pi's abort ends the run but not its queues; this stops the rebuild too. */
	abort(): void {
		this.cancelled = true;
		this.agent?.abort();
	}

	/** Why the lease ends, read off how the activation went. */
	get reason(): EndReason {
		if (this.failed) return 'failed';
		return this.refused && !this.spoke ? 'refused' : 'released';
	}

	/**
	 * Take it: read, act, and read again while the room keeps moving. One pass
	 * is the whole activation when nothing landed underneath it.
	 */
	async run(): Promise<void> {
		while (await this.pass()) {
			// nothing: the next pass reads the record as it now stands.
		}
		this.agent = undefined;
	}

	/** One pass. True when the record moved past what it heard, so it must read again. */
	private async pass(): Promise<boolean> {
		try {
			const opened = await this.host.view();
			if ('stale' in opened || this.cancelled) return false;
			const view = opened.view;
			// A fresh view hands the seat the whole record: heard up to here.
			this.heardThrough = view.lastSeq;
			this.pending = [];
			const agent = this.host.build(view, this);
			this.agent = agent;
			agent.subscribe((event) => this.note(event));
			await agent.prompt(userMessage(view.context, this.host.now()));
			await this.host.persist(agent);
			const failure = failureOf(agent);
			if (failure) return this.broke(failure);
			// An aborted activation stays cancelled, and one that does not rebuild
			// is a single pass whatever landed: a summarising activation answers a room
			// that moved with a redraft inside its own tool.
			if (this.cancelled || view.hand !== 'say') return false;
			return this.moved(agent);
		} catch (error) {
			return this.broke(error instanceof Error ? error : new Error(String(error)));
		}
	}

	/**
	 * Whether the record moved past what this activation heard: a steer that
	 * was dropped on the way is not lost, because the message is on the record
	 * and the renewal says how far it reaches.
	 */
	private async moved(agent: Agent): Promise<boolean> {
		const renewed = await this.host.renew();
		if ('stale' in renewed || renewed.ok.lastSeq <= this.heardThrough) return false;
		agent.clearAllQueues();
		return true;
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
				this.host.emit({ type: event.type, agent: this.seat, toolName: event.toolName });
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
		this.host.emit({ type: 'error', agent: this.seat, error });
		return false;
	}
}

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: 'user', content: text, timestamp };
}

function failureOf(agent: Agent): Error | undefined {
	const last = agent.state.messages.at(-1);
	if (last && 'stopReason' in last && last.stopReason === 'error') {
		return new Error(('errorMessage' in last && last.errorMessage) || 'The activation failed.');
	}
	return undefined;
}
