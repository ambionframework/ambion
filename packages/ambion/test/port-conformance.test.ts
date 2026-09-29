/**
 * The port suite on the two in-process executions: the direct one, and the
 * one that sends every request and answer through JSON.
 */
import { describe, expect, it } from 'vitest';
import { pi } from '../../pi/src/index.ts';
import { type PortHarness, portConformance, speakOnce } from '../src/conformance.ts';
import { executionHostOf } from '../src/host/runtime.ts';
import { defineExecution, type Execution } from '../src/hosting.ts';
import { createRuntime, defineAgent } from '../src/index.ts';
import { serializing } from './support/ports.ts';

const host = executionHostOf(createRuntime({ limits: { call: { attempts: 2, timeout: 1_000 } } }));

const harnessOver = (execution: Execution): PortHarness => ({
	connect: async (room, names) =>
		execution.connector(host).connect(room, {
			room: names.room,
			seat: names.seat,
			definition: defineAgent({
				name: names.seat,
				identity: 'Answers once.',
				executor: pi({ instructions: '', model: 'scripted/seat' }),
			}),
			emit: () => {},
		}),
});

/** The execution of the suite: each seat speaks once, in this process. */
const speaking = () => defineExecution('port-conformance', () => () => speakOnce());

describe('defineExecution', () => {
	for (const c of portConformance(harnessOver(speaking()))) it(c.name, c.run);
});

describe('serializing(defineExecution())', () => {
	const execution = serializing(speaking());
	for (const c of portConformance(harnessOver(execution))) it(c.name, c.run);
	it('sends nothing that would not survive the wire', () => {
		expect(execution.violations).toEqual([]);
	});
});
