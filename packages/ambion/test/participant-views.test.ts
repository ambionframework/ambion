import { describe, expect, expectTypeOf, it } from 'vitest';
import { hostingOf, seatSessionId } from '../src/hosting.ts';
import {
	type AgentParticipantInfo,
	createRuntime,
	defineAgent,
	defineHuman,
	type HumanParticipantInfo,
	pi,
	readRoom,
	startRoom,
} from '../src/index.ts';
import { participantsOf, roomName, waitForRoom } from './support/room.ts';
import { contextText, quiet, scripted, speak } from './support/scripted.ts';
import { storages } from './support/storage.ts';

const writer = (instructions = 'Answer the room.') =>
	defineAgent({
		name: 'writer',
		identity: 'Writes room answers.',
		executor: pi({ instructions, model: 'scripted/writer' }),
	});

describe('participant views', () => {
	it('keeps the public roster discriminated and private preferences out of protocol context', async () => {
		const contexts: string[] = [];
		const runtime = createRuntime();
		const room = await startRoom({
			name: roomName('participants'),
			agents: [writer()],
			runtime,
			stream: scripted((context) => {
				contexts.push(`${context.systemPrompt ?? ''}\n${contextText(context)}`);
				const text = contextText(context);
				return text.includes('Question?') && !text.includes('Answer.') ? speak('Answer.') : quiet();
			}),
		});
		try {
			const visit = await room.visit(
				defineHuman({
					name: 'reader',
					identity: 'Reads the room.',
					preferences: 'private reading preferences',
				}),
			);
			const exchange = await visit.send({ text: 'Question?' });
			await exchange.waitForClose();
			await waitForRoom(room);

			const participants = await participantsOf(room);
			for (const participant of participants) {
				if (participant.kind === 'agent') {
					expectTypeOf(participant).toEqualTypeOf<AgentParticipantInfo>();
				} else {
					expectTypeOf(participant).toEqualTypeOf<HumanParticipantInfo>();
				}
			}
			expectTypeOf<Extract<'sessionId', keyof AgentParticipantInfo>>().toEqualTypeOf<never>();
			expectTypeOf<
				Extract<
					'changedAt' | 'lastDeparture' | 'messagesSinceDeparture' | 'preferences',
					keyof HumanParticipantInfo
				>
			>().toEqualTypeOf<never>();
			const snapshot = await readRoom(room.name, {
				runtime: createRuntime({ storage: runtime.storage }),
				messages: false,
			});
			expect(participants).toEqual([
				{
					kind: 'agent',
					name: 'writer',
					identity: 'Writes room answers.',
					status: 'idle',
					attention: 'broadcast',
				},
				{ kind: 'human', name: 'reader', identity: 'Reads the room.', presence: 'present' },
			]);
			expect(snapshot.participants).toEqual(participants);
			expect(JSON.stringify(participants)).not.toContain('sessionId');
			expect(JSON.stringify(participants)).not.toContain('private reading preferences');
			expect(contexts.some((context) => context.includes('Question?'))).toBe(true);
			expect(contexts.every((context) => !context.includes('private reading preferences'))).toBe(
				true,
			);
		} finally {
			await room.stop();
		}
	});

	it.each(storages)('keeps stopped participant reads consistent on %s storage', async (storage) => {
		const opened = await storage.open();
		const runtime = createRuntime({ storage: opened.storage });
		const room = await startRoom({
			name: roomName(`stopped-${storage.name}`),
			agents: [writer()],
			seats: { writer: 'none' },
			runtime,
			stream: scripted(() => quiet()),
		});
		try {
			await room.visit(defineHuman({ name: 'reader', identity: 'Reads the room.' }));
			await room.stop();
			const snapshot = await readRoom(room.name, { runtime, messages: false });
			expect(snapshot.participants).toEqual([
				{
					kind: 'agent',
					name: 'writer',
					identity: 'Writes room answers.',
					status: 'idle',
					attention: 'none',
				},
				{ kind: 'human', name: 'reader', identity: 'Reads the room.', presence: 'absent' },
			]);
			expect(snapshot.participants.every((participant) => !('sessionId' in participant))).toBe(
				true,
			);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('reopens the existing audit transcript through its explicit stable identity', async () => {
		const runtime = createRuntime();
		const room = await startRoom({
			name: roomName('participant-audit'),
			agents: [writer()],
			runtime,
			stream: scripted((context) => {
				const text = contextText(context);
				return text.includes('Question?') && !text.includes('Answer.') ? speak('Answer.') : quiet();
			}),
		});
		try {
			const exchange = await (
				await room.visit(defineHuman({ name: 'reader', identity: 'Reads the room.' }))
			).send({ text: 'Question?' });
			await exchange.waitForClose();
			await room.stop();

			const expectedId = JSON.stringify(['ambion/seat-session', room.name, 'writer']);
			expect(seatSessionId(room.name, 'writer')).toBe(expectedId);
			const transcript = await hostingOf(runtime).transcripts.open(expectedId);
			expect(await transcript.getMetadata()).toMatchObject({
				id: expectedId,
				parentSessionId: room.name,
			});
			expect(JSON.stringify(await transcript.findEntries())).toContain('Answer.');
		} finally {
			await room.stop();
		}
	});
});
