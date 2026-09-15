import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	defineTool,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { roomName, waitForRoom } from './support/room.ts';
import { callTool, quiet, scripted, toolNames } from './support/scripted.ts';
import { faultyJournals, memory } from './support/storage.ts';

describe('room bindings', () => {
	it('keeps same-named agents in separate rooms bound to their own tools', async () => {
		const calls: string[] = [];
		const prompts: string[] = [];
		const first = defineAgent({
			name: 'analyst',
			identity: 'First analyst.',
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
		});
		const second = defineAgent({
			name: 'analyst',
			identity: 'Second analyst.',
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
		});
		const runtime = createRuntime();
		const one = await startRoom({
			name: roomName('binding-one'),
			runtime,
			agents: [first],
			streamFn: scripted((context, _agent, call) => {
				prompts.push(context.systemPrompt ?? '');
				return call === 1 && toolNames(context).includes('first') ? callTool('first', {}) : quiet();
			}),
		});
		const two = await startRoom({
			name: roomName('binding-two'),
			runtime,
			agents: [second],
			streamFn: scripted((context, _agent, call) => {
				prompts.push(context.systemPrompt ?? '');
				return call === 1 && toolNames(context).includes('second')
					? callTool('second', {})
					: quiet();
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
			instructions: 'Stay quiet.',
			model: 'scripted/analyst',
		});
		const name = roomName('resume-bindings');
		const first = await startRoom({
			name,
			runtime: createRuntime({ storage: opened.storage }),
			agents: [analyst],
			streamFn: scripted(() => quiet()),
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
			(await first.messages()).some(
				(message) => message.kind === 'said' && message.text === 'Still mine?',
			),
		).toBe(true);
		await first.stop();
		await opened.dispose();
	});

	it('clears a failed pending seat binding so its intended definition can retry', async () => {
		const opened = await memory.open();
		const faulty = faultyJournals(opened.storage);
		const original = defineAgent({
			name: 'surveyor',
			identity: 'Original surveyor.',
			instructions: 'Count.',
			model: 'scripted/surveyor',
		});
		const other = defineAgent({
			name: 'surveyor',
			identity: 'Other surveyor.',
			instructions: 'Replace.',
			model: 'scripted/surveyor',
		});
		const session = await startRoom({
			name: roomName('pending-binding'),
			runtime: createRuntime({ storage: faulty.journals }),
			streamFn: scripted(() => quiet()),
		});
		await waitForRoom(session);
		faulty.fail(true, 'message');
		await expect(session.seat(original)).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		await session.seat(other);
		expect(session.seats().find((seat) => seat.name === 'surveyor')).toMatchObject({
			identity: 'Other surveyor.',
		});
		await session.unseat(other);
		await expect(session.seat(original)).rejects.toThrow(/already has another binding/);
		await session.seat(other);
		await session.stop();
		const reserved = await startRoom({
			name: roomName('reserved-binding'),
			available: [original],
			streamFn: scripted(() => quiet()),
		});
		await waitForRoom(reserved);
		await expect(reserved.seat(other)).rejects.toThrow(/already has another binding/);
		await reserved.stop();
		await opened.dispose();
	});
});
