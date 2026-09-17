/** The system clock and its unref'd alarm used by the default runtime. */
export function systemClock(): {
	now(): number;
	alarm(at: number, fire: () => void): () => void;
} {
	return {
		now: () => Date.now(),
		alarm(at, fire) {
			const timer = setTimeout(fire, Math.max(0, at - Date.now()));
			timer.unref?.();
			return () => clearTimeout(timer);
		},
	};
}
