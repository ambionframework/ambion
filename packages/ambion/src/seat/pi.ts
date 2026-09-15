/** Pi-specific context delivery and consumption tracking for one activation. */
import type { UserMessage } from '@earendil-works/pi-ai';
import type { Seq } from '../types.ts';

interface ContextRange {
	after: Seq;
	through: Seq;
}

interface PiSteeringPort {
	steer(message: UserMessage): void;
}

/** Pi owns its transcript. This adapter keeps structured ranges outside it. */
export class PiContext {
	private read = 0;
	private readonly ranges = new WeakMap<object, ContextRange>();
	private readonly consumed = new Map<Seq, ContextRange>();
	private readonly toolResults = new Map<string, Seq>();

	get readThrough(): Seq {
		return this.read;
	}

	initial(through: Seq, line: string, timestamp: number): UserMessage {
		const message = userMessage(line, timestamp);
		this.ranges.set(message, { after: 0, through });
		return message;
	}

	steer(
		agent: PiSteeringPort,
		context: { after: Seq; seq: Seq; line: string },
		timestamp: number,
	): void {
		const message = userMessage(`[new] ${context.line}`, timestamp);
		this.ranges.set(message, { after: context.after, through: context.seq });
		agent.steer(message);
	}

	toolResultExpected(toolCallId: string, through: Seq): void {
		this.toolResults.set(toolCallId, through);
	}

	/** Called at the provider boundary with Pi's exact request input. */
	providerRequestStarted(messages: readonly object[]): void {
		for (const message of messages) {
			const range = this.ranges.get(message);
			if (range !== undefined) this.consumed.set(range.through, range);
			const toolCallId = toolResultId(message);
			if (toolCallId !== undefined) {
				const through = this.toolResults.get(toolCallId);
				if (through !== undefined) {
					this.read = Math.max(this.read, through);
					this.toolResults.delete(toolCallId);
				}
			}
		}
		this.acknowledgeConsumed();
	}

	acknowledgeThrough(seq: Seq): void {
		this.read = Math.max(this.read, seq);
	}

	private acknowledgeConsumed(): void {
		while (true) {
			const next = [...this.consumed.values()]
				.filter((range) => range.after <= this.read && range.through > this.read)
				.sort((left, right) => left.through - right.through)[0];
			if (next === undefined) return;
			this.read = next.through;
			this.consumed.delete(next.through);
		}
	}
}

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: 'user', content: text, timestamp };
}

function toolResultId(message: object): string | undefined {
	if (!('role' in message) || message.role !== 'toolResult' || !('toolCallId' in message))
		return undefined;
	return typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
}
