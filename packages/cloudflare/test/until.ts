/**
 * Resolves once `read` returns a truthy value, or fails after `ms`. Alarms
 * fire on their own in workerd.
 *
 * The deadline is generous on purpose. workerd transforms a large module
 * graph on the first import, and a wake or a cut crosses an RPC stub
 * between two objects, so how long a fact takes to arrive is the runner's
 * speed and not the room's behaviour. `vitest.config.ts` gives a test a
 * minute for the same reason. A wait that is short enough to lose to a
 * loaded runner reports a failure the room did not cause.
 */
export async function until<T>(
	read: () => Promise<T | undefined | false>,
	ms = 20_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	while (true) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Nothing came within ${ms} ms.`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
