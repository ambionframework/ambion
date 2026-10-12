import { memoryJournals } from '@ambionframework/journal';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { createRuntime, definePerson, defineTool, startRoom } from '../src/index.ts';
import { participantsOf, roomName, scriptedAgent, waitForRoom } from './support/room.ts';
import { callTool, quiet, scriptedStream, toolNames } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { faultyJournals, memory } from './support/storage.ts';

describe('room bindings', () => {
	it('keeps same-named agents in separate rooms bound to their own tools', async () => {
		const calls: string[] = [];
		const prompts: string[] = [];
		const runtime = createRuntime({ storage: memoryJournals() });
		const person = definePerson({ name: 'priya', identity: 'Project manager.' });
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
				const stream = scriptedStream((context, _agent, request) => {
					prompts.push(context.systemPrompt ?? '');
					return request === 1 && toolNames(context).includes(label)
						? callTool(label, {})
						: quiet();
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
						execution: piExecution({ sessions: 'memory', stream }),
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

	it('keeps the startup definition through a failed membership write', async () => {
		const opened = await memory.open();
		const faulty = faultyJournals(opened.storage);
		const original = scriptedAgent('surveyor', 'Original surveyor.');
		const session = await startRoom({
			name: roomName('fixed-binding'),
			agents: [original],
			seats: {},
			runtime: createRuntime({ storage: faulty.journals }),
			execution: piExecution({ sessions: 'memory', stream: scriptedStream(() => quiet()) }),
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
