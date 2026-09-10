/** Resolves once `read` returns a truthy value, or fails after `ms`. Alarms fire on their own in workerd. */
export async function until<T>(read: () => Promise<T | undefined | false>, ms = 5_000): Promise<T> {
	const deadline = Date.now() + ms;
	while (true) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Nothing came within ${ms} ms.`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
