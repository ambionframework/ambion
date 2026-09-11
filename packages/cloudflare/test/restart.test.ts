/**
 * The room object goes away while a seat is at work, and comes back.
 *
 * This is the partial failure the platform makes ordinary: one object is
 * evicted, and the objects around it keep running. The seat holds a lease the
 * dead run wrote, and its credential is that row on the log, not a session
 * with the process that wrote it. The room that comes back folds the same row
 * and serves the same activation, so the work in flight is not lost.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import type { LeaseRow, RunRow } from '@ambionframework/ambion';
import { isSpoken } from '@ambionframework/ambion';
import { expect, it } from 'vitest';
import { sqlSessions } from '../src/storage.ts';
import { until } from './until.ts';

const NAME = 'room-restart';

/** Every row of one kind on the room's log, read through a fresh look at its storage. */
async function rows<T>(stub: DurableObjectStub, type: string): Promise<T[]> {
	const found = await runInDurableObject(stub, async (_instance, state) => {
		const piSession = await sqlSessions(state).open(NAME);
		return piSession.findEntries({ customType: `ambion/${type}` });
	});
	return found.map((entry) => (entry as { data: T }).data);
}

/** The run that wrote each row of one kind: every entry a fenced run writes carries it. */
const writers = async (stub: DurableObjectStub, type: string): Promise<(string | undefined)[]> =>
	(await rows<{ written?: string }>(stub, type)).map((row) => row.written);

it('serves a seat that was at work when the object went away, and takes its commit after', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName(NAME));
	await stub.start({ name: NAME, assistant: 'assistant', agents: ['slow'] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	await stub.deliver({ from: 'priya', text: 'Anyone on the pour date?', key: 'q1' });

	// The seat claimed its lease, so its activation runs now. The model call it
	// waits on is what keeps it running while the room goes away.
	const claim = await until(async () => (await rows<LeaseRow>(stub, 'lease')).at(0));
	expect(claim.id).toBe('2:slow');
	const claimedBy = (await writers(stub, 'lease')).at(0);
	const firstRun = (await rows<RunRow>(stub, 'run')).map((row) => row.run).at(0);
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
	const runs = (await rows<RunRow>(again, 'run')).map((row) => row.run);
	expect(runs).toHaveLength(2);
	expect(runs.at(0)).toBe(firstRun);
	const messageRows = await rows<{ from?: string }>(again, 'message');
	const spoken = messageRows.findIndex((row) => row.from === 'slow');
	expect(spoken).toBeGreaterThan(-1);
	expect((await writers(again, 'message')).at(spoken)).toBe(runs.at(1));

	// The lease the first run wrote is the lease the second run released, under
	// one id: nothing expired, and no second attempt ran.
	const leases = await until(async () => {
		const held = await rows<LeaseRow>(again, 'lease');
		return held.at(-1)?.phase === 'ended' ? held : undefined;
	});
	expect(new Set(leases.map((row) => row.id))).toEqual(new Set(['2:slow']));
	expect(leases.at(-1)).toMatchObject({ phase: 'ended', reason: 'released' });
});
