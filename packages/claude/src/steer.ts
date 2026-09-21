/**
 * The streaming input of one activation, and the echoes that confirm it.
 *
 * The Claude Agent SDK takes a prompt as an async iterable of user
 * messages. The activation pushes the first view, each later delta, and
 * each steered line into it. The SDK sends every message back as a user
 * message with `isReplay` set. The activation advances `readThrough` on
 * that echo and on nothing earlier: the model has the message only then.
 */
import type { Seq } from '@ambionframework/ambion/hosting';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** A queue the SDK reads as its prompt. `end` closes the input. */
export class Inbox implements AsyncIterable<SDKUserMessage> {
	private readonly queue: SDKUserMessage[] = [];
	private wake: (() => void) | undefined;
	private ended = false;

	push(message: SDKUserMessage): void {
		if (this.ended) return;
		this.queue.push(message);
		this.wake?.();
	}

	end(): void {
		this.ended = true;
		this.wake?.();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
		for (;;) {
			const next = this.queue.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			if (this.ended) return;
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
			this.wake = undefined;
		}
	}
}

/** One user message of the SDK's input format. The uuid is what the echo carries back. */
export function userMessage(text: string, uuid: string): SDKUserMessage {
	return {
		type: 'user',
		message: { role: 'user', content: text },
		parent_tool_use_id: null,
		uuid: uuid as SDKUserMessage['uuid'],
	};
}

/** What an echo confirms: the record position the message carried, and whether a steer sent it. */
export interface Sent {
	readonly through: Seq;
	/** The steered line's position and what the room had before it. Absent for a prompt. */
	readonly steer?: { readonly after: Seq };
}

/** The messages sent and not yet echoed, by uuid. */
export class Echoes {
	private readonly sent = new Map<string, Sent>();

	expect(uuid: string, sent: Sent): void {
		this.sent.set(uuid, sent);
	}

	/** The message this echo confirms, once. An echo of another message gives nothing. */
	confirm(uuid: string | undefined): Sent | undefined {
		if (uuid === undefined) return undefined;
		const found = this.sent.get(uuid);
		this.sent.delete(uuid);
		return found;
	}

	/** How many messages wait for their echo. */
	get waiting(): number {
		return this.sent.size;
	}
}
