/**
 * The bridge: each finished exchange of a breakout room reaches the opener once. A report
 * carries the result of an exchange. An exchange with no report gets a close notice.
 *
 * The bridge posts for one parent in order, in a chain of its own. A root stop awaits the
 * queues of its breakout rooms from inside the queue of the root, so a bridge post never
 * enters the queue of a room. The chain waits on the kernel alone, and no wait is a cycle.
 */
import {
	AmbionError,
	type ExchangeOutcome,
	type ExchangeRange,
	messageUri,
	type Room,
	type Runtime,
	readRoom,
} from '@ambionframework/ambion';
import { seqUnder, startOf } from './breakout.ts';
import { Queues } from './queue.ts';
import type { CanvasRoom } from './store.ts';

/** What the bridge reads from the canvas. */
export interface BridgeHost {
	readonly runtime: Runtime;
	row(name: string): CanvasRoom | undefined;
	rows(): readonly CanvasRoom[];
	/** The live handle of a room of this run. */
	room(name: string): Room | undefined;
	closed(): boolean;
	/** Reports a failed notice to `onError`. */
	fail(room: string, error: unknown): void;
}

export interface BridgePost {
	to?: string;
	text: string;
	refs?: string[];
	key: string;
}

/** The opener when it sits on the roster of the parent at an attention other than `none`. */
export async function recipientOf(parent: Room, opener: string): Promise<string | undefined> {
	const read = await parent.read({ messages: false });
	const seat = read.participants.find((one) => one.kind === 'agent' && one.name === opener);
	return seat?.kind === 'agent' && seat.attention !== 'none' ? opener : undefined;
}

/** Posts into the parent. A key that the parent holds already counts as landed. */
export async function land(parent: Room, post: BridgePost): Promise<number> {
	try {
		const handle = await parent.post(post);
		const seq = await seqUnder(parent, post.key, handle.from - 1);
		if (seq === undefined)
			throw new Error(`The room holds no message under the key "${post.key}".`);
		return seq;
	} catch (error) {
		// A refusal may mean that the key landed with other content. The record has no cheaper anchor than its start.
		const seq =
			error instanceof AmbionError && error.code === 'refused'
				? await seqUnder(parent, post.key, 0)
				: undefined;
		if (seq === undefined) throw error;
		return seq;
	}
}

/** The keys that the parent holds for one breakout room. */
function keysOf(messages: readonly { key?: string | undefined }[], name: string): string[] {
	const prefix = `breakout:${name}:`;
	return messages.flatMap((message) =>
		message.key?.startsWith(prefix) === true ? [message.key] : [],
	);
}

/** A key `breakout:<name>:<from>`, or one that starts with `breakout:<name>:<from>:`, means done. */
function isDone(keys: readonly string[], name: string, from: number): boolean {
	const own = `breakout:${name}:${from}`;
	return keys.some((key) => key === own || key.startsWith(`${own}:`));
}

/** The outcome as the notice words it: `awaiting` names the person that the exchange waits for. */
function outcomeOf(outcome: ExchangeOutcome): string {
	return outcome.kind === 'awaiting' ? `awaiting ${outcome.person}` : outcome.kind;
}

/** Names the outcome and the range, and cites the last message. It holds no excerpt. */
function noticeOf(name: string, exchange: ExchangeRange, outcome: ExchangeOutcome): string {
	return `breakout ${name}: exchange #${exchange.from} is ${outcomeOf(outcome)}, messages #${exchange.from} to #${exchange.through}.`;
}

export class Bridge {
	private readonly queues = new Queues();
	private readonly host: BridgeHost;

	constructor(host: BridgeHost) {
		this.host = host;
	}

	/** Runs the operation in the chain of one parent. */
	order<T>(parent: string, operation: () => Promise<T>): Promise<T> {
		return this.queues.run(parent, operation);
	}

	/** Waits for the posts in flight. */
	settled(): Promise<void> {
		return this.queues.settled();
	}

	/** One pass over one breakout room, in the chain of its parent. */
	pass(name: string): Promise<void> {
		const start = startOf(this.host.row(name));
		if (start === undefined) return Promise.resolve();
		return this.order(start.parent, () => this.notices(name));
	}

	/** One pass over every breakout room of a live parent, stopped rooms included. */
	async replay(parent: string): Promise<void> {
		for (const row of this.host.rows())
			if (startOf(row)?.parent === parent && row.state !== 'archived') await this.pass(row.name);
	}

	/** The room that a notice may still reach: not archived, and the canvas open. */
	private open(name: string): boolean {
		return !this.host.closed() && this.host.row(name)?.state !== 'archived';
	}

	private async notices(name: string): Promise<void> {
		const start = startOf(this.host.row(name));
		const parent = start === undefined ? undefined : this.host.room(start.parent);
		if (start === undefined || parent === undefined || !this.open(name)) return;
		try {
			const read = await readRoom(name, { runtime: this.host.runtime, messages: false });
			const keys = keysOf((await parent.read()).messages, name);
			for (const exchange of read.exchanges) {
				if (exchange.status !== 'closed' || isDone(keys, name, exchange.from)) continue;
				if (!this.open(name)) return;
				await this.notify(parent, name, start.opener, exchange, exchange.outcome);
			}
		} catch (error) {
			this.host.fail(name, error);
		}
	}

	/** Posts one close notice. A failure goes to `onError`, and the exchange keeps no key. */
	private async notify(
		parent: Room,
		name: string,
		opener: string,
		exchange: ExchangeRange,
		outcome: ExchangeOutcome,
	): Promise<void> {
		try {
			const to = await recipientOf(parent, opener);
			await land(parent, {
				...(to === undefined ? {} : { to }),
				text: noticeOf(name, exchange, outcome),
				refs: [messageUri(name, exchange.through)],
				key: `breakout:${name}:${exchange.from}`,
			});
		} catch (error) {
			// A parent that stops is not a failure: the pass of its next start posts the notice.
			if (!(error instanceof AmbionError && error.code === 'room_stopped'))
				this.host.fail(name, error);
		}
	}
}
