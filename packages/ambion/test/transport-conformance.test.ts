/**
 * The transport suite on the two in-process transports: the direct one, and
 * the one that sends every request and answer through JSON.
 */
import { describe, expect, it } from 'vitest';
import { speakOnce, type TransportHarness, transportConformance } from '../src/conformance.ts';
import type { Transport } from '../src/hosting.ts';
import { inProcessTransport } from '../src/hosting.ts';
import { defineAgent, pi, systemClock } from '../src/index.ts';
import { noTraces } from './support/trace.ts';
import { serializing } from './support/transport.ts';

const harnessOver = (transport: Transport): TransportHarness => ({
	connect: async (room, names) =>
		transport.connect(room, {
			clock: systemClock(),
			call: { attempts: 2, timeout: 1_000 },
			definition: defineAgent({
				name: names.seat,
				identity: 'Answers once.',
				executor: pi({ instructions: '', model: 'scripted/seat' }),
			}),
			room: names.room,
			seat: names.seat,
			executor: speakOnce(),
			trace: noTraces,
		}),
});

describe('inProcessTransport', () => {
	for (const c of transportConformance(harnessOver(inProcessTransport()))) it(c.name, c.run);
});

describe('serializing(inProcessTransport())', () => {
	const transport = serializing(inProcessTransport());
	for (const c of transportConformance(harnessOver(transport))) it(c.name, c.run);
	it('sends nothing that would not survive the wire', () => {
		expect(transport.violations).toEqual([]);
	});
});
