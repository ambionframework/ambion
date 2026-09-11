/**
 * Every scenario, on every storage, on a clock the test holds. `memory` is
 * where the scenarios prove the room; `jsonl` proves the same room writes
 * through to disk and reads back.
 */
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../src/host.ts';
import { inProcessTransport } from '../src/protocol.ts';
import { fakeClock } from './support/clock.ts';
import { roomName } from './support/room.ts';
import { scenarios } from './support/scenarios.ts';
import { storages } from './support/storage.ts';
import { serializing } from './support/transport.ts';

describe.each(storages)('the scenarios on $name', (storage) => {
	for (const scenario of scenarios) {
		it(scenario.name, async () => {
			const opened = await storage.open();
			// Every request and response between a seat and the room crosses as JSON.
			const transport = serializing(inProcessTransport());
			try {
				const runtime = createRuntime({ sessions: opened.sessions, clock: fakeClock(), transport });
				await scenario.run({ runtime, name: roomName(`matrix-${storage.name}`) });
				expect(transport.violations).toEqual([]);
			} finally {
				await opened.dispose();
			}
		});
	}
});
