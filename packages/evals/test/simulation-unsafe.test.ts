import { createRuntime, defineHuman, startRoom } from '@ambionframework/ambion';
import { expect, it } from 'vitest';
import { runEvals } from '../src/report.ts';
import { defineRoomEval } from '../src/simulation.ts';
import type { HumanDecision } from '../src/simulation-types.ts';

it('halts subsequent samples and skips grading when the human callback ignores cancellation', async () => {
	let setups = 0;
	let grades = 0;
	let stopped = 0;
	let decisionSignal: AbortSignal | undefined;
	const definition = defineRoomEval({
		id: 'unsafe-human',
		version: 1,
		input: {},
		humans: [defineHuman({ name: 'priya', identity: 'Asks a question.' })],
		limits: { maxActions: 1, settleTimeoutMs: 20 },
		simulator: {
			decide({ signal }) {
				decisionSignal = signal;
				return new Promise<HumanDecision>(() => undefined);
			},
		},
		async setup() {
			setups += 1;
			const room = await startRoom({
				name: `unsafe-human-${crypto.randomUUID()}`,
				agents: [],
				runtime: createRuntime(),
			});
			const stop = room.stop.bind(room);
			room.stop = async () => {
				stopped += 1;
				await stop();
			};
			return { room, fixture: {} };
		},
		async capture() {
			return {};
		},
		checks: [],
		judge: {
			id: 'judge',
			requires: ['simulation'],
			async evaluate() {
				grades += 1;
			},
		},
		async teardown() {},
	});
	const report = await runEvals([definition], {
		samples: 2,
		timeouts: { run: 500, settle: 100, cleanup: 100 },
	});
	expect(report.passed).toBe(false);
	expect(report.samples).toHaveLength(1);
	expect(report.samples[0]?.outcome.unsafeToContinue).toBe(true);
	expect(report.samples[0]?.outcome.halted).toBe(true);
	expect(report.samples[0]?.collections.simulation?.complete).toBe(false);
	expect(decisionSignal?.aborted).toBe(true);
	expect(setups).toBe(1);
	expect(grades).toBe(0);
	expect(stopped).toBe(1);
});
