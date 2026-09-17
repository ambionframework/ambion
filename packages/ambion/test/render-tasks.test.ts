/** Task context identifies each assignment without exposing subscription routing. */
import { expect, it } from 'vitest';
import { renderLine } from '../src/execution/render.ts';
import { renderTasks, taskDuties } from '../src/execution/render-tasks.ts';
import type { CollaborationContext } from '../src/protocol.ts';
import type { TaskView } from '../src/types.ts';

const task: TaskView = {
	id: 'task-1',
	text: 'Check the delivery date.',
	owner: 'planner',
	originRoom: 'project',
	exchange: 4,
	workingRoom: 'delivery',
	agents: ['supplier'],
	subscriptions: [{ room: 'project', agent: 'planner', progress: false }],
	status: 'open',
	createdAt: '2026-01-01T00:00:00.000Z',
	events: [],
};

function context(name: string, tasks: readonly TaskView[]): CollaborationContext {
	return { name, tasks, now: 0, participants: [], messages: [], reserve: [] };
}

it('shows each pinned Task id, assignment, and final result in a working room', () => {
	const second: TaskView = {
		...task,
		id: 'task-2',
		text: 'Check the equipment.',
		status: 'succeeded',
		outcome: 'The pump is ready.',
	};
	const rendered = renderTasks(context('delivery', [task, second])).join('\n');
	expect(rendered).toContain('Task task-1 (open; pinned to this room)');
	expect(rendered).toContain('Tasks pinned to this room:');
	expect(rendered).toContain('Assignment: Check the delivery date.');
	expect(rendered).toContain('Task task-2 (succeeded; pinned to this room)');
	expect(rendered).toContain('Result: The pump is ready.');
	expect(rendered).not.toContain('project');
	expect(rendered).not.toContain('planner');
});

it('gives the owner the working room id for additional assignments', () => {
	expect(renderTasks(context('project', [task])).join('\n')).toContain(
		'owner: planner; working room: delivery',
	);
});

it('explains the available actions for each side of a Task', () => {
	expect(taskDuties(context('project', [])).join('\n')).toContain('assign parallel work');
	expect(taskDuties(context('project', [])).join('\n')).toContain('in the background');
	expect(taskDuties(context('project', [])).join('\n')).toContain(
		'You own no Tasks in this exchange.',
	);
	expect(taskDuties(context('project', [task])).join('\n')).toContain('resume the work or settle');
	expect(taskDuties(context('delivery', [task])).join('\n')).toContain('cannot create Tasks');
});

it('includes the Task id in assignment and update messages, including live steering', () => {
	expect(
		renderLine({
			kind: 'said',
			seq: 3,
			at: task.createdAt,
			from: 'supplier',
			to: 'planner',
			taskId: task.id,
			text: 'The delivery is confirmed.',
		}),
	).toBe('[supplier → planner] [Task task-1] The delivery is confirmed.');
});
