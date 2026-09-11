import type { Clock } from '../../src/internal.ts';

/** A clock a test moves by hand. Alarms fire inside `advance`, in order. */
export interface FakeClock extends Clock {
	/** Move the clock forward, firing every alarm due on the way, in time order. */
	advance(ms: number): Promise<void>;
}

interface Pending {
	at: number;
	fire: () => void;
}

/**
 * Let the promise chains an alarm started run to their end. A storage on
 * disk answers a write after real I/O, so the wait yields real time too:
 * a few milliseconds, several times, with the event loop drained between.
 */
const settle = async (): Promise<void> => {
	for (let round = 0; round < 5; round += 1) {
		for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
};

export function fakeClock(start = Date.parse('2026-01-01T09:00:00.000Z')): FakeClock {
	let now = start;
	const pending = new Set<Pending>();
	const next = (): Pending | undefined =>
		[...pending].sort((a, b) => a.at - b.at).find((alarm) => alarm.at <= now);
	return {
		now: () => now,
		alarm(at, fire) {
			const alarm: Pending = { at, fire };
			pending.add(alarm);
			return () => pending.delete(alarm);
		},
		async advance(ms) {
			const target = now + ms;
			while (true) {
				const due = [...pending]
					.filter((alarm) => alarm.at <= target)
					.sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				now = Math.max(now, due.at);
				pending.delete(due);
				due.fire();
				await settle();
				// An alarm the firing scheduled for now or earlier fires in this same pass.
				if (next() === undefined && now >= target) break;
			}
			now = target;
			await settle();
		},
	};
}
