/**
 * Stubs for the two objects `wrangler.jsonc` binds, and the ways a test
 * reaches inside one. `runInDurableObject` and the test share one isolate.
 */
import { env, runInDurableObject } from 'cloudflare:test';

export const roomOf = (name: string) => env.ROOM.get(env.ROOM.idFromName(name));

export const seatOf = (room: string, seat = 'product') =>
	env.SEAT.get(env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', room, seat])));

/**
 * Take the object away, the way the platform may take it. The abort breaks
 * the stub that held it, so what comes next takes a stub of its own.
 */
export async function evict(stub: DurableObjectStub, reason: string): Promise<void> {
	await runInDurableObject(stub, (_instance, state) => {
		state.abort(reason);
	}).catch(() => {});
}

/** Run `use` on the object itself, typed as the internals the test reaches. */
export function inside<T, R>(
	stub: DurableObjectStub,
	use: (object: T, state: DurableObjectState) => Promise<R>,
): Promise<R> {
	return runInDurableObject(stub, (instance, state) => use(instance as unknown as T, state));
}
