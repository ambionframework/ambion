/**
 * The position one activation read through, from what reached the model.
 *
 * The executor reports each range of the record that the model consumed: a
 * prompt, a delta, or a steered line. A range counts as read when it joins
 * the position already read. A line that lands out of order waits, and it
 * counts once the gap closes. An accepted say moves the position, and so
 * does a tool result that carries record once it reaches the model.
 */

import type { Seq } from '../types.ts';
import type { ReadRange } from './contract.ts';

export class Freshness {
	private read: Seq = 0;
	/** Ranges the model consumed that do not yet join the position read. */
	private readonly consumed = new Map<Seq, ReadRange>();
	/** Tool results that carry record, by call id. */
	private readonly results = new Map<string, Seq>();
	/** The nested calls whose results a `compose` call shows, by the id of that call. */
	private readonly shown = new Map<string, string[]>();

	get readThrough(): Seq {
		return this.read;
	}

	/** Something other than the input of the model confirmed the record through `seq`. */
	acknowledgeThrough(seq: Seq): void {
		this.read = Math.max(this.read, seq);
	}

	/** The result of the tool call `call` carries the record through `seq`. */
	resultExpected(call: string, seq: Seq): void {
		this.results.set(call, seq);
	}

	/** The result of the `compose` call `compose` shows the results of the nested calls `calls`. */
	reported(compose: string, calls: readonly string[]): void {
		this.shown.set(compose, [...(this.shown.get(compose) ?? []), ...calls]);
	}

	/**
	 * The result of the tool call `call` reached the model. For a `compose`
	 * call, the nested results that it showed reached the model with it. A
	 * nested result that the compose result does not show stays unread.
	 */
	delivered(call: string): void {
		const ids = [call, ...(this.shown.get(call) ?? [])];
		this.shown.delete(call);
		for (const id of ids) {
			const through = this.results.get(id);
			if (through === undefined) continue;
			this.results.delete(id);
			this.acknowledgeThrough(through);
		}
		this.join();
	}

	/**
	 * The model consumed `range`. A range at or below the position read adds
	 * nothing. Of two ranges through the same position, the one that starts
	 * lower stays, because it joins first.
	 */
	consumedRange(range: ReadRange): void {
		const held = this.consumed.get(range.through);
		if (range.through > this.read && (held === undefined || range.after < held.after)) {
			this.consumed.set(range.through, range);
		}
		this.join();
	}

	/**
	 * Advance through every held range that joins the position read, lowest
	 * first, and drop each range the position read covers. The order the
	 * ranges came in does not change where the position ends.
	 */
	private join(): void {
		for (;;) {
			for (const through of this.consumed.keys()) {
				if (through <= this.read) this.consumed.delete(through);
			}
			const next = [...this.consumed.values()]
				.filter((range) => range.after <= this.read)
				.sort((left, right) => left.through - right.through)[0];
			if (next === undefined) return;
			this.read = next.through;
		}
	}
}
