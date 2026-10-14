/** Helpers of the conformance cases that wait on a host or a runtime. */

/** Polls every 20 ms until `read` holds, or fails after `patience`. `read` may be async. */
export async function until(
	read: () => boolean | Promise<boolean>,
	patience: number,
	what: string,
): Promise<void> {
	const deadline = Date.now() + patience;
	while (!(await read())) {
		if (Date.now() > deadline) throw new Error(`Nothing came within ${patience} ms: ${what}.`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
