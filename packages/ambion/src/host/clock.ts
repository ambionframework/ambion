/**
 * The longest delay `setTimeout` takes. A longer one fires at once, so the
 * alarm waits this long, and the pass that it starts arms the rest.
 */
const LONGEST_DELAY = 2 ** 31 - 1;

/** The system clock and its unref'd alarm used by the default runtime. */
export function systemClock(): {
	now(): number;
	alarm(at: number, fire: () => void): () => void;
} {
	return {
		now: () => Date.now(),
		alarm(at, fire) {
			const timer = setTimeout(fire, Math.min(LONGEST_DELAY, Math.max(0, at - Date.now())));
			timer.unref?.();
			return () => clearTimeout(timer);
		},
	};
}
