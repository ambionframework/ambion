/**
 * Every scenario, on every storage, on a clock the test holds. `memory` is
 * where the scenarios prove the room; `jsonl` proves the same room writes
 * through to disk and reads back.
 */
import { describe, it } from 'vitest';
import { createRuntime } from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import { roomName } from './support/room.ts';
import { scenarios } from './support/scenarios.ts';
import { storages } from './support/storage.ts';

describe.each(storages)('the scenarios on $name', (storage) => {
	for (const scenario of scenarios) {
		it(scenario.name, async () => {
			const opened = await storage.open();
			try {
				const runtime = createRuntime({ sessions: opened.sessions, clock: fakeClock() });
				await scenario.run({ runtime, name: roomName(`matrix-${storage.name}`) });
			} finally {
				await opened.dispose();
			}
		});
	}
});
