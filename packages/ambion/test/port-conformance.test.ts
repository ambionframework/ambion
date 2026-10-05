import { memoryJournals } from '@ambionframework/journal';
/**
 * The port suite on the two in-process executions: the direct one, and the
 * one that sends every request and answer through JSON.
 */
import { describe, expect, it } from 'vitest';
import { pi } from '../../pi/src/index.ts';
import { type PortFixture, portConformance, speakOnce } from '../src/conformance.ts';
import { type Execution, hostingOf, localExecution } from '../src/hosting.ts';
import { createRuntime, defineAgent } from '../src/index.ts';
import { serializing } from './support/ports.ts';

const host = hostingOf(
	createRuntime({ storage: memoryJournals(), limits: { call: { attempts: 2, timeout: 1_000 } } }),
);

const fixtureOver = (execution: Execution): PortFixture => ({
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
const speaking = () => localExecution('port-conformance', () => () => speakOnce());

describe('localExecution', () => {
	for (const c of portConformance(fixtureOver(speaking()))) it(c.name, c.run);
});

describe('serializing(localExecution())', () => {
	const execution = serializing(speaking());
	for (const c of portConformance(fixtureOver(execution))) it(c.name, c.run);
	it('sends nothing that would not survive the wire', () => {
		expect(execution.violations).toEqual([]);
	});
});
