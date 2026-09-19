import { describe, expect, it } from 'vitest';
import type { RoomState } from '../src/room/fold.ts';
import type { LeaseHold } from '../src/room/lease.ts';
import {
	OWNER_DID_NOT_RESOLVE,
	OWNER_UNAVAILABLE,
	taskIdleDecision,
	workingEpoch,
} from '../src/room/task-idle.ts';
import type { Message, TaskEvent, TaskView } from '../src/types.ts';

const at = '2026-01-01T09:00:00.000Z';

function state(
	options: {
		seq?: number;
		roster?: string[];
		leases?: LeaseHold[];
	} = {},
): RoomState {
	const seq = options.seq ?? 3;
	return {
		composition: undefined,
		roster: (options.roster ?? ['owner']).map((name) => ({
			name,
			identity: `${name}.`,
			attention: 'broadcast' as const,
		})),
		reserve: [],
		people: new Map(),
		exchange: undefined,
		closes: [],
		leases: new Map((options.leases ?? []).map((lease) => [lease.id, lease])),
		deliveries: new Map(),
		pending: [],
		owed: [],
		due: [],
		messages: seq === 0 ? [] : [{ kind: 'said', seq, at, from: 'worker', text: 'work' }],
		tasks: new Map(),
		lastSeq: seq,
	};
}

function task(events: TaskEvent[] = []): TaskView {
	return {
		id: 'task-1',
		text: 'finish the work',
		owner: 'owner',
		originRoom: 'origin',
		exchange: 1,
		workingRoom: 'working',
		agents: ['worker'],
		status: 'open',
		createdAt: at,
		subscriptions: [{ room: 'origin', agent: 'owner', progress: false }],
		events,
	};
}

function idleEvent(epoch: number): TaskEvent {
	return {
		id: `task-1:idle:${epoch}`,
		task: 'task-1',
		type: 'idle',
		status: 'open',
		sourceRoom: 'working',
		idleEpoch: epoch,
		at,
	};
}

function idleInput(
	currentTask: TaskView,
	origin: RoomState = state(),
	working: RoomState = state(),
): Parameters<typeof taskIdleDecision>[0] {
	return { origin, task: currentTask, working, now: Date.parse(at), pendingDelivery: false };
}

