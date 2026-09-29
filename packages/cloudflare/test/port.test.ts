/**
 * The port suite on `rpcExecution`, through workerd. The suite plays the
 * room: the test installs its recording room on the room object, so every
 * `view`, `commit`, and `lease` the seat object sends lands there. The seat
 * object runs the execution of its own host: the `product` definition on
 * the scripted model from `worker.ts`.
 *
 * `runInDurableObject` and the test share one isolate, so the recording
 * room's closures work. A pool that isolates objects needs `RoomObject`
 * to take the recording room through an option.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { type PortHarness, portConformance } from '@ambionframework/ambion/conformance';
import type { RoomProtocol } from '@ambionframework/ambion/hosting';
import { describe, it } from 'vitest';
import { seatHost } from '../src/configure.ts';
import { rpcExecution } from '../src/room-object.ts';
import { product } from './worker.ts';

const harness: PortHarness = {
	patience: 20_000,
	async connect(room, names) {
		const stub = env.ROOM.get(env.ROOM.idFromName(names.room));
		await runInDurableObject(stub, async (instance) => {
			(instance as unknown as { protocol(): RoomProtocol }).protocol = () => room;
		});
		return rpcExecution(env)
			.connector(seatHost())
			.connect(room, {
				room: names.room,
				seat: names.seat,
				definition: product,
				emit: () => {},
			});
	},
};

describe('rpcExecution', () => {
	for (const c of portConformance(harness)) it(c.name, c.run);
});
