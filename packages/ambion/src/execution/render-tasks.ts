/** Task assignments and guidance rendered from detached collaboration facts. */
import type { CollaborationContext } from '../protocol.ts';
import type { TaskContext } from '../types.ts';

export function taskDuties(context: CollaborationContext): string[] {
	if (context.tasks?.some((task) => task.workingRoom === context.name)) {
		return [
			`Work on the Tasks pinned to this room. Use task_update with a Task id and text to report progress.`,
			`Set status to succeeded or failed when the Task reaches its final state. Include the result or reason in text.`,
			`A final Task accepts no more work. Other open Tasks in this room can continue.`,
			`This working room cannot create Tasks.`,
		];
	}
	return [
		...(context.tasks?.length === 0 ? [`You own no Tasks in this exchange.`] : []),
		`Use task with text and agents to assign parallel work in a new working room.`,
		`Use task with text and room to add work to an existing working room in this exchange.`,
		`Include the goal, necessary context, and completion criteria in text.`,
		`Tasks run in their working rooms in the background, including work by this same agent; continue engaging this room while they run.`,
		`Your Tasks send final results and working-room idle requests here.`,
		`Use say with task and text to steer a Task you own. Use task_update to report progress or set its final status.`,
		`After you read an idle request, resume the work or settle the Task before your activation ends.`,
	];
}

export function renderTasks(context: CollaborationContext): string[] {
	const tasks = context.tasks ?? [];
	if (tasks.length === 0) return [];
	const heading = tasks.some((task) => task.workingRoom === context.name)
		? 'Tasks pinned to this room:'
		: 'Tasks you own in this exchange:';
	return ['', heading, ...tasks.flatMap((task) => renderTask(task, context.name))];
}

function renderTask(task: TaskContext, room: string): string[] {
	const relationship =
		task.workingRoom === room
			? 'pinned to this room'
			: `owner: ${task.owner}; working room: ${task.workingRoom}`;
	const latest = [...task.events]
		.reverse()
		.find((event) => event.type !== 'created' && event.text !== undefined);
	return [
		`- Task ${task.id} (${task.status}; ${relationship})`,
		`  Assignment: ${task.text}`,
		...(task.status === 'open' && latest?.text !== undefined
			? [`  Latest update: ${latest.text}`]
			: []),
		...(task.outcome === undefined ? [] : [`  Result: ${task.outcome}`]),
	];
}
