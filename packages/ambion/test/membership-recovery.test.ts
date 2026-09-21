import type { JournalOpener } from '@ambionframework/journal';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import { createRuntime, defineAgent, defineTool, startRoom } from '../src/index.ts';
import { deferred, messagesOf, participantsOf, roomName, waitForRoom } from './support/room.ts';
import { callTool, quiet, scripted, toolNames } from './support/scripted.ts';
import { faultyJournals, gatedJournals, memory, tappedJournals } from './support/storage.ts';

const agent = (name: string, tool: string, calls: string[]) =>
	defineAgent({
		name,
		identity: name,
		executor: pi({
			instructions: name,
			model: `scripted/${name}`,
			tools: [
				defineTool({
					name: tool,
					description: tool,
					parameters: Type.Object({}),
					execute: () => {
						calls.push(tool);
						return tool;
					},
				}),
			],
		}),
	});

const runTool = (tool: string) =>
	scripted((context, _agent, call) =>
		call === 1 && toolNames(context).includes(tool) ? callTool(tool, {}) : quiet(),
	);

const unreadableOpener = (storage: JournalOpener) => {
	let unreadable = false;
	return {
		storage: {
			open: async (name: string) => {
				const opened = await storage.open(name);
				return {
					append: opened.append.bind(opened),
					read: async (after: number) => {
						if (unreadable) throw new Error('the storage is unreadable');
						return opened.read(after);
					},
				};
			},
		},
		fail: (value: boolean) => {
			unreadable = value;
		},
	};
};

describe('membership writes with fixed definitions', () => {
	it('commits one seating when callers race for the same registered name', async () => {
		const chosen = agent('analyst', 'chosen', []);
		const session = await startRoom({
			name: roomName('seat-race'),
			agents: [chosen],
			seats: {},
			execution: piExecution({ stream: scripted(() => quiet()) }),
		});
		try {
			const results = await Promise.allSettled([
				session.seat(chosen.name),
				session.seat(chosen.name),
			]);
			expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
			expect(
				(await messagesOf(session)).filter((message) => message.kind === 'seated'),
			).toHaveLength(1);
		} finally {
			await session.stop();
		}
	});

	it('rejects unknown definitions while a registered membership write waits', async () => {
		const opened = await memory.open();
		const gate = deferred();
		const entered = deferred();
		let hold = true;
		const journals = gatedJournals(opened.storage, (type) => {
			if (!hold || type !== 'message') return undefined;
			entered.resolve();
			return gate.promise;
		});
		const calls: string[] = [];
		const chosen = agent('analyst', 'chosen', calls);
		const session = await startRoom({
			name: roomName('gated-membership'),
			agents: [chosen],
			seats: {},
			runtime: createRuntime({ storage: journals }),
			execution: piExecution({ stream: runTool('chosen') }),
		});
		try {
			const seating = session.seat(chosen.name);
			await entered.promise;
			await expect(session.seat('unknown')).rejects.toThrow();
			hold = false;
			gate.resolve();
			await seating;
			await waitForRoom(session);
			expect(calls).toEqual(['chosen']);
		} finally {
			hold = false;
			gate.resolve();
			await session.stop();
			await opened.dispose();
		}
	});

	it('recovers an unconfirmed seating without changing its executable definition', async () => {
		const opened = await memory.open();
		const faulty = faultyJournals(opened.storage);
		const calls: string[] = [];
		const chosen = agent('analyst', 'chosen', calls);
		const session = await startRoom({
			name: roomName('lost-membership'),
			agents: [chosen],
			seats: {},
			runtime: createRuntime({ storage: faulty.journals }),
			execution: piExecution({ stream: runTool('chosen') }),
		});
		try {
			faulty.fail('after', 'message');
			await expect(session.seat(chosen.name)).rejects.toThrow(/disk is full/);
			faulty.fail(false);
			await waitForRoom(session);
			expect((await participantsOf(session)).map((participant) => participant.name)).toContain(
				chosen.name,
			);
			expect(calls).toEqual(['chosen']);
			expect(
				(await messagesOf(session)).filter((message) => message.kind === 'seated'),
			).toHaveLength(1);
		} finally {
			faulty.fail(false);
			await session.stop();
			await opened.dispose();
		}
	});

	it.each(['before', 'after'] as const)(
		'recovers a membership write that failed %s append while reads also failed',
		async (mode) => {
			const opened = await memory.open();
			const unreadable = unreadableOpener(opened.storage);
			let failAppend = true;
			const journals = tappedJournals(unreadable.storage, (_id, _n, phase, type) => {
				if (!failAppend || phase !== mode || type !== 'message') return;
				failAppend = false;
				unreadable.fail(true);
				throw new Error('the disk is full');
			});
			const calls: string[] = [];
			const chosen = agent('analyst', 'chosen', calls);
			const session = await startRoom({
				name: roomName('unread-membership'),
				agents: [chosen],
				seats: {},
				runtime: createRuntime({ storage: journals }),
				execution: piExecution({ stream: runTool('chosen') }),
			});
			try {
				await expect(session.seat(chosen.name)).rejects.toThrow(/disk is full/);
				unreadable.fail(false);
				await session.seat(chosen.name);
				await waitForRoom(session);
				expect(calls).toEqual(['chosen']);
				expect(
					(await messagesOf(session)).filter((message) => message.kind === 'seated'),
				).toHaveLength(1);
			} finally {
				unreadable.fail(false);
				await session.stop();
				await opened.dispose();
			}
		},
	);
});
