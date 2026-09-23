import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { createRuntime, defineHuman, defineTool, resumeRoom, startRoom } from '../src/index.ts';
import {
	messagesOf,
	participantsOf,
	roomName,
	scriptedAgent,
	waitForRoom,
} from './support/room.ts';
import { callTool, quiet, scripted, toolNames } from './support/scripted.ts';
import { faultyJournals, memory } from './support/storage.ts';
import { stopAtEnd } from './support/stop.ts';

describe('room bindings', () => {
	it('keeps same-named agents in separate rooms bound to their own tools', async () => {
		const calls: string[] = [];
		const prompts: string[] = [];
		const runtime = createRuntime();
		const person = defineHuman({ name: 'priya', identity: 'Project manager.' });
		const rooms = await Promise.all(
			['first', 'second'].map(async (label) => {
				const own = defineTool({
					name: label,
					description: `The ${label} room only.`,
					parameters: Type.Object({}),
					execute: () => {
						calls.push(label);
						return 'done';
					},
				});
				const stream = scripted((context, _agent, call) => {
					prompts.push(context.systemPrompt ?? '');
					return call === 1 && toolNames(context).includes(label) ? callTool(label, {}) : quiet();
				});
				const room = stopAtEnd(
					await startRoom({
						name: roomName(`binding-${label}`),
						runtime,
						agents: [
							scriptedAgent('analyst', `The ${label} analyst.`, {
								instructions: `Use ${label}.`,
								tools: [own],
							}),
						],
						execution: piExecution({ stream }),
					}),
				);
				await (await room.visit(person)).send({ text: `${label}?` });
				return room;
			}),
		);
		await Promise.all(rooms.map((room) => waitForRoom(room, 'settled')));
		expect(calls.sort()).toEqual(['first', 'second']);
		expect(prompts.some((prompt) => prompt.includes('Use first.'))).toBe(true);
		expect(prompts.some((prompt) => prompt.includes('Use second.'))).toBe(true);
	});

	it('leaves the live host authoritative when resume lacks its bindings', async () => {
		const opened = await memory.open();
		const analyst = scriptedAgent('analyst');
		const name = roomName('resume-bindings');
		const first = await startRoom({
			name,
			runtime: createRuntime({ storage: opened.storage }),
			agents: [analyst],
			execution: piExecution({ stream: scripted(() => quiet()) }),
		});
		await waitForRoom(first);
		await expect(
			resumeRoom(name, { runtime: createRuntime({ storage: opened.storage }), agents: [] }),
		).rejects.toThrow(/has no binding/);
		await (
			await first.visit(defineHuman({ name: 'priya', identity: 'Project manager.' }))
		).send({ text: 'Still mine?' });
		await waitForRoom(first);
		expect(
			(await messagesOf(first)).some(
				(message) => message.kind === 'said' && message.text === 'Still mine?',
			),
		).toBe(true);
		await first.stop();
		await opened.dispose();
	});

	it('keeps the startup definition through a failed membership write', async () => {
		const opened = await memory.open();
		const faulty = faultyJournals(opened.storage);
		const original = scriptedAgent('surveyor', 'Original surveyor.');
		const session = await startRoom({
			name: roomName('fixed-binding'),
			agents: [original],
			seats: {},
			runtime: createRuntime({ storage: faulty.journals }),
			execution: piExecution({ stream: scripted(() => quiet()) }),
		});
		try {
			faulty.fail(true, 'message');
			await expect(session.seat(original.name)).rejects.toThrow(/disk is full/);
			faulty.fail(false);
			await session.seat(original.name);
			const seated = async () =>
				(await participantsOf(session)).find((seat) => seat.name === original.name);
			expect(await seated()).toMatchObject({ identity: original.identity });
			await session.unseat(original.name);
			await session.seat(original.name);
			expect(await seated()).toMatchObject({ identity: original.identity });
		} finally {
			faulty.fail(false);
			await session.stop();
			await opened.dispose();
		}
	});
});
