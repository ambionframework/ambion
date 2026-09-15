import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	defineTool,
	resumeSession,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { roomName } from './support/room.ts';
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
		const one = startSession({
			name: roomName('binding-one'),
			runtime,
			agents: [first],
			streamFn: scripted((context, _agent, call) => {
				prompts.push(context.systemPrompt ?? '');
				return call === 1 && toolNames(context).includes('first') ? callTool('first', {}) : quiet();
			}),
		});
		const two = startSession({
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
		await (await visitSession(one, person)).deliver({ text: 'First?' });
		await (await visitSession(two, person)).deliver({ text: 'Second?' });
		await Promise.all([one.settled(), two.settled()]);
		expect(calls.sort()).toEqual(['first', 'second']);
		expect(prompts.some((prompt) => prompt.includes('Use first.'))).toBe(true);
		expect(prompts.some((prompt) => prompt.includes('Use second.'))).toBe(true);
		await Promise.all([stopSession(one), stopSession(two)]);
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
		const first = startSession({
			name,
			runtime: createRuntime({ storage: opened.storage }),
			agents: [analyst],
			streamFn: scripted(() => quiet()),
		});
		await first.messages();
		await expect(
			resumeSession(name, { runtime: createRuntime({ storage: opened.storage }), agents: [] }),
		).rejects.toThrow(/has no binding/);
		await (
			await visitSession(first, defineHuman({ name: 'priya', identity: 'Project manager.' }))
		).deliver({ text: 'Still mine?' });
		await first.settled();
		expect(
			(await first.messages()).some(
				(message) => message.kind === 'said' && message.text === 'Still mine?',
			),
		).toBe(true);
		await stopSession(first);
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
		const session = startSession({
			name: roomName('pending-binding'),
			runtime: createRuntime({ storage: faulty.journals }),
			streamFn: scripted(() => quiet()),
		});
		await session.messages();
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
		await stopSession(session);
		const reserved = startSession({
			name: roomName('reserved-binding'),
			available: [original],
			streamFn: scripted(() => quiet()),
		});
		await reserved.messages();
		await expect(reserved.seat(other)).rejects.toThrow(/already has another binding/);
		await stopSession(reserved);
		await opened.dispose();
	});
});
