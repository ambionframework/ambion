/** Multiplex room timers over the single alarm of a Durable Object. */
import type { Clock } from '@ambionframework/ambion';

interface AlarmStorage {
	setAlarm(at: number): Promise<void>;
	deleteAlarm(): Promise<void>;
}

interface Timer {
	at: number;
	fire: () => void;
}

export class RoomClock implements Clock {
	private readonly timers = new Set<Timer>();
	private writes = Promise.resolve();

	constructor(
		private readonly storage: AlarmStorage,
		private readonly keepAlive: (work: Promise<void>) => void,
		readonly now: () => number = Date.now,
	) {}

	alarm(at: number, fire: () => void): () => void {
		const timer = { at, fire };
		this.timers.add(timer);
		this.changed();
		return () => {
			if (this.timers.delete(timer)) this.changed();
		};
	}

	/** Fire due callbacks; each room derives its next timer from its journal. */
	async fire(): Promise<void> {
		const now = this.now();
		const due = [...this.timers].filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at);
		try {
			for (const timer of due) {
				if (this.timers.delete(timer)) timer.fire();
			}
		} finally {
			this.changed();
			await this.settled();
		}
	}

	/** Wait until every queued change has reached native alarm storage. */
	async settled(): Promise<void> {
		let observed: Promise<void>;
		do {
			observed = this.writes;
			await observed;
		} while (observed !== this.writes);
	}

	private changed(): void {
		this.writes = this.writes.catch(() => {}).then(() => this.schedule());
		this.keepAlive(this.writes);
	}

	private async schedule(): Promise<void> {
		if (this.timers.size === 0) {
			await this.storage.deleteAlarm();
			return;
		}
		const next = Math.min(...[...this.timers].map((timer) => timer.at));
		await this.storage.setAlarm(next);
	}
}
