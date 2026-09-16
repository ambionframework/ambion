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
import { isSpoken } from '@ambionframework/ambion';
import { namespaced } from '@ambionframework/journal';
import { expect, it } from 'vitest';
import { sqlStorage } from '../src/storage.ts';
import { until } from './until.ts';

const NAME = 'room-restart';

type LeaseObservation = { id: string; phase: 'running' | 'ended'; reason?: string };

/** Every entry of one kind on the room's journal, read through a fresh look at its storage. */
async function stored<T>(stub: DurableObjectStub, type: string): Promise<T[]> {
	const found = await runInDurableObject(stub, async (_instance, state) => {
		const journal = await namespaced(sqlStorage(state), 'ambion/room').open(NAME);
		return (await journal.read(0)).entries.map((entry) => entry.entry as { kind: string; body: T });
	});
	return found.filter((entry) => entry.kind === type).map((entry) => entry.body);
}

/** The run that wrote each entry of one kind: every entry a fenced run writes carries it. */
const writers = async (stub: DurableObjectStub, type: string): Promise<(string | undefined)[]> => {
	const found = await runInDurableObject(stub, async (_instance, state) => {
		const journal = await namespaced(sqlStorage(state), 'ambion/room').open(NAME);
		return (await journal.read(0)).entries.map(
			(entry) => entry.entry as { kind: string; run?: string },
		);
	});
	return found.filter((entry) => entry.kind === type).map((entry) => entry.run);
};

it('serves a seat that was at work when the object went away, and takes its commit after', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName(NAME));
	await stub.start({
		name: NAME,
		summary: 'assistant',
		seats: { slow: 'broadcast', assistant: 'none' },
		agents: ['slow', 'assistant'],
	});
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	const exchange = await stub.send({ from: 'priya', text: 'Anyone on the pour date?', key: 'q1' });

	// The seat claimed its lease, so its activation runs now. The model call it
	// waits on is what keeps it running while the room goes away.
	const claim = await until(async () => (await stored<LeaseObservation>(stub, 'lease')).at(0));
	expect(claim.id).toBe('message:4:slow:1');
	const claimedBy = (await writers(stub, 'lease')).at(0);
	const firstRun = (await writers(stub, 'run')).at(0);
	// Both sides read the journal's stamp, so say the stamp is there: two
	// entries a run never stamped agree with each other and prove nothing.
	expect(firstRun).toEqual(expect.any(String));
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
	const conversation = await again.exchangeMessages(exchange.from);
	expect(conversation[0]?.seq).toBe(exchange.from);
	const resumedNames = (await again.participants()).map((participant) => participant.name);
	expect(resumedNames).toContain('slow');
	expect(resumedNames).toContain('assistant');
	expect(resumedNames).toContain('priya');
	expect(resumedNames).not.toContain('product');
	await runInDurableObject(again, async (instance) => {
		await expect(instance.seat('product')).rejects.toThrow(/Unknown agent/);
	});
	// The serialized identity is enough to recover this handle after the object restart.
	expect(await again.exchange(exchange.from)).toEqual(exchange);

	// Two runs took the name, and the seat's message was written by the second:
	// the commit crossed the restart, and the room that came back took it. A
	// message the first run wrote would mean the abort landed too late.
	const runs = await writers(again, 'run');
	expect(runs).toHaveLength(2);
	expect(new Set(runs).size).toBe(2);
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
		const held = await stored<LeaseObservation>(again, 'lease');
		const mine = held.filter((entry) => entry.id === claim.id);
		return mine.at(-1)?.phase === 'ended' ? held : undefined;
	});
	expect(leases.filter((entry) => entry.id === claim.id).at(-1)).toMatchObject({
		phase: 'ended',
		reason: 'released',
	});
	// The wake was answered on its first attempt: no id carries a second.
	const attempts = new Set(
		leases.map((entry) => entry.id).filter((id) => id.startsWith('message:4:slow:1')),
	);
	expect([...attempts]).toEqual([claim.id]);
});
