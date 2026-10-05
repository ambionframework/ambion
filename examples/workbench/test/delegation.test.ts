import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessage as Message,
} from '@earendil-works/pi-ai';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Workbench } from '../src/workbench.ts';
import { freshDirectory, openHost, respondingStream } from './hosting.ts';

const call = (name: string, args: Record<string, string | string[]>) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const quiet = () => fauxAssistantMessage('quiet', { stopReason: 'stop' });

/**
 * The model answers once more after each tool result, so each tool call is
 * followed by a quiet answer. The assistant opens `bringup-<name>` for
 * `worker` at its first activation, and archives it at its second. A worker
 * that `reports` calls `report` at its first activation. A summary request
 * gets a plain summary and takes no step.
 */
function delegating(name: string, worker: string, reports: boolean, archives = true) {
	const open = call('breakout', {
		name,
		goal: 'Read the LED datasheet.',
		message: 'Find the forward current of the red LED.',
		agents: [worker],
	});
	const close = call('archive', { room: `bringup-${name}`, result: reports ? 'done' : 'failed' });
	const steps = new Map<string, Message[]>([
		['assistant', archives ? [open, quiet(), close] : [open]],
		[worker, reports ? [call('report', { text: 'The forward current is 20 mA.' })] : []],
	]);
	return respondingStream((agent, _request, closing) => {
		if (closing) return call('say', { text: 'Summary: delegated.' });
		return steps.get(agent)?.shift() ?? quiet();
	});
}

async function messagesOf(workbench: Workbench, room: string) {
	return (await workbench.read(room, 0)).messages;
}

const textsOf = (messages: readonly object[]) =>
	messages.map((message) => ('text' in message ? String(message.text) : ''));

function canvasRow(directory: string, room: string) {
	const database = new DatabaseSync(join(directory, 'rooms.db'));
	onTestFinished(() => database.close());
	return database.prepare('SELECT state, close FROM canvas_rooms WHERE name = ?').get(room);
}

describe('Workbench delegation', () => {
	it('opens a breakout room, carries the report to the opener, and archives the room', async () => {
		const directory = await freshDirectory();
		const workbench = await openHost({
			directory,
			stream: delegating('survey', 'scout', true),
		});
		await workbench.visit('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'k1', 'Check the LED current.');

		await vi.waitFor(
			async () => {
				const rooms = await workbench.rooms();
				expect(rooms.find((room) => room.name === 'bringup-survey')).toMatchObject({
					parent: 'bringup',
					status: 'stopped',
				});
			},
			{ timeout: 10_000, interval: 20 },
		);

		const breakout = await workbench.read('bringup-survey', 0);
		expect(
			breakout.participants.filter((seat) => seat.kind === 'agent').map((s) => s.name),
		).toEqual(['scout']);
		expect(textsOf(breakout.messages)).toContain('Find the forward current of the red LED.');
		const parent = textsOf(await messagesOf(workbench, 'bringup'));
		expect(parent.filter((text) => text.startsWith('breakout bringup-survey:'))).toEqual([
			'breakout bringup-survey: The forward current is 20 mA.',
		]);
		expect(parent.some((text) => text.includes('is closed'))).toBe(false);
		const bringup = await workbench.read('bringup', 0);
		expect(bringup.participants.map((seat) => seat.name)).not.toContain('scout');
		expect(canvasRow(directory, 'bringup-survey')).toMatchObject({
			state: 'archived',
			close: JSON.stringify({ result: 'done' }),
		});
	}, 20_000);

	it('gives the opener one close notice for an exchange with no report, and a person can visit the room', async () => {
		const workbench = await openHost({ stream: delegating('idle', 'maker', false) });
		await workbench.visit('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'k1', 'Check the LED current.');
		await vi.waitFor(
			async () =>
				expect(
					textsOf(await messagesOf(workbench, 'bringup')).filter((text) =>
						text.startsWith('breakout bringup-idle: exchange #'),
					),
				).toHaveLength(1),
			{ timeout: 10_000, interval: 20 },
		);
		await workbench.visit('bringup-idle', 'mira');
		expect((await workbench.read('bringup-idle', 0)).participants.map((seat) => seat.name)).toEqual(
			expect.arrayContaining(['maker', 'mira']),
		);
	}, 20_000);

	it('resumes a running breakout room with the workbench, and posts no notice twice', async () => {
		const directory = await freshDirectory();
		const first = await openHost({
			directory,
			stream: delegating('survey', 'scout', false, false),
		});
		await first.visit('bringup', 'mira');
		await first.send('bringup', 'mira', 'k1', 'Check the LED current.');
		const notices = async (workbench: Workbench) =>
			textsOf(await messagesOf(workbench, 'bringup')).filter((text) =>
				text.startsWith('breakout bringup-survey: exchange #'),
			);
		await vi.waitFor(async () => expect(await notices(first)).toHaveLength(1), {
			timeout: 10_000,
			interval: 20,
		});
		await first.close();

		const second = await openHost({
			directory,
			stream: delegating('survey', 'scout', false, false),
		});
		const row = (await second.rooms()).find((room) => room.name === 'bringup-survey');
		expect(row).toMatchObject({ parent: 'bringup', status: 'running' });
		expect(await notices(second)).toHaveLength(1);
	}, 20_000);
});
