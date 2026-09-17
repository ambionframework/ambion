import { describe, expect, it } from 'vitest';
import { foldRoom } from '../src/room/fold.ts';
import { type RoomFacts, viewOf } from '../src/room/view.ts';
import type { ActivationSpec } from '../src/transport.ts';
import type { TaskView } from '../src/types.ts';

const at = '2026-01-01T00:00:00.000Z';

const task = (
	id: string,
	owner: string,
	exchange: number,
	workingRoom: string,
	status: TaskView['status'] = 'open',
): TaskView => ({
	id,
	text: `Work for ${id}.`,
	owner,
	originRoom: 'origin',
	exchange,
	workingRoom,
	agents: ['worker'],
	subscriptions: [{ room: 'origin', agent: owner, progress: false }],
	status,
	createdAt: at,
	events: [],
});

function facts(tasks: readonly TaskView[], working = false): RoomFacts {
	const state = foldRoom(
		[
			{
				kind: 'composition',
				seq: 1,
				body: {
					version: 2,
					agents: [],
					available: [],
					at,
					...(working ? { taskScope: { room: 'origin', exchange: 10 } } : {}),
				},
			},
			{
				kind: 'message',
				seq: 2,
				body: { kind: 'said', at, from: 'alice', text: 'Current request.' },
			},
		],
		{ backoff: () => 0 },
	);
	return {
		name: working ? 'child' : 'origin',
		now: Date.parse(at),
		state: {
			...state,
			exchange: { owner: 'alice', from: 10, at },
			tasks: new Map(tasks.map((item) => [item.id, item])),
		},
		live: new Map(),
		unseen: () => 0,
	};
}

const respond = (seat: string): ActivationSpec => ({
	id: `message:10:${seat}:1`,
	seat,
	attempt: 1,
	purpose: { kind: 'respond', message: 10 },
});

describe('Task activation context selection', () => {
	const currentAlice = task('current-alice', 'alice', 10, 'child');
	const finishedAlice = task('finished-alice', 'alice', 10, 'child', 'succeeded');
	const currentBob = task('current-bob', 'bob', 10, 'child', 'succeeded');
	const previousAlice = task('previous-alice', 'alice', 4, 'old-child');
	const otherChild = task('other-child', 'carol', 22, 'child', 'failed');
	const all = [currentAlice, currentBob, previousAlice, otherChild];

	it('limits ordinary activations to the seated owner’s Tasks in the current exchange', () => {
		const room = facts(all);
		expect(viewOf(respond('alice'), room).context.tasks?.map((item) => item.id)).toEqual([
			'current-alice',
		]);
		expect(viewOf(respond('bob'), room).context.tasks?.map((item) => item.id)).toEqual([
			'current-bob',
		]);
	});

	it('gives a summary activation every Task owned by its exchange, including terminal status', () => {
		const summary: ActivationSpec = {
			id: 'closed:10:assistant:1',
			seat: 'alice',
			attempt: 1,
			purpose: { kind: 'summarize', exchange: 10, person: 'alice', through: 10 },
		};
		expect(
			viewOf(summary, facts([...all, finishedAlice])).context.tasks?.map((item) => [
				item.id,
				item.status,
			]),
		).toEqual([
			['current-alice', 'open'],
			['finished-alice', 'succeeded'],
		]);
	});

	it('gives a working activation every Task attached to that room and no others', () => {
		const room = facts(all, true);
		expect(
			viewOf(respond('worker'), room).context.tasks?.map((item) => [item.id, item.status]),
		).toEqual([
			['current-alice', 'open'],
			['current-bob', 'succeeded'],
			['other-child', 'failed'],
		]);
	});

	it('always includes an empty Task collection when no eligible Task exists', () => {
		expect(viewOf(respond('nobody'), facts(all)).context.tasks).toEqual([]);
	});
});
