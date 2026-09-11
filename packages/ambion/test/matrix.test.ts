/**
 * Every scenario, on every storage, on a clock the test holds. `memory` is
 * where the scenarios prove the room; `jsonl` proves the same room writes
 * through to disk and reads back.
 *
 * `@ambionframework/workspace` runs the same harness over the one scenario
 * that needs a workspace backend.
 */
import { describe, it } from 'vitest';
import { runScenario, scenarios } from './support/scenarios.ts';
import { storages } from './support/storage.ts';

describe.each(storages)('the scenarios on $name', (storage) => {
	for (const scenario of scenarios) {
		it(scenario.name, () => runScenario(storage, scenario, `matrix-${storage.name}`));
	}
});
