/** Queues keyed by name. The operations of one name run one at a time, in call order. */
export class Queues {
	private readonly tails = new Map<string, Promise<unknown>>();

	/** Runs the operation after the calls in flight on that name. */
	run<T>(name: string, operation: () => Promise<T>): Promise<T> {
		const result = (this.tails.get(name) ?? Promise.resolve()).then(operation);
		const settled = result.then(
			() => {},
			() => {},
		);
		this.tails.set(name, settled);
		void settled.then(() => {
			if (this.tails.get(name) === settled) this.tails.delete(name);
		});
		return result;
	}

	/** Waits for the calls in flight. A call that comes later is not part of the wait. */
	async settled(): Promise<void> {
		await Promise.all([...this.tails.values()]);
	}
}
