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
import type { ReadRange } from './executor.ts';

export class Freshness {
	private read: Seq = 0;
	/** Ranges the model consumed that do not yet join the position read. */
	private readonly consumed = new Map<Seq, ReadRange>();
	/** Tool results that carry record, by call id. */
	private readonly results = new Map<string, Seq>();

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

	/** The result of the tool call `call` reached the model. */
	delivered(call: string): void {
		const through = this.results.get(call);
		if (through === undefined) return;
		this.results.delete(call);
		this.acknowledgeThrough(through);
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
