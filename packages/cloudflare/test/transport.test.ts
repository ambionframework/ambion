/**
 * The transport suite on `rpcTransport`, through workerd. The suite plays the
 * room: the test installs its recording room on the room object, so every
 * `view`, `commit`, and `lease` the seat object sends lands there. The seat
 * runs the `product` definition on the scripted model from `worker.ts`.
 *
 * `runInDurableObject` and the test share one isolate, so the recording
 * room's closures work. A pool that isolates objects needs `RoomObject`
 * to take the recording room through an option.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { systemClock } from '@ambionframework/ambion';
import {
	speakOnce,
	type TransportHarness,
	transportConformance,
} from '@ambionframework/ambion/conformance';
import type { RoomProtocol } from '@ambionframework/ambion/hosting';
import { describe, it } from 'vitest';
import { rpcTransport } from '../src/room-object.ts';
import { product } from './worker.ts';

const harness: TransportHarness = {
	patience: 20_000,
	async connect(room, names) {
		const stub = env.ROOM.get(env.ROOM.idFromName(names.room));
		await runInDurableObject(stub, async (instance) => {
			(instance as unknown as { protocol(): RoomProtocol }).protocol = () => room;
		});
		return rpcTransport(env).connect(room, {
			clock: systemClock(),
			call: { attempts: 2, timeout: 1_000 },
			definition: product,
			room: names.room,
			seat: names.seat,
			executor: speakOnce(),
			trace: {
				open: () => ({
					startPass() {},
					record() {},
					usage: () => undefined,
					close: async () => {},
				}),
			},
		});
	},
};

describe('rpcTransport', () => {
	for (const c of transportConformance(harness)) it(c.name, c.run);
});
