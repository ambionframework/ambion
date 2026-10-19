/**
 * A failure of the room reaches the host as an `error` event with no seat
 * and no activation. The room looks again after the resend window, so a
 * fault that lasts fails again on each look. The host hears it once for the
 * streak, and again when the failure changes or returns after a pass that
 * succeeded. The room arms its alarm again after each failure.
 */
import { describe, expect, it, vi } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	createRuntime,
	definePerson,
	type Room,
	type RoomNotification,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { roomName } from './support/room.ts';
import { quiet, scriptedStream } from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { faultyJournals, memory } from './support/storage.ts';

const broken = vi.hoisted(() => ({ decide: false }));
vi.mock('../src/room/transition.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/room/transition.ts')>();
	const decide = (...args: unknown[]): unknown => {
		if (broken.decide && (args[1] as { type: string }).type === 'reconcile')
			throw new Error('the rule failed');
		return (actual.decide as (...call: unknown[]) => unknown)(...args);
	};
	return { ...actual, decide };
});

const priya = definePerson({ name: 'priya', identity: 'Project manager.' });
const RESEND = 5_000;

describe('a failure of the room', () => {
	const open = async () => {
		const opened = await openFor(memory);
		const faulty = faultyJournals(opened.storage);
		const clock = fakeClock();
		const room: Room = stopAtEnd(
			await startRoom({
				name: roomName('room-failure'),
				runtime: createRuntime({ clock, storage: faulty.journals }),
				execution: piExecution({ sessions: 'memory', stream: scriptedStream(() => quiet()) }),
			}),
		);
		const events: RoomNotification[] = [];
		const errors = () => events.filter((event) => event.type === 'error');
		return {
			clock,
			faulty,
			room,
			errors,
			listen: () => room.subscribe((event) => events.push(event)),
		};
	};

	it('reports a write that the storage refuses once for the streak, and again after a success', async () => {
		const { clock, faulty, room, errors, listen } = await open();
		const visit = await room.visit(priya);
		faulty.fail('before', 'close');
		const first = await visit.send({ text: 'First?' });
		// A failure that no listener heard is new to the first one that subscribes.
		await clock.advance(RESEND * 2);
		listen();
		await clock.advance(RESEND * 4);
		expect(errors()).toEqual([{ type: 'error', error: new Error('the disk is full') }]);

		faulty.fail(false);
		await clock.advance(RESEND);
		await first.waitForClose();
		expect(errors()).toHaveLength(1);

		faulty.fail('before', 'close');
		await visit.send({ text: 'Second?' });
		await clock.advance(RESEND * 4);
		expect(errors()).toHaveLength(2);
	});

	it('reports a throw in decide, and arms the alarm again', async () => {
		const { clock, room, errors, listen } = await open();
		listen();
		const visit = await room.visit(priya);
		broken.decide = true;
		try {
			const exchange = await visit.send({ text: 'Is it green?' });
			await clock.advance(RESEND * 4);
			expect(errors()).toEqual([{ type: 'error', error: new Error('the rule failed') }]);

			broken.decide = false;
			await clock.advance(RESEND);
			await exchange.waitForClose();
		} finally {
			broken.decide = false;
		}
	});
});
