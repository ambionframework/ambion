import { describe, expect, it } from 'vitest';
import { createRuntime, definePerson, startRoom } from '../src/index.ts';
import { observed } from './support/core-failure.ts';
import { deferred, messagesOf, roomName, storedOf } from './support/room.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { faultyJournals, gatedJournals, storages } from './support/storage.ts';

const person = definePerson({ name: 'visitor', identity: 'Visits the room.' });
const operations = ['arrival', 'departure', 'cancel', 'stop'] as const;

describe.each(storages)('shared append failures on $name storage', (storage) => {
	it.each(
		operations.flatMap((operation) =>
			(['before', 'after'] as const).map((phase) => ({ operation, phase })),
		),
	)('shares a $phase-commit $operation failure and permits retry', async ({ operation, phase }) => {
		const opened = await openFor(storage);
		const faulty = faultyJournals(opened.storage);
		const started = deferred();
		const release = deferred();
		let armed = false;
		const kind = operation === 'cancel' ? 'cancel' : 'message';
		const journals = gatedJournals(faulty.journals, (entryKind) => {
			if (!armed || entryKind !== kind) return;
			armed = false;
			started.resolve();
			return release.promise;
		});
		const room = stopAtEnd(
			await startRoom({
				name: roomName('append-flight'),
				runtime: createRuntime({ storage: journals }),
			}),
		);
		const visit = operation === 'arrival' ? undefined : await room.visit(person);
		const execute = async (): Promise<void> => {
			switch (operation) {
				case 'arrival':
					await room.visit(person);
					return;
				case 'departure': {
					if (visit === undefined) throw new Error('The visit is absent.');
					return visit.leave();
				}
				case 'cancel':
					return room.cancel();
				case 'stop':
					return room.stop();
			}
		};
		armed = true;
		faulty.fail(phase, kind);
		const first = observed(execute());
		await started.promise;
		const second = observed(execute());
		const outcomes = Promise.allSettled([first, second]);
		release.resolve();
		for (const outcome of await outcomes) {
			expect(outcome.status).toBe('rejected');
			if (outcome.status === 'rejected') expect(outcome.reason.message).toMatch(/disk is full/);
		}
		faulty.fail(false);
		await execute();
		await execute();
		if (operation === 'cancel') {
			expect(
				(await storedOf(opened.journals, room.name)).filter((entry) => entry.kind === 'cancel'),
			).toHaveLength(2);
		} else {
			const expected = operation === 'arrival' ? 'arrived' : 'left';
			expect((await messagesOf(room)).filter((message) => message.kind === expected)).toHaveLength(
				1,
			);
		}
	});
});