describe('Task idle intervention rules', () => {
	it('uses message and lease positions as the working activity epoch', () => {
		const lease: LeaseHold = {
			id: 'message:3:worker:1',
			phase: 'ended',
			reason: 'released',
			at,
			claimedAt: at,
			since: 5,
			until: 7,
			readThrough: 5,
		};
		expect(workingEpoch(state({ seq: 3, leases: [lease] }))).toBe(7);
	});

	it('does not treat a Task pin notice as working-room activity', () => {
		const working: RoomState = {
			...state({ seq: 4 }),
			messages: [
				{
					kind: 'said',
					seq: 4,
					at,
					from: 'runtime',
					text: 'Task progress.',
					taskId: 'task-1',
					taskNotice: true,
				} as Message & { readonly taskNotice: true },
			],
		};
		expect(workingEpoch(working)).toBe(1);
	});

	it('emits once after a quiet open Task and suppresses replay at that epoch', () => {
		const first = taskIdleDecision(idleInput(task(), state(), state({ seq: 4 })));
		expect(first).toEqual({ kind: 'idle', epoch: 4 });
		const second = taskIdleDecision(idleInput(task([idleEvent(4)]), state(), state({ seq: 4 })));
		expect(second).toBeUndefined();
	});

	it('permits a new intervention after working activity advances', () => {
		const result = taskIdleDecision(idleInput(task([idleEvent(4)]), state(), state({ seq: 8 })));
		expect(result).toEqual({ kind: 'idle', epoch: 8 });
	});

	it('holds an idle opportunity while its owner delivery is pending', () => {
		const result = taskIdleDecision({
			...idleInput(task(), state(), state({ seq: 4 })),
			pendingDelivery: true,
		});
		expect(result).toBeUndefined();
	});

	it('fails only after a released owner activation consumed the notification', () => {
		const event = idleEvent(4);
		const notification = {
			kind: 'said' as const,
			seq: 5,
			key: JSON.stringify(['task-delivery', event.id, 'origin', 'owner']),
			taskId: 'task-1',
			at,
			from: 'runtime',
			to: 'owner',
			text: 'Task is idle.',
		};
		const lease: LeaseHold = {
			id: 'message:5:owner:1',
			phase: 'ended',
			reason: 'released',
			at,
			claimedAt: at,
			since: 5,
			until: 6,
			readThrough: 5,
		};
		const result = taskIdleDecision(
			idleInput(
				task([event]),
				{ ...state({ leases: [lease] }), messages: [notification] },
				state({ seq: 4 }),
			),
		);
		expect(result).toEqual({ kind: 'fail', reason: OWNER_DID_NOT_RESOLVE });
	});

	it('does not count delivery alone as consumption', () => {
		const event = idleEvent(4);
		const notification = {
			kind: 'said' as const,
			seq: 5,
			key: JSON.stringify(['task-delivery', event.id, 'origin', 'owner']),
			taskId: 'task-1',
			at,
			from: 'runtime',
			to: 'owner',
			text: 'Task is idle.',
		};
		const result = taskIdleDecision(
			idleInput(task([event]), { ...state(), messages: [notification] }, state({ seq: 4 })),
		);
		expect(result).toBeUndefined();
	});

	it('fails when the owner has left and the working room is quiet', () => {
		const result = taskIdleDecision(
			idleInput(task([idleEvent(4)]), state({ roster: [] }), state({ seq: 4 })),
		);
		expect(result).toEqual({ kind: 'fail', reason: OWNER_UNAVAILABLE });
	});

	it('never emits or fails for a terminal Task', () => {
		const final = { ...task([idleEvent(4)]), status: 'succeeded' as const };
		expect(taskIdleDecision(idleInput(final, state(), state({ seq: 4 })))).toBeUndefined();
	});

	it('fails after owner progress alone when no working activity followed it', () => {
		const event = idleEvent(4);
		const progress: TaskEvent = {
			id: 'task-1:progress',
			task: 'task-1',
			type: 'updated',
			status: 'open',
			sourceRoom: 'origin',
			text: 'Still checking.',
			at,
		};
		const notification = {
			kind: 'said' as const,
			seq: 5,
			key: JSON.stringify(['task-delivery', event.id, 'origin', 'owner']),
			taskId: 'task-1',
			at,
			from: 'runtime',
			to: 'owner',
			text: 'Task is idle.',
		};
		const lease: LeaseHold = {
			id: 'message:5:owner:1',
			phase: 'ended',
			reason: 'released',
			at,
			claimedAt: at,
			since: 5,
			until: 6,
			readThrough: 5,
		};
		expect(
			taskIdleDecision(
				idleInput(
					task([event, progress]),
					{ ...state({ leases: [lease] }), messages: [notification] },
					state({ seq: 4 }),
				),
			),
		).toEqual({ kind: 'fail', reason: OWNER_DID_NOT_RESOLVE });
	});

	it('keeps the intervention open when owner recovery ended without resolution but work is active', () => {
		const event = idleEvent(4);
		const notification = {
			kind: 'said' as const,
			seq: 5,
			key: JSON.stringify(['task-delivery', event.id, 'origin', 'owner']),
			taskId: 'task-1',
			at,
			from: 'runtime',
			to: 'owner',
			text: 'Task is idle.',
		};
		const lease: LeaseHold = {
			id: 'message:5:owner:1',
			phase: 'ended',
			reason: 'abandoned',
			at,
			claimedAt: at,
			since: 5,
			until: 6,
			readThrough: 0,
		};
		expect(
			taskIdleDecision(
				idleInput(
					task([event]),
					{ ...state({ leases: [lease] }), messages: [notification] },
					state({
						seq: 4,
						leases: [
							{
								id: 'message:4:worker:1',
								phase: 'running',
								expiresAt: Date.parse(at) + 10000,
								at,
								claimedAt: at,
								since: 4,
								readThrough: 4,
							},
						],
					}),
				),
			),
		).toBeUndefined();
	});

	it.each([
		{ label: 'after consumption', readThrough: 5 },
		{ label: 'before consumption', readThrough: 0 },
	])('fails after the owner intervention wake is abandoned $label', ({ readThrough }) => {
		const event = idleEvent(4);
		const notification = {
			kind: 'said' as const,
			seq: 5,
			key: JSON.stringify(['task-delivery', event.id, 'origin', 'owner']),
			taskId: 'task-1',
			at,
			from: 'runtime',
			to: 'owner',
			text: 'Task is idle.',
		};
		const lease: LeaseHold = {
			id: 'message:5:owner:3',
			phase: 'ended',
			reason: 'abandoned',
			at,
			claimedAt: at,
			since: 5,
			until: 6,
			readThrough,
		};
		expect(
			taskIdleDecision(
				idleInput(
					task([event]),
					{ ...state({ leases: [lease] }), messages: [notification] },
					state({ seq: 4 }),
				),
			),
		).toEqual({ kind: 'fail', reason: OWNER_DID_NOT_RESOLVE });
	});

	it('does not fail for an abandonment that ended before the idle notification', () => {
		const event = idleEvent(4);
		const notification = {
			kind: 'said' as const,
			seq: 5,
			key: JSON.stringify(['task-delivery', event.id, 'origin', 'owner']),
			taskId: 'task-1',
			at,
			from: 'runtime',
			to: 'owner',
			text: 'Task is idle.',
		};
		const lease: LeaseHold = {
			id: 'message:4:owner:1',
			phase: 'ended',
			reason: 'abandoned',
			at,
			claimedAt: at,
			since: 4,
			until: 4,
			readThrough: 0,
		};
		expect(
			taskIdleDecision(
				idleInput(
					task([event]),
					{ ...state({ leases: [lease] }), messages: [notification] },
					state({ seq: 4 }),
				),
			),
		).toBeUndefined();
	});
});
