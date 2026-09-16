/**
 * One activation: the room wakes a seat, it reads the room, it acts, it stops.
 *
 * A seat is seated for as long as the room runs. An activation lasts seconds,
 * and it owns what belongs to one:
 *
 * - **Its id.** Derived from the record: the message that woke the seat and
 *   the seat's name, or the close it answers and the attempt. Every call it
 *   makes carries it.
 * - **What it acknowledged.** `readThrough` is the highest contiguous
 *   position in provider input. A provider request or an accepted ordinary
 *   say advances it. Rule 5 refuses a draft against a newer record.
 * - **What arrived while it worked.** A message that lands mid-activation is steered
 *   in. It reaches the provider after the request it lands during. PiContext
 *   records the structured range only when that later request receives it.
 *
 * The room supplies structured facts as a view;
 * the seat side renders the prompt, resolves the model and binds the tools, runs it,
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
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	Session as PiSession,
} from '@earendil-works/pi-agent-core';
import type { RoomNotification, Seq } from '../types.ts';
import type { ActivationView, EndReason, LeaseResponse, ViewResponse } from '../wire.ts';
import { PiContext } from './pi.ts';

/** What only the seat side can give an activation: the room's view, and a model over it. */
export interface ActivationHost {
	/** What this activation reads, as structured room facts. */
	view(): Promise<ViewResponse>;
	/** Renew the lease. The answer says how far the record has moved. */
	renew(readThrough: Seq): Promise<LeaseResponse>;
	/** Build the model over the view, with the tool its purpose names. */
	build(view: ActivationView, activation: Activation): Promise<{ agent: Agent; context: string }>;
	/** Keep what the model did, in the seat's own downstream session. */
	persist(agent: Agent): Promise<void>;
	emit(event: RoomNotification): void;
	/** The room's clock: Pi stamps every message it is handed. */
	now(): number;
}

/** One activation, from the moment the room wakes a seat until it stops. */
export class Activation {
	readonly id: string;
	readonly seat: string;
	private readonly host: ActivationHost;
	/** How much record context the provider consumed. */
	private readonly context = new PiContext();
	/** The steers held before Pi first polls its queue. */
	private held: { after: Seq; seq: Seq; line: string }[] = [];
	private providerStarted = false;
	private agent: Agent | undefined;
	private cancelled = false;
	/** Whether it ended without reaching the record at all. The room's second. */
	failed = false;

	constructor(id: string, seat: string, host: ActivationHost) {
		this.id = id;
		this.seat = seat;
		this.host = host;
	}

	/** The seq this activation may commit against: rule 5's `readThrough`. */
	get readThrough(): Seq {
		return this.context.readThrough;
	}

	/** An accepted ordinary say confirms this activation consumed the record through here. */
	acknowledgeThrough(seq: Seq): void {
		this.context.acknowledgeThrough(seq);
	}

	/** A rejected commit placed this context in Pi's next tool-result input. */
	toolResultExpected(toolCallId: string, seq: Seq): void {
		this.context.toolResultExpected(toolCallId, seq);
	}

	/**
	 * A message landed while this activation was working. It reaches the model as a
	 * steer (rule 2). PiContext records its range without parsing rendered text.
	 */
	steer(after: Seq, seq: Seq, line: string): void {
		const context = { after, seq, line };
		if (this.providerStarted && this.agent !== undefined) {
			this.context.steer(this.agent, context, this.host.now());
		} else {
			this.held.push(context);
		}
	}

	/**
	 * A provider request begins after Pi chose its input. A steer queued from
	 * here follows that request and cannot advance this request's progress.
	 * The seat side calls this from the stream function it hands Pi.
	 */
	providerRequestStarted(messages: readonly object[]): void {
		this.context.providerRequestStarted(messages);
		this.providerStarted = true;
		for (const context of this.held.splice(0)) {
			if (this.agent !== undefined) this.context.steer(this.agent, context, this.host.now());
		}
	}

	/** Pi's abort ends the run but not its queues; this stops the rebuild too. */
	abort(): void {
		this.cancelled = true;
		this.agent?.abort();
	}

