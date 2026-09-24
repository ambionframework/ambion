import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { inProcessTransport } from '../src/hosting.ts';
import {
	createRuntime,
	defineHuman,
	resumeRoom,
	type StartRoomOptions,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { roomName, scriptedAgent, storedOf, waitForRoom } from './support/room.ts';
import { isClosing, quiet, scripted, speak, toolNames } from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { memory, storages } from './support/storage.ts';

const assistant = scriptedAgent('assistant');
const builder = scriptedAgent('builder');
const reviewer = scriptedAgent('reviewer');
const person = defineHuman({ name: 'priya', identity: 'The request owner.' });

async function open(options: Partial<StartRoomOptions> = {}) {
	const opened = await openFor(memory);
	const runtime = createRuntime({
		storage: opened.storage,
		clock: fakeClock(),
		transport: inProcessTransport(),
	});
	const room = await startRoom({
		name: roomName('assistant-shorthand'),
		runtime,
		assistant,
		agents: [builder, reviewer],
		seats: { builder: 'named', reviewer: 'none' },
		execution: piExecution({ sessions: 'memory', stream: scripted(() => quiet()) }),
		...options,
	});
	return { opened, room: stopAtEnd(room) };
}

const seated = (seats: [string, string][]) =>
	seats.map(([name, attention]) => ({ name, attention }));
const everySeat = seated([
	['assistant', 'broadcast'],
	['builder', 'named'],
	['reviewer', 'none'],
]);

describe('assistant room shorthand', () => {
	it.each<[string, Partial<StartRoomOptions>, ReturnType<typeof seated>]>([
		['the default seat map, with one broadcast seat for the assistant', {}, everySeat],
		[
			'an empty seat map, with only the assistant',
			{ seats: {} },
			seated([['assistant', 'broadcast']]),
		],
		[
			'an omitted seat map, with every agent at broadcast',
			{ seats: undefined },
			seated([
				['assistant', 'broadcast'],
				['builder', 'broadcast'],
				['reviewer', 'broadcast'],
			]),
		],
		[
			'matching explicit settings',
			{
				summary: 'assistant',
				seats: { assistant: 'broadcast', builder: 'named', reviewer: 'none' },
			},
			everySeat,
		],
		[
			'an assistant whose name is an own key of a plain object',
			{ assistant: scriptedAgent('constructor'), seats: {} },
			seated([['constructor', 'broadcast']]),
		],
	])(
		'expands %s, and records the assistant as the summary writer',
		async (_case, options, seats) => {
			const { opened, room } = await open(options);
			expect(
				(await room.read()).participants.map((seat) => ({
					name: seat.name,
					attention: seat.kind === 'agent' ? seat.attention : undefined,
				})),
			).toEqual(seats);
			const composition = (await storedOf(opened.journals, room.name)).find(
				(entry) => entry.kind === 'composition',
			);
			expect(composition?.body).toMatchObject({ version: 2, summary: seats[0]?.name });
		},
	);

	it('rejects duplicate and conflicting assistant configuration, and reserves no name', async () => {
		await expect(open({ agents: [assistant] })).rejects.toThrow("Duplicate agent name 'assistant'");
		await expect(open({ summary: 'builder' })).rejects.toThrow('conflicts with summary');
		await expect(open({ seats: { assistant: 'named' } })).rejects.toThrow("must use 'broadcast'");

		const name = roomName('assistant-conflict-retry');
		const opened = await openFor(memory);
		const runtime = createRuntime({ storage: opened.storage });
		await expect(startRoom({ name, runtime, assistant, summary: 'builder' })).rejects.toThrow(
			'conflicts with summary',
		);
		expect(await storedOf(opened.journals, name)).toEqual([]);
		expect(stopAtEnd(await startRoom({ name, runtime, assistant })).name).toBe(name);
	});

	it('uses the assistant shorthand for a durable closing summary', async () => {
		const closingTools: string[][] = [];
		const { room } = await open({
			agents: [builder],
			seats: { builder: 'broadcast' },
			execution: piExecution({
				sessions: 'memory',
				stream: scripted((context, agent, call) => {
					if (agent === 'builder' && call === 1) return speak('The answer.');
					if (agent === 'assistant' && isClosing(context)) {
						closingTools.push(toolNames(context));
						return speak('The answer, summarized.');
					}
					return quiet();
				}),
			}),
		});
		const exchange = await (await room.visit(person)).send({ text: 'Question?', key: 'summary-1' });
		expect(await exchange.waitForSummary()).toMatchObject({
			kind: 'summary',
			from: 'assistant',
			to: 'priya',
			text: 'The answer, summarized.',
		});
		expect(closingTools).toEqual([['say']]);
		expect(
			(await exchange.waitForClose()).some(
				(message) => message.kind === 'said' && message.from === 'builder',
			),
		).toBe(true);
	});

	it.each(storages)(
		'preserves changed membership and summary assignment after $name resume',
		async (storage) => {
			const opened = await openFor(storage);
			const room = stopAtEnd(
				await startRoom({
					name: roomName('assistant-resume'),
					runtime: createRuntime({
						storage: opened.storage,
						execution: piExecution({ sessions: 'memory', stream: scripted(() => quiet()) }),
					}),
					assistant,
					agents: [builder, reviewer],
					seats: { builder: 'named' },
				}),
			);
			await room.unseat(builder.name);
			await room.seat(reviewer.name);
			await waitForRoom(room);
			await room.stop();
			const runtime = createRuntime({ storage: opened.storage });
			await expect(
				resumeRoom(room.name, { runtime, agents: [builder, reviewer] }),
			).rejects.toThrow();
			const resumed = stopAtEnd(
				await resumeRoom(room.name, {
					runtime,
					agents: [assistant, builder, reviewer],
					execution: piExecution({
						sessions: 'memory',
						stream: scripted((context) =>
							isClosing(context) ? speak('Resumed summary.') : quiet(),
						),
					}),
				}),
			);
			expect((await resumed.read()).participants.map((seat) => seat.name)).toEqual([
				'assistant',
				'reviewer',
			]);
			const exchange = await (
				await resumed.visit(person)
			).send({
				text: 'Record the current status.',
			});
			expect(await exchange.waitForSummary()).toMatchObject({
				from: assistant.name,
				text: 'Resumed summary.',
			});
		},
	);
});
