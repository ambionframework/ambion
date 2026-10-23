/**
 * The longest wait of one timer. A timer counts monotonic time, and a sleep
 * of the host does not count. The alarm reads the wall clock again at this
 * interval, so an alarm that fell due during a sleep fires within this
 * interval of the wake.
 */
const CHECK_MS = 30_000;

/** The system clock and its unref'd alarm used when `createRuntime` gets no clock. */
export function systemClock(): {
	now(): number;
	alarm(at: number, fire: () => void): () => void;
} {
	return {
		now: () => Date.now(),
		alarm(at, fire) {
			let timer: ReturnType<typeof setTimeout>;
			const wait = () => {
				const remaining = at - Date.now();
				timer = setTimeout(
					() => (Date.now() >= at ? fire() : wait()),
					Math.min(CHECK_MS, Math.max(0, remaining)),
				);
				timer.unref?.();
			};
			wait();
			return () => clearTimeout(timer);
		},
	};
}