	/** Why the lease ends, read off how the activation went. */
	get reason(): EndReason {
		if (this.failed) return 'failed';
		return 'released';
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

	/** One pass. True when the record moved past acknowledged context. */
	private async pass(): Promise<boolean> {
		try {
			const opened = await this.host.view();
			if ('stale' in opened || this.cancelled) return false;
			const view = opened.view;
			// The fresh view becomes acknowledged only when Pi sends it to a provider.
			this.held = [];
			this.providerStarted = false;
			const built = await this.host.build(view, this);
			if (this.cancelled) return false;
			const { agent, context } = built;
			this.agent = agent;
			agent.subscribe((event) => this.note(event));
			await agent.prompt(this.context.initial(view.through, context, this.host.now()));
			const failure = this.executionFailure(agent);
			await this.audit(agent);
			if (failure !== undefined) return false;
			// An aborted activation stays cancelled, and one that does not rebuild
			// is a single pass whatever landed: a summarising activation answers its
			// fixed closed exchange.
			if (this.cancelled || view.spec.purpose.kind !== 'respond') return false;
			// Awaited here, so a renewal that fails is caught below and not returned as a rejection.
			return await this.needsRefresh(agent);
		} catch (error) {
			return this.broke(error instanceof Error ? error : new Error(String(error)));
		}
	}

	/**
	 * Whether the record moved past acknowledged context. A queued steer or a
	 * newer room position requires a fresh view. A dropped steer stays on the
	 * record and is delivered again by that view.
	 */
	private async needsRefresh(agent: Agent): Promise<boolean> {
		const renewed = await this.host.renew(this.readThrough);
		if ('stale' in renewed) return false;
		if (!agent.hasQueuedMessages() && renewed.ok.lastSeq <= this.readThrough) return false;
		agent.clearAllQueues();
		return true;
	}

	/**
	 * Tool events are room-visible. Pi context consumption is recorded at the
	 * provider request boundary by `PiContext`, not by transcript event text.
	 */
	private note(event: AgentEvent): void {
		if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
			// `say` is the room's own event, not a tool's.
			if (event.toolName !== 'say') {
				this.host.emit({ type: event.type, agent: this.seat, toolName: event.toolName });
			}
			return;
		}
	}

	/** Record the provider outcome before audit I/O can delay a lease release. */
	private executionFailure(agent: Agent): Error | undefined {
		const failure = failureOf(agent);
		if (failure === undefined) return undefined;
		this.failed = true;
		this.host.emit({ type: 'error', agent: this.seat, error: failure });
		return failure;
	}

	/** Audit failure is diagnostic only. It never changes the provider outcome. */
	private async audit(agent: Agent): Promise<void> {
		try {
			await this.host.persist(agent);
		} catch (error) {
			try {
				this.host.emit({
					type: 'audit_error',
					agent: this.seat,
					activation: this.id,
					error: asError(error),
				});
			} catch {
				// Audit diagnostics must never change the execution outcome.
			}
		}
	}

	/** Record an execution failure and notify the host. */
	private broke(error: Error): false {
		this.failed = true;
		this.host.emit({ type: 'error', agent: this.seat, error });
		return false;
	}
}

function failureOf(agent: Agent): Error | undefined {
	const last = agent.state.messages.at(-1);
	if (last && 'stopReason' in last && last.stopReason === 'error') {
		return new Error(('errorMessage' in last && last.errorMessage) || 'The activation failed.');
	}
	return undefined;
}

/** Every turn a model took, in the downstream session that owns it. */
export async function persistTurns(
	open: () => Promise<PiSession>,
	agent: Agent,
	at: string,
): Promise<void> {
	const batch = crypto.randomUUID();
	const messages = agent.state.messages.map((message) => {
		// Provider messages may carry undefined-valued fields, which Pi's
		// durability check rejects; a JSON round-trip drops them.
		return JSON.parse(JSON.stringify(message)) as AgentMessage;
	});
	for (let attempt = 0; attempt < AUDIT_ATTEMPTS; attempt += 1) {
		try {
			const piSeat = await open();
			await piSeat.appendEntry(
				{
					type: 'custom',
					id: `${batch}:activation`,
					customType: 'ambion/activation',
					data: { at },
				},
				'main',
			);
			for (const [index, message] of messages.entries()) {
				await piSeat.appendEntry(
					{
						type: 'message',
						id: `${batch}:message:${index}`,
						message,
					},
					'main',
				);
			}
			return;
		} catch (error) {
			if (attempt === AUDIT_ATTEMPTS - 1) throw error;
		}
	}
}

/** Audit gets one retry for a lost or refused write in this activation. */
const AUDIT_ATTEMPTS = 2;

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
