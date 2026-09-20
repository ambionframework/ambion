import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	defineTool,
	pi,
	type Room,
	readRoom,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import {
	crash,
	deferred,
	messagesOf,
	participantsOf,
	roomName,
	stateOf,
	storedOf,
	waitForRoom,
} from './support/room.ts';
import { callTool, quiet, scripted } from './support/scripted.ts';
import { storages } from './support/storage.ts';

const alpha = defineAgent({
	name: 'alpha',
	identity: 'Alpha.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/alpha' }),
});
const beta = defineAgent({
	name: 'beta',
	identity: 'Beta.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/beta' }),
});
const gamma = defineAgent({
	name: 'gamma',
	identity: 'Gamma.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/gamma' }),
});
const priya = defineHuman({ name: 'priya', identity: 'Asks questions.' });
const silent = () => scripted(() => quiet());

describe.each(storages)('fixed definitions on $name', (storage) => {
	it('keeps a configured summary writer in reserve until it is seated', async () => {
		const opened = await storage.open();
		const runtime = createRuntime({ storage: opened.storage });
		const room = await startRoom({
			name: roomName('reserve-writer'),
			agents: [alpha, beta],
			seats: { alpha: 'broadcast' },
			summary: 'beta',
			runtime,
			streamFn: silent(),
		});
		try {
			const visit = await room.visit(priya);
			const first = await visit.send({ text: 'No writer seated yet.' });
			await expect(first.waitForSummary()).resolves.toBeUndefined();
			expect(stateOf(room).closes.at(-1)?.summary).toBeUndefined();
			await room.seat('beta', { attention: 'none' });
			const second = await visit.send({ text: 'The writer is seated now.' });
			await second.waitForSummary();
			expect(stateOf(room).closes.at(-1)?.summary).toBe('beta');
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('separates the catalog from membership and returns every unseated agent to reserve', async () => {
		const opened = await storage.open();
		const room = await startRoom({
			name: roomName('catalog-membership'),
			agents: [alpha, beta],
			seats: {},
			runtime: createRuntime({ storage: opened.storage }),
			streamFn: silent(),
		});
		try {
			expect(await participantsOf(room)).toEqual([]);
			expect(stateOf(room).reserve.map((agent) => agent.name)).toEqual(['alpha', 'beta']);
			await room.seat(beta.name, { attention: 'named' });
			await waitForRoom(room);
			expect(await participantsOf(room)).toMatchObject([{ name: beta.name, attention: 'named' }]);
			await room.unseat(beta.name);
			await room.seat(beta.name);
			expect(await participantsOf(room)).toMatchObject([
				{ name: beta.name, attention: 'broadcast' },
			]);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('rejects unknown names before writing membership and accepts name-based messages', async () => {
		const opened = await storage.open();
		const room = await startRoom({
			name: roomName('catalog-unknown'),
			agents: [alpha],
			runtime: createRuntime({ storage: opened.storage }),
			streamFn: silent(),
		});
		try {
			const before = await storedOf(opened.journals, room.name);
			await expect(room.seat('missing')).rejects.toThrow();
			await expect(room.unseat('missing')).rejects.toThrow();
			// @ts-expect-error Membership accepts names, never executable definitions.
			await expect(room.seat(beta)).rejects.toThrow();
			expect(await storedOf(opened.journals, room.name)).toEqual(before);
			const visit = await room.visit(priya);
			await visit.send({ to: alpha.name, text: 'By name.' });
			await waitForRoom(room);
			expect((await messagesOf(room)).find((message) => message.kind === 'said')).toMatchObject({
				from: priya.name,
				to: alpha.name,
				text: 'By name.',
			});
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('captures structural definitions and initial membership before callers can mutate them', async () => {
		const opened = await storage.open();
		const calls: string[] = [];
		const tool = {
			...defineTool({
				name: 'inspect',
				description: 'Original tool.',
				parameters: Type.Object({}),
				execute: () => {
					calls.push('original');
					return 'done';
				},
			}),
		};
		const definition = {
			name: 'alpha',
			identity: 'Original.',
			executor: {
				kind: 'pi' as const,
				instructions: 'Original instructions.',
				model: 'scripted/alpha',
				tools: [tool],
			},
		};
		const agents = [definition];
		const seats = { alpha: 'named' as const };
		const prompts: string[] = [];
		const room = await startRoom({
			name: roomName('catalog-capture'),
			agents,
			seats,
			runtime: createRuntime({ storage: opened.storage }),
			streamFn: scripted((context, _agent, call) => {
				prompts.push(context.systemPrompt ?? '');
				return call === 1 ? callTool('inspect', {}) : quiet();
			}),
		});
		try {
			definition.name = 'replacement';
			definition.identity = 'Changed.';
			definition.executor.instructions = 'Changed instructions.';
			tool.invoke = () => {
				calls.push('replacement');
				return 'changed';
			};
			agents.splice(0);
			delete (seats as Partial<typeof seats>).alpha;
			const person = { name: 'priya', identity: 'Original person.' };
			const visiting = room.visit(person);
			person.name = 'someone-else';
			const visit = await visiting;
			await visit.send({ to: 'alpha', text: 'Use captured values.' });
			await waitForRoom(room);
			expect(await participantsOf(room)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: 'alpha', identity: 'Original.', attention: 'named' }),
				]),
			);
			expect(prompts.every((prompt) => prompt.includes('Original instructions.'))).toBe(true);
			expect(prompts.length).toBeGreaterThan(0);
			expect(calls).toEqual(['original']);
			expect((await messagesOf(room)).find((message) => message.kind === 'said')?.from).toBe(
				'priya',
			);
			await expect(room.seat('replacement')).rejects.toThrow();
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('preserves membership on resume and records extra definitions for the new run', async () => {
		const opened = await storage.open();
		const runtime = createRuntime({ storage: opened.storage });
		const room = await startRoom({
			name: roomName('catalog-resume'),
			agents: [alpha, beta],
			seats: { alpha: 'named' },
			runtime,
			streamFn: silent(),
		});
		let resumed: Room | undefined;
		try {
			await room.seat(beta.name, { attention: 'none' });
			await waitForRoom(room);
			await room.unseat(alpha.name);
			await waitForRoom(room);
			expect(stateOf(room).reserve.map((agent) => agent.name)).toEqual(['alpha']);
			crash(runtime, room);
			resumed = await resumeRoom(room.name, {
				agents: [alpha, beta, gamma],
				runtime: createRuntime({ storage: opened.storage }),
				streamFn: silent(),
			});
			expect(await participantsOf(resumed)).toMatchObject([{ name: 'beta', attention: 'none' }]);
			expect(
				stateOf(resumed)
					.reserve.map((agent) => agent.name)
					.sort(),
			).toEqual(['alpha', 'gamma']);
			await resumed.seat('gamma', { attention: 'named' });
			await waitForRoom(resumed);
			const read = await readRoom(room.name, {
				runtime: createRuntime({ storage: opened.storage }),
			});
			expect(read.participants.map((participant) => participant.name)).toEqual(['beta', 'gamma']);
			await expect(
				resumeRoom(room.name, {
					agents: [beta, gamma],
					runtime: createRuntime({ storage: opened.storage }),
					streamFn: silent(),
				}),
			).rejects.toThrow();
			// Failed validation must not fence the current host.
			await resumed.seat('alpha');
			expect((await participantsOf(resumed)).map((participant) => participant.name)).toContain(
				'alpha',
			);
		} finally {
			await resumed?.stop();
			await room.stop();
			await opened.dispose();
		}
	});

	it('rejects an added definition that collides with a person without fencing the host', async () => {
		const opened = await storage.open();
		const room = await startRoom({
			name: roomName('catalog-person-collision'),
			agents: [alpha],
			runtime: createRuntime({ storage: opened.storage }),
			streamFn: silent(),
		});
		try {
			const visit = await room.visit(priya);
			const before = await storedOf(opened.journals, room.name);
			await expect(
				resumeRoom(room.name, {
					agents: [alpha, { ...beta, name: priya.name }],
					runtime: createRuntime({ storage: opened.storage }),
					streamFn: silent(),
				}),
			).rejects.toThrow(/person/);
			expect(await storedOf(opened.journals, room.name)).toEqual(before);
			await visit.send({ to: alpha.name, text: 'The original run still works.' });
			await waitForRoom(room);
			expect((await messagesOf(room)).some((message) => message.kind === 'said')).toBe(true);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('revalidates definitions against a competing resume before fencing it', async () => {
		const opened = await storage.open();
		const room = await startRoom({
			name: roomName('catalog-competing-resume'),
			agents: [alpha],
			runtime: createRuntime({ storage: opened.storage }),
			streamFn: silent(),
		});
		const entered = deferred();
		const release = deferred();
		let reads = 0;
		const delayed = createRuntime({
			storage: {
				async open(name) {
					const journal = await opened.storage.open(name);
					return {
						async read(after) {
							if (++reads === 2) {
								entered.resolve();
								await release.promise;
							}
							return journal.read(after);
						},
						append: journal.append.bind(journal),
					};
				},
			},
		});
		let newer: Room | undefined;
		try {
			const old = resumeRoom(room.name, { agents: [alpha], runtime: delayed, streamFn: silent() });
			const rejected = expect(old).rejects.toThrow(/beta/);
			await entered.promise;
			newer = await resumeRoom(room.name, {
				agents: [alpha, beta],
				runtime: createRuntime({ storage: opened.storage }),
				streamFn: silent(),
			});
			const before = await storedOf(opened.journals, room.name);
			release.resolve();
			await rejected;
			expect(await storedOf(opened.journals, room.name)).toEqual(before);
			await newer.seat('beta');
			expect((await participantsOf(newer)).map((participant) => participant.name)).toContain(
				'beta',
			);
		} finally {
			release.resolve();
			await newer?.stop();
			await room.stop();
			await opened.dispose();
		}
	});

	it('rejects duplicate catalog names and unknown initial membership before journal writes', async () => {
		const opened = await storage.open();
		try {
			for (const options of [
				{ agents: [alpha, alpha] },
				{ agents: [alpha], summary: 'missing' },
				{ agents: [alpha], seats: { missing: 'broadcast' as const } },
			]) {
				const name = roomName('catalog-invalid');
				await expect(
					startRoom({
						name,
						...options,
						runtime: createRuntime({ storage: opened.storage }),
						streamFn: silent(),
					}),
				).rejects.toThrow();
				expect(await storedOf(opened.journals, name)).toEqual([]);
			}
		} finally {
			await opened.dispose();
		}
	});
});
