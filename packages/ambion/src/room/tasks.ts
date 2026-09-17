/** Pure Task projection and operation checks. */
import type { TaskChange, TaskEventChange } from '../journal/events.ts';
import type { TaskContext, TaskEvent, TaskView } from '../types.ts';

export function taskContext(task: TaskView, room: string): TaskContext {
	return {
		id: task.id,
		text: task.text,
		status: task.status,
		workingRoom: task.workingRoom,
		events: task.events.map(({ sourceRoom: _room, task: _task, ...event }) => event),
		...(task.originRoom === room ? { owner: task.owner } : {}),
		...(task.outcome === undefined ? {} : { outcome: task.outcome }),
	};
}

export function mergeTask(tasks: Map<string, TaskView>, task: TaskView): void {
	const current = tasks.get(task.id);
	if (
		current !== undefined &&
		(current.status !== 'open' || current.events.length >= task.events.length)
	)
		return;
	tasks.set(task.id, structuredClone(task));
}

export function applyTask(tasks: Map<string, TaskView>, change: TaskChange): void {
	if (change.type === 'created') {
		if (!tasks.has(change.task.id)) tasks.set(change.task.id, createdTask(change));
		return;
	}
	if (change.type !== 'updated' && change.type !== 'idle' && change.type !== 'instructed') return;
	const task = tasks.get(change.task);
	if (task === undefined || task.status !== 'open') return;
	tasks.set(task.id, changedTask(task, change));
}

export function createdTask(change: Extract<TaskEventChange, { type: 'created' }>): TaskView {
	return {
		...change.task,
		events: [
			{
				id: change.event,
				task: change.task.id,
				type: 'created',
				status: 'open',
				text: change.task.text,
				author: change.author,
				sourceRoom: change.sourceRoom,
				at: change.at,
			},
		],
	};
}

export function changedTask(
	task: TaskView,
	change: Exclude<TaskEventChange, { type: 'created' }>,
): TaskView {
	const updated = change.type === 'updated';
	const event: TaskEvent = {
		id: change.event,
		task: task.id,
		type: change.type,
		status: updated ? change.status : task.status,
		sourceRoom: change.sourceRoom,
		at: change.at,
		...(change.type === 'idle'
			? { idleEpoch: change.epoch }
			: { text: change.text, ...(change.author === undefined ? {} : { author: change.author }) }),
		...(updated && change.outcome !== undefined ? { outcome: change.outcome } : {}),
	};
	return {
		...task,
		status: event.status,
		...(event.outcome === undefined ? {} : { outcome: event.outcome }),
		events: [...task.events, event],
	};
}
