import { strict as assert } from 'node:assert';
import {
	defineHuman,
	type Message,
	type Room,
	type RoomNotification,
} from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { evidence } from '../src/evidence.ts';
import { runEvals } from '../src/report.ts';
import { defineRoomEval } from '../src/simulation.ts';
import type { HumanSimulator } from '../src/simulation-types.ts';

const priya = defineHuman({ name: 'priya', identity: 'Owns the request.' });
const cara = defineHuman({ name: 'cara', identity: 'Reviews the result.' });

describe('room simulation adapter', () => {
	it('runs serial multi-human actions and excludes seeded history from result exchanges', async () => {
		const room = fakeRoom(true);
		const seen: string[] = [];
		const simulator: HumanSimulator = {
			async decide({ actions, observation }) {
				assert.equal(observation.exchange, undefined);
				if (actions.length === 0)
					return { action: { kind: 'say', human: 'priya', text: 'status?' } };
				if (actions.length === 1)
					return { action: { kind: 'say', human: 'cara', text: 'review?' } };
				return { action: { kind: 'finish', reason: 'Both owners received the result.' } };
			},
		};
		const report = await runEvals([
			defineRoomEval({
				id: 'simulation-multi-human',
				version: 1,
				input: { question: 'status?' },
				humans: [priya, cara],
				simulator,
				limits: { maxActions: 2, settleTimeoutMs: 100 },
				async setup() {
					return { room, fixture: { phase: 0 } };
				},
				beforeAction({ fixture }) {
					fixture.phase += 1;
				},
				async capture({ result }) {
					seen.push(...(result?.actions.map((action) => action.kind) ?? []));
					return { trace: evidence([...(result?.actions ?? [])]) };
				},
				checks: [
					{
						id: 'two-actions',
						requires: ['trace'],
						async evaluate({ output }) {
							assert.equal(output.actions.filter((action) => action.kind === 'say').length, 2);
						},
					},
				],
				judge: {
					id: 'judge',
					requires: ['simulation'],
					async evaluate() {},
				},
				async teardown() {},
			}),
		]);
		expect(report.passed).toBe(true);
		expect(seen).toEqual(['say', 'say']);
		const output = report.samples[0]?.output as unknown as {
			exchanges: readonly { from: number }[];
		};
		expect(output.exchanges).toHaveLength(2);
		expect(output.exchanges.every((exchange) => exchange.from !== 1)).toBe(true);
	});

	it('treats a finish before any message as incomplete even when the judge is permissive', async () => {
		const report = await runEvals([
			defineRoomEval({
				id: 'simulation-incomplete',
				version: 1,
				input: {},
				humans: [priya],
				simulator: {
					async decide() {
						return { action: { kind: 'finish', reason: 'done' } };
					},
				},
				limits: { maxActions: 1, settleTimeoutMs: 100 },
				async setup() {
					return { room: fakeRoom(false), fixture: {} };
				},
				async capture() {
					return { trace: [] };
				},
				checks: [],
				judge: { id: 'judge', requires: ['simulation'], async evaluate() {} },
				async teardown() {},
			}),
		]);
		expect(report.passed).toBe(false);
		expect(
			report.samples[0]?.checks.find((check) => check.id === 'simulation-complete')?.status,
		).toBe('failed');
	});
});

function fakeRoom(withHistory: boolean): Room {
	let seq = withHistory ? 1 : 0;
	const messages: Message[] = withHistory
		? [{ kind: 'said', seq: 1, from: 'old', text: 'history', at: new Date(0).toISOString() }]
		: [];
	const owners = new Map<number, string>();
	const listeners = new Set<(event: RoomNotification) => void>();
	const visits = new Set<string>();
	const snapshot = (): ReturnType<Room['read']> =>
		Promise.resolve({
			initialized: true,
			name: 'fake-room',
			messages: messages.map((message) => structuredClone(message)),
			participants: [...visits].map((name) => ({
				kind: 'human' as const,
				name,
				identity: name,
				presence: 'present' as const,
			})),
			exchanges: [...owners.entries()].map(([from, owner]) => ({
				status: 'closed' as const,
				owner,
				from,
				at: new Date(0).toISOString(),
				through: from,
				summary: { status: 'silent' as const },
			})),
			exchange: undefined,
			watermark: seq,
		});
	const room = {
		name: 'fake-room',
		read: snapshot,
		subscribe(listener: (event: RoomNotification) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		exchange() {
			return undefined;
		},
		async visit(human: typeof priya) {
			visits.add(human.name);
			return {
				human,
				since: undefined,
				async send(input: { text: string; to?: string }) {
					const from = ++seq;
					const message = {
						kind: 'said' as const,
						seq: from,
						from: human.name,
						text: input.text,
						...(input.to ? { to: input.to } : {}),
						at: new Date(0).toISOString(),
					};
					messages.push(message);
					owners.set(from, human.name);
					for (const listener of listeners) listener({ type: 'message', message });
					return {
						owner: human.name,
						from,
						at: message.at,
						waitForClose: async () => [message],
						waitForSummary: async () => undefined,
					};
				},
				async leave() {},
			};
		},
		async stop() {},
		async abort() {},
		async seat() {},
		async unseat() {},
		async reconcile() {},
	} as unknown as Room;
	return room;
}
