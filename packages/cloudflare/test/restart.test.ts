/**
 * The room object goes away while a seat is at work, and comes back.
 *
 * This is the partial failure the platform makes ordinary: one object is
 * evicted, and the objects around it keep running. The seat holds a lease the
 * dead run wrote, and its credential is that entry on the journal, and no session
 * with the process that wrote it. The room that comes back folds the same entry
 * and serves the same activation, so the work in flight is not lost.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import type { Fence, LeaseChange } from '@ambionframework/ambion';
import { isSpoken } from '@ambionframework/ambion';
import { expect, it } from 'vitest';
import { sqlSessions } from '../src/storage.ts';
import { until } from './until.ts';

const NAME = 'room-restart';

/** Every entry of one kind on the room's journal, read through a fresh look at its storage. */
async function stored<T>(stub: DurableObjectStub, type: string): Promise<T[]> {
	const found = await runInDurableObject(stub, async (_instance, state) => {
		const piSession = await sqlSessions(state).open(NAME);
		return piSession.findEntries({ customType: `ambion/${type}` });
	});
	return found.map((entry) => (entry as { data: T }).data);
}

/** The run that wrote each entry of one kind: every entry a fenced run writes carries it. */
const writers = async (stub: DurableObjectStub, type: string): Promise<(string | undefined)[]> =>
	(await stored<{ written?: string }>(stub, type)).map((entry) => entry.written);

it('serves a seat that was at work when the object went away, and takes its commit after', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName(NAME));
	await stub.start({ name: NAME, assistant: 'assistant', agents: ['slow'] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	await stub.deliver({ from: 'priya', text: 'Anyone on the pour date?', key: 'q1' });

	// The seat claimed its lease, so its activation runs now. The model call it
	// waits on is what keeps it running while the room goes away.
	const claim = await until(async () => (await stored<LeaseChange>(stub, 'lease')).at(0));
	expect(claim.id).toBe('2:slow');
	const claimedBy = (await writers(stub, 'lease')).at(0);
	const firstRun = (await stored<Fence>(stub, 'run')).map((entry) => entry.run).at(0);
	expect(claimedBy).toBe(firstRun);

	// The platform takes the room. The seat object is untouched and keeps working.
	await runInDurableObject(stub, async (_instance, state) => {
		state.abort('the test takes the room while the seat works');
	}).catch(() => {});

	// The next call builds the room again, and its constructor resumes the name.
	const again = env.ROOM.get(env.ROOM.idFromName(NAME));
	const said = await until(async () => {
		const messages = await again.messages().catch(() => []);
		return messages.find((message) => isSpoken(message) && message.from === 'slow');
	});
	expect(isSpoken(said) && said.text).toBe('The slow answer stands.');

	// Two runs took the name, and the seat's message was written by the second:
	// the commit crossed the restart, and the room that came back took it. A
	// message the first run wrote would mean the abort landed too late.
	const runs = (await stored<Fence>(again, 'run')).map((entry) => entry.run);
	expect(runs).toHaveLength(2);
	expect(runs.at(0)).toBe(firstRun);
	const messageRows = await stored<{ from?: string }>(again, 'message');
	const spoken = messageRows.findIndex((entry) => entry.from === 'slow');
	expect(spoken).toBeGreaterThan(-1);
	expect((await writers(again, 'message')).at(spoken)).toBe(runs.at(1));

	// The lease the first run wrote is the lease the second run released, and
	// nothing expired. Wait for this activation's own lease to end: the
	// assistant's draft takes a lease of its own after it, and this test says
	// nothing about that one.
	const leases = await until(async () => {
		const held = await stored<LeaseChange>(again, 'lease');
		const mine = held.filter((entry) => entry.id === claim.id);
		return mine.at(-1)?.phase === 'ended' ? held : undefined;
	});
	expect(leases.filter((entry) => entry.id === claim.id).at(-1)).toMatchObject({
		phase: 'ended',
		reason: 'released',
	});
	// The wake was answered on its first attempt: no id carries a second.
	const attempts = new Set(leases.map((entry) => entry.id).filter((id) => id.startsWith('2:slow')));
	expect([...attempts]).toEqual([claim.id]);
});
