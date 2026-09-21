import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	defineTool,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { messagesOf, participantsOf, roomName, waitForRoom } from './support/room.ts';
import { callTool, quiet, scripted, toolNames } from './support/scripted.ts';
import { faultyJournals, memory } from './support/storage.ts';

describe('room bindings', () => {
	it('keeps same-named agents in separate rooms bound to their own tools', async () => {
		const calls: string[] = [];
		const prompts: string[] = [];
		const first = defineAgent({
			name: 'analyst',
			identity: 'First analyst.',
			executor: pi({
				instructions: 'Use first.',
				model: 'scripted/analyst',
				tools: [
					defineTool({
						name: 'first',
						description: 'First room only.',
						parameters: Type.Object({}),
						execute: () => {
							calls.push('first');
							return 'done';
						},
					}),
				],
			}),
		});
		const second = defineAgent({
			name: 'analyst',
			identity: 'Second analyst.',
			executor: pi({
				instructions: 'Use second.',
				model: 'scripted/analyst',
				tools: [
					defineTool({
						name: 'second',
						description: 'Second room only.',
						parameters: Type.Object({}),
						execute: () => {
							calls.push('second');
							return 'done';
						},
					}),
				],
			}),
		});
		const runtime = createRuntime();
		const one = await startRoom({
			name: roomName('binding-one'),
			runtime,
			agents: [first],
			execution: piExecution({
				stream: scripted((context, _agent, call) => {
					prompts.push(context.systemPrompt ?? '');
					return call === 1 && toolNames(context).includes('first')
						? callTool('first', {})
						: quiet();
				}),
			}),
		});
		const two = await startRoom({
			name: roomName('binding-two'),
			runtime,
			agents: [second],
			execution: piExecution({
				stream: scripted((context, _agent, call) => {
					prompts.push(context.systemPrompt ?? '');
					return call === 1 && toolNames(context).includes('second')
						? callTool('second', {})
						: quiet();
				}),
			}),
		});
		const person = defineHuman({ name: 'priya', identity: 'Project manager.' });
		await (await one.visit(person)).send({ text: 'First?' });
		await (await two.visit(person)).send({ text: 'Second?' });
		await Promise.all([waitForRoom(one, 'settled'), waitForRoom(two, 'settled')]);
		expect(calls.sort()).toEqual(['first', 'second']);
		expect(prompts.some((prompt) => prompt.includes('Use first.'))).toBe(true);
		expect(prompts.some((prompt) => prompt.includes('Use second.'))).toBe(true);
		await Promise.all([one.stop(), two.stop()]);
	});

	it('leaves the live host authoritative when resume lacks its bindings', async () => {
		const opened = await memory.open();
		const analyst = defineAgent({
			name: 'analyst',
			identity: 'Analyst.',
			executor: pi({ instructions: 'Stay quiet.', model: 'scripted/analyst' }),
		});
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
		const original = defineAgent({
			name: 'surveyor',
			identity: 'Original surveyor.',
			executor: pi({ instructions: 'Count.', model: 'scripted/surveyor' }),
		});
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
			expect(
				(await participantsOf(session)).find((seat) => seat.name === original.name),
			).toMatchObject({
				identity: original.identity,
			});
			await session.unseat(original.name);
			await session.seat(original.name);
			expect(
				(await participantsOf(session)).find((seat) => seat.name === original.name),
			).toMatchObject({
				identity: original.identity,
			});
		} finally {
			faulty.fail(false);
			await session.stop();
			await opened.dispose();
		}
	});
});
