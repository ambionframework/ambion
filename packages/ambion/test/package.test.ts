import { expect, it } from 'vitest';
import * as application from '../src/index.ts';
import * as host from '../src/host.ts';
import * as node from '../src/node.ts';
import * as protocol from '../src/protocol.ts';

it('keeps the default entry point to the five application primitives', () => {
	expect(Object.keys(application).sort()).toEqual([
		'defineAgent',
		'defineHuman',
		'defineTool',
		'defineWorkspace',
		'startSession',
	]);
});

it('lists the host adapter API', () => {
	expect(Object.keys(host).sort()).toEqual([
		'attentive',
		'createRuntime',
		'createSeatActor',
		'defaultRuntime',
		'destroyWorkspace',
		'inProcessTransport',
		'isPresence',
		'isSeatedAgent',
		'isSpoken',
		'isSummary',
		'passive',
		'readSession',
		'resumeSession',
		'seated',
		'sessionsOver',
		'sqliteSessions',
		'stopSession',
		'systemClock',
		'visitSession',
	]);
});

it('lists the protocol API', () => {
	expect(Object.keys(protocol).sort()).toEqual(['assertWire', 'roundTrip']);
});

it('lists the Node adapter API', () => {
	expect(Object.keys(node).sort()).toEqual(['directoryBackend', 'memoryBackend']);
});
