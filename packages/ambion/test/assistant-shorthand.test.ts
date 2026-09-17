import { describe, expect, it } from 'vitest';
import { createRuntime, defineAgent, defineHuman, resumeRoom, startRoom } from '../src/index.ts';
import { inProcessTransport } from '../src/transport.ts';
import { fakeClock } from './support/clock.ts';
import { memory, storages } from './support/storage.ts';
import { roomName, storedOf, waitForRoom } from './support/room.ts';
import { isClosing, quiet, scripted, speak, toolNames } from './support/scripted.ts';

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Coordinates the room.',
	instructions: 'Stay concise.',
	model: 'scripted/assistant',
});
const builder = defineAgent({
	name: 'builder',
	identity: 'Builds the result.',
	instructions: 'Build.',
	model: 'scripted/builder',
});
const reviewer = defineAgent({
	name: 'reviewer',
	identity: 'Reviews the result.',
	instructions: 'Review.',
	model: 'scripted/reviewer',
});

async function open(options: Partial<Parameters<typeof startRoom>[0]> = {}) {
	const opened = await memory.open();
	const runtime = createRuntime({
		storage: opened.storage,
		clock: fakeClock(),
		transport: inProcessTransport(),
		stream: scripted(() => quiet()),
	});
	const room = await startRoom({
		name: roomName('assistant-shorthand'),
		runtime,
		assistant,
		agents: [builder, reviewer],
		seats: { builder: 'named', reviewer: 'none' },
		streamFn: scripted(() => quiet()),
		...options,
	});
	return { opened, room };
}

describe('assistant room shorthand', () => {
	it('expands to one broadcast seat and the assistant summary writer', async () => {
		const { opened, room } = await open();
		try {
			expect((await room.read()).participants).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: 'assistant', attention: 'broadcast' }),
					expect.objectContaining({ name: 'builder', attention: 'named' }),
					expect.objectContaining({ name: 'reviewer', attention: 'none' }),
				]),
			);
			const entries = await storedOf(opened.journals, room.name);
			const composition = entries.find((entry) => entry.kind === 'composition');
			expect(composition?.body).toMatchObject({ version: 2, summary: 'assistant' });
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('seats only the assistant when an empty seat map is supplied', async () => {
		const { opened, room } = await open({ seats: {} });
		try {
			expect((await room.read()).participants.map((seat) => seat.name)).toEqual(['assistant']);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('keeps every catalog agent at broadcast when seats is omitted', async () => {
		const { opened, room } = await open({ seats: undefined });
		try {
			expect(
				(await room.read()).participants
					.filter((seat) => seat.kind === 'agent')
					.map(({ name, attention }) => ({ name, attention })),
			).toEqual([
				{ name: 'assistant', attention: 'broadcast' },
				{ name: 'builder', attention: 'broadcast' },
				{ name: 'reviewer', attention: 'broadcast' },
			]);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('rejects duplicate and conflicting assistant configuration', async () => {
		await expect(open({ agents: [assistant] })).rejects.toThrow("Duplicate agent name 'assistant'");
		await expect(open({ summary: 'builder' })).rejects.toThrow('conflicts with summary');
		await expect(open({ seats: { assistant: 'named' } })).rejects.toThrow("must use 'broadcast'");
	});

	it('accepts matching explicit assistant settings', async () => {
		const { opened, room } = await open({
			summary: 'assistant',
			seats: { assistant: 'broadcast', builder: 'named', reviewer: 'none' },
		});
		try {
			expect((await room.read()).participants.map((seat) => seat.name)).toEqual([
				'assistant',
				'builder',
				'reviewer',
			]);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('does not reserve a failed configuration name', async () => {
		const name = roomName('assistant-conflict-retry');
		const opened = await memory.open();
		const runtime = createRuntime({ storage: opened.storage });
		await expect(startRoom({ name, runtime, assistant, summary: 'builder' })).rejects.toThrow(
			'conflicts with summary',
		);
		expect(await storedOf(opened.journals, name)).toEqual([]);
		const room = await startRoom({ name, runtime, assistant });
		try {
			expect(room.name).toBe(name);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('checks assistant names as own seat keys', async () => {
		const special = defineAgent({
			name: 'constructor',
			identity: 'Special assistant.',
			instructions: 'Stay quiet.',
			model: 'scripted/constructor',
		});
		const opened = await memory.open();
		const runtime = createRuntime({
			storage: opened.storage,
			clock: fakeClock(),
			transport: inProcessTransport(),
			stream: scripted(() => quiet()),
		});
		try {
			const room = await startRoom({
				name: roomName('assistant-special-name'),
				runtime,
				assistant: special,
				seats: {},
			});
			expect((await room.read()).participants.map((seat) => seat.name)).toEqual(['constructor']);
			await room.stop();
		} finally {
			await opened.dispose();
		}
	});

	it('uses the assistant shorthand for a durable closing summary', async () => {
		const opened = await memory.open();
		const runtime = createRuntime({
			storage: opened.storage,
			clock: fakeClock(),
			transport: inProcessTransport(),
		});
		const person = defineHuman({ name: 'priya', identity: 'The request owner.' });
		const closingTools: string[][] = [];
		const room = await startRoom({
			name: roomName('assistant-summary'),
			runtime,
			assistant,
			agents: [builder],
			seats: { builder: 'broadcast' },
			streamFn: scripted((context, agent, call) => {
				if (agent === 'builder' && call === 1) return speak('The answer.');
				if (agent === 'assistant' && isClosing(context)) {
					closingTools.push(toolNames(context));
					return speak('The answer, summarized.');
				}
				return quiet();
			}),
		});
		try {
			const exchange = await (
				await room.visit(person)
			).send({ text: 'Question?', key: 'summary-1' });
			const response = await exchange.waitForSummary();
			expect(response).toMatchObject({
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
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it.each(storages)(
		'preserves changed membership and summary assignment after $name resume',
		async (storage) => {
			const opened = await storage.open();
			const runtime = createRuntime({ storage: opened.storage, stream: scripted(() => quiet()) });
			const room = await startRoom({
				name: roomName('assistant-resume'),
				runtime,
				assistant,
				agents: [builder, reviewer],
				seats: { builder: 'named' },
			});
			try {
				await room.unseat(builder.name);
				await room.seat(reviewer.name);
				await waitForRoom(room);
				await room.stop();
				const resumedRuntime = createRuntime({ storage: opened.storage });
				await expect(
					resumeRoom(room.name, { runtime: resumedRuntime, agents: [builder, reviewer] }),
				).rejects.toThrow();
				const resumed = await resumeRoom(room.name, {
					runtime: resumedRuntime,
					agents: [assistant, builder, reviewer],
					streamFn: scripted((context) =>
						isClosing(context) ? speak('Resumed summary.') : quiet(),
					),
				});
				try {
					expect((await resumed.read()).participants.map((seat) => seat.name)).toEqual([
						'assistant',
						'reviewer',
					]);
					const person = defineHuman({ name: 'priya', identity: 'Request owner.' });
					const exchange = await (
						await resumed.visit(person)
					).send({ text: 'Record the current status.' });
					expect(await exchange.waitForSummary()).toMatchObject({
						from: assistant.name,
						text: 'Resumed summary.',
					});
				} finally {
					await resumed.stop();
				}
			} finally {
				await room.stop();
				await opened.dispose();
			}
		},
	);
});
