/** Pure idle intervention decisions for an open Task.
 *
 * The originating room owns the Task event and delivery records.  This module
 * only derives the next decision from those records and the two folded room
 * states.  In particular, a delivered notification is not consumption: the
 * owner must have a live or subsequently released activation whose durable
 * readThrough includes that notification.
 */

import { decodeActivationId } from '../activation-id.ts';
import type { Message, SpokenMessage, TaskEvent, TaskView } from '../types.ts';
import type { RoomState } from './fold.ts';
import { liveWork } from './reconcile.ts';
import {
	shouldRequestTaskIdle as shouldRequestTaskIdleRule,
	taskIdleEpoch as taskIdleEpochRule,
} from './rules.verified.ts';

export const OWNER_DID_NOT_RESOLVE = 'Owner did not resolve the intervention request.';
export const OWNER_UNAVAILABLE = 'Task owner is no longer available.';

export interface TaskIdleInput {
	/** The journal that owns the Task and its owner subscription. */
	readonly origin: RoomState;
	readonly task: TaskView;
	/** The folded journal of the Task's working room. */
	readonly working: RoomState;
	readonly now: number;
	/** A recorded delivery that has not reached its destination yet. */
	readonly pendingDelivery: boolean;
}

export type TaskIdleDecision =
	| { readonly kind: 'idle'; readonly epoch: number }
	| { readonly kind: 'fail'; readonly reason: string };

/**
 * Choose the next idle intervention action for one Task.
 *
 * The epoch is the highest durable activity position in the working room.
 * Leases are included because an activation can start and finish without
 * saying anything.  A prior idle event at this epoch suppresses replay.  A
 * newer activity position invalidates that prior event and permits a later
 * idle event when the room settles again.
 */
export function taskIdleDecision(input: TaskIdleInput): TaskIdleDecision | undefined {
	if (input.task.status !== 'open') return undefined;
	const work = liveWork(input.working, input.now);
	const epoch = workingEpoch(input.working);
	const idle = latestIdleAt(input.task, epoch);
	if (shouldRequestTaskIdleRule(true, work.rest, input.pendingDelivery, idle !== undefined))
		return { kind: 'idle', epoch };
	if (!work.rest || input.pendingDelivery || idle === undefined) return undefined;

	if (!ownerSeated(input.origin, input.task.owner))
		return { kind: 'fail', reason: OWNER_UNAVAILABLE };
	if (ownerConsumed(input.origin, input.task, idle)) {
		if (ownerCompleted(input.origin, input.task, idle))
			return { kind: 'fail', reason: OWNER_DID_NOT_RESOLVE };
		return undefined;
	}
	// A failed or expired owner activation remains recoverable while the fold
	// still owes another attempt. Once the intervention wake is abandoned,
	// recovery has no path left to consume the opportunity.
	if (ownerExhausted(input.origin, input.task, idle))
		return { kind: 'fail', reason: OWNER_DID_NOT_RESOLVE };
	return undefined;
}

/** The durable activity watermark used to identify a working-room period. */
export function workingEpoch(state: RoomState): number {
	let epoch = 0;
	for (const message of state.messages) {
		const notice = message as Message & { readonly taskNotice?: boolean };
		if (notice.taskNotice !== true) epoch = Math.max(epoch, message.seq);
	}
	for (const lease of state.leases.values()) {
		epoch = Math.max(epoch, lease.since);
		if (lease.phase === 'ended') epoch = Math.max(epoch, lease.until);
	}
	// TaskChange.epoch is a positive integer, including a newly composed room.
	return taskIdleEpochRule(epoch);
}

function latestIdleAt(task: TaskView, epoch: number): TaskEvent | undefined {
	return [...task.events]
		.reverse()
		.find((event) => event.type === 'idle' && event.idleEpoch === epoch);
}

function ownerSeated(origin: RoomState, owner: string): boolean {
	return origin.roster.some((seat) => seat.name === owner);
}

/**
 * Find the owner's activation that has consumed the exact idle notification.
 * The message key is the compatibility path for existing journals.  Hosts
 * may also carry the Task event id explicitly on the message envelope.
 */
function ownerConsumed(origin: RoomState, task: TaskView, idle: TaskEvent): boolean {
	const notification = origin.messages.find(
		(message) => messageForIdle(message, task.id, idle.id) && message.to === task.owner,
	);
	if (notification === undefined) return false;
	for (const lease of origin.leases.values()) {
		if (decodeActivationId(lease.id)?.seat !== task.owner) continue;
		if (lease.readThrough < notification.seq) continue;
		if (lease.phase === 'running') return true;
		if (lease.reason === 'released') return true;
	}
	return false;
}

function ownerCompleted(origin: RoomState, task: TaskView, idle: TaskEvent): boolean {
	const notification = notificationForIdle(origin, task, idle);
	if (notification === undefined) return false;
	for (const lease of origin.leases.values()) {
		if (decodeActivationId(lease.id)?.seat !== task.owner) continue;
		if (lease.readThrough < notification.seq || lease.phase !== 'ended') continue;
		if (lease.reason === 'released') return true;
	}
	return false;
}

function ownerExhausted(origin: RoomState, task: TaskView, idle: TaskEvent): boolean {
	const notification = notificationForIdle(origin, task, idle);
	if (notification === undefined) return false;
	// A fresh owner activation may still be reading this notification. Its
	// lease is the durable acknowledgement opportunity; an older abandoned
	// attempt must not fail the Task while that opportunity is in flight.
	if (
		[...origin.leases.values()].some(
			(lease) => decodeActivationId(lease.id)?.seat === task.owner && lease.phase === 'running',
		)
	)
		return false;
	if (origin.due.some((owed) => owed.seat === task.owner)) return false;
	return [...origin.leases.values()].some((lease) => {
		if (decodeActivationId(lease.id)?.seat !== task.owner || lease.phase !== 'ended') return false;
		return lease.reason === 'abandoned' && lease.until >= notification.seq;
	});
}

function notificationForIdle(
	origin: RoomState,
	task: TaskView,
	idle: TaskEvent,
): SpokenMessage | undefined {
	return origin.messages.find(
		(message): message is SpokenMessage =>
			messageForIdle(message, task.id, idle.id) && message.to === task.owner,
	);
}

function messageForIdle(message: Message, task: string, event: string): message is SpokenMessage {
	if (message.kind !== 'said' || message.taskId !== task) return false;
	const envelope = message as SpokenMessage & {
		readonly taskEventId?: string;
		readonly taskSnapshot?: TaskView;
	};
	if (
		envelope.taskSnapshot?.events.some(
			(candidate) => candidate.id === event && candidate.type === 'idle',
		)
	)
		return true;
	if (envelope.taskEventId === event) return true;
	if (
		message.key === event ||
		message.key === `${event}:delivery` ||
		message.key === `${event}:notification`
	)
		return true;
	return deliveryEvent(message.key) === event;
}

/** Task delivery ids are JSON envelopes so destination identity is included. */
function deliveryEvent(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(key);
		return Array.isArray(parsed) && parsed[0] === 'task-delivery' && typeof parsed[1] === 'string'
			? parsed[1]
			: undefined;
	} catch {
		return undefined;
	}
}
