import { describe, expect, expectTypeOf, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import type { ActivationSpec } from '../src/hosting.ts';
import {
	type AgentParticipantInfo,
	createRuntime,
	defineHuman,
	type HumanParticipantInfo,
	readRoom,
	startRoom,
} from '../src/index.ts';
import type { Entry } from '../src/journal/journal.ts';
import { foldRoom } from '../src/room/fold.ts';
import { viewOf } from '../src/room/view.ts';
import { participantsOf, roomName, scriptedAgent, waitForRoom } from './support/room.ts';
import { contextText, quiet, scripted, speak } from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { storages } from './support/storage.ts';

const writer = scriptedAgent('writer', 'Writes room answers.');
const reader = { kind: 'human', name: 'reader', identity: 'Reads the room.' } as const;

describe('participant views', () => {
	it.each(storages)(
		'keeps the roster discriminated and private preferences out of context, live and stopped, on $name',
		async (storage) => {
			const contexts: string[] = [];
			const runtime = createRuntime({ storage: (await openFor(storage)).storage });
			const room = stopAtEnd(
				await startRoom({
					name: roomName('participants'),
					agents: [writer],
					runtime,
					execution: piExecution({
						sessions: 'memory',
						stream: scripted((context) => {
							contexts.push(`${context.systemPrompt ?? ''}\n${contextText(context)}`);
							const text = contextText(context);
							return text.includes('Question?') && !text.includes('Answer.')
								? speak('Answer.')
								: quiet();
						}),
					}),
				}),
			);
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
			const agent = {
				kind: 'agent',
				name: 'writer',
				identity: 'Writes room answers.',
				status: 'idle',
				attention: 'broadcast',
			};
			expect(participants).toEqual([agent, { ...reader, presence: 'present' }]);
			const recorded = () =>
				readRoom(room.name, {
					runtime: createRuntime({ storage: runtime.storage }),
					messages: false,
				});
			expect((await recorded()).participants).toEqual(participants);
			expect(JSON.stringify(participants)).not.toContain('sessionId');
			expect(JSON.stringify(participants)).not.toContain('private reading preferences');
			expect(contexts.some((context) => context.includes('Question?'))).toBe(true);
			expect(contexts.every((context) => !context.includes('private reading preferences'))).toBe(
				true,
			);

			await room.stop();
			expect((await recorded()).participants).toEqual([agent, { ...reader, presence: 'absent' }]);
		},
	);

	it('carries the departure and the unread count in the context view of a person', () => {
		const at = '2026-01-01T00:00:00.000Z';
		const said = (seq: number, from: string): Entry => ({
			kind: 'message',
			seq,
			body: { kind: 'said', at, from, text: `Message ${seq}.` },
		});
		const entries: Entry[] = [
			{
				kind: 'composition',
				seq: 1,
				body: {
					version: 2,
					summary: 'worker',
					agents: [{ name: 'worker', identity: 'W.', attention: 'broadcast' }],
					available: [],
					at,
				},
			},
			{ kind: 'message', seq: 2, body: { kind: 'arrived', at, subject: 'priya', identity: 'P.' } },
			{ kind: 'message', seq: 3, body: { kind: 'arrived', at, subject: 'sam', identity: 'S.' } },
			said(4, 'priya'),
			{ kind: 'message', seq: 5, body: { kind: 'left', at, subject: 'priya' } },
			said(6, 'sam'),
			said(7, 'sam'),
		];
		const state = foldRoom(entries, { backoff: () => 0 });
		const spec: ActivationSpec = {
			id: 'message:7:worker:1',
			seat: 'worker',
			attempt: 1,
			purpose: { kind: 'respond', message: 7 },
		};
		const view = viewOf(spec, {
			name: 'room',
			now: Date.parse(at),
			state,
			live: new Map<string, string[]>(),
			messagesSince: (seq) =>
				entries.filter((entry) => entry.kind === 'message' && entry.seq > seq).length,
		});
		const people = view.context.participants.filter((participant) => participant.kind === 'human');
		const priya = people.find((person) => person.name === 'priya');
		const sam = people.find((person) => person.name === 'sam');
		expect(priya).toMatchObject({ lastDeparture: 5, messagesSinceDeparture: 2 });
		expect(sam).toMatchObject({ messagesSinceDeparture: 0 });
		expect(sam).not.toHaveProperty('lastDeparture');
	});
});
