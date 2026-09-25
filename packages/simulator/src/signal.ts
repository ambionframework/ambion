/** A signal that aborts after `ms` real milliseconds, with `message` as its reason. */
export function deadlineSignal(
	ms: number,
	message: string,
): { readonly signal: AbortSignal; clear(): void } {
	if (!Number.isFinite(ms) || ms <= 0) {
		throw new RangeError('`timeoutMs` must be a positive number of milliseconds.');
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(message)), ms);
	return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
