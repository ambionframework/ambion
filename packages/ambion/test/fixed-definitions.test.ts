import { Type } from 'typebox';
import { describe, expect, it, onTestFinished } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	createRuntime,
	defineHuman,
	defineTool,
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
	scriptedAgent,
	stateOf,
	storedOf,
	waitForRoom,
} from './support/room.ts';
import { callTool, quiet, scripted } from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { storages } from './support/storage.ts';

const alpha = scriptedAgent('alpha');
const beta = scriptedAgent('beta');
const gamma = scriptedAgent('gamma');
const priya = defineHuman({ name: 'priya', identity: 'Asks questions.' });
const silent = () => piExecution({ sessions: 'memory', stream: scripted(() => quiet()) });

type Options = Omit<Parameters<typeof startRoom>[0], 'name' | 'runtime'>;

describe.each(storages)('fixed definitions on $name', (storage) => {
	/** A silent room over this storage, stopped at the end of the test. */
	async function open(label: string, options: Options) {
		const opened = await openFor(storage);
		const runtime = createRuntime({ storage: opened.storage });
		const room = await startRoom({
			name: roomName(label),
			runtime,
			execution: silent(),
			...options,
		});
		/** A second runtime over the same storage, as another host would open it. */
		const host = () => createRuntime({ storage: opened.storage });
		return { opened, runtime, host, room: stopAtEnd(room) };
	}

	it.each([
		[
			'a summary writer that is not seated',
			{ agents: [alpha, beta], seats: { alpha: 'broadcast' }, summary: 'beta' },
			/not seated/,
		],
		[
			'a summary name that no definition holds',
			{ agents: [alpha], summary: 'ghost' },
			/summary agent 'ghost'/,
		],
		['a duplicate catalog name', { agents: [alpha, alpha] }, /./],
		['an unknown initial seat', { agents: [alpha], seats: { missing: 'broadcast' } }, /./],
	] as const)('rejects %s before any journal write', async (_case, options, message) => {
		const opened = await openFor(storage);
		const name = roomName('catalog-invalid');
		await expect(
			startRoom({
				name,
				...options,
				runtime: createRuntime({ storage: opened.storage }),
				execution: silent(),
			}),
		).rejects.toThrow(message);
		expect(await storedOf(opened.journals, name)).toEqual([]);
	});

	it('resolves a host seat call that repeats a held seat, without a new entry', async () => {
		const { room } = await open('seat-repeat', {
			agents: [alpha, beta],
			seats: { alpha: 'broadcast' },
		});
		await room.seat('alpha');
		await room.seat('beta');
		const before = (await participantsOf(room)).length;
		const entries = (await messagesOf(room)).length;
		await expect(room.seat('beta')).resolves.toBeUndefined();
		await expect(room.seat('alpha')).resolves.toBeUndefined();
		expect((await participantsOf(room)).length).toBe(before);
		expect((await messagesOf(room)).length).toBe(entries);
	});

	it('leaves a closed exchange without a summary while the host holds the writer out of the room', async () => {
		const { room } = await open('reserve-writer', {
			agents: [alpha, beta],
			seats: { alpha: 'broadcast', beta: 'none' },
			summary: 'beta',
		});
		await room.unseat('beta');
		const visit = await room.visit(priya);
		const first = await visit.send({ text: 'No writer seated yet.' });
		await expect(first.waitForSummary()).resolves.toBeUndefined();
		expect(stateOf(room).closes.at(-1)?.summary).toBeUndefined();
		await room.seat('beta', { attention: 'none' });
		const second = await visit.send({ text: 'The writer is seated now.' });
		await second.waitForSummary();
		expect(stateOf(room).closes.at(-1)?.summary).toBe('beta');
	});

	it('separates the catalog from membership and returns every unseated agent to reserve', async () => {
		const { room } = await open('catalog-membership', { agents: [alpha, beta], seats: {} });
		expect(await participantsOf(room)).toEqual([]);
		expect(stateOf(room).reserve.map((agent) => agent.name)).toEqual(['alpha', 'beta']);
		await room.seat(beta.name, { attention: 'named' });
		await waitForRoom(room);
		expect(await participantsOf(room)).toMatchObject([{ name: beta.name, attention: 'named' }]);
		await room.seat(beta.name, { attention: 'named' });
		expect(await participantsOf(room)).toMatchObject([{ name: beta.name, attention: 'named' }]);
		await expect(room.seat(beta.name, { attention: 'broadcast' })).rejects.toThrow();
		await room.unseat(beta.name);
		await room.unseat(beta.name);
		await room.seat(beta.name);
		expect(await participantsOf(room)).toMatchObject([{ name: beta.name, attention: 'broadcast' }]);
	});

	it('rejects unknown names before writing membership and accepts name-based messages', async () => {
		const { opened, room } = await open('catalog-unknown', { agents: [alpha] });
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
	});

	it('captures structural definitions and initial membership before callers can mutate them', async () => {
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
		const { room } = await open('catalog-capture', {
			agents,
			seats,
			execution: piExecution({
				sessions: 'memory',
				stream: scripted((context, _agent, call) => {
					prompts.push(context.systemPrompt ?? '');
					return call === 1 ? callTool('inspect', {}) : quiet();
				}),
			}),
		});
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
		expect((await messagesOf(room)).find((message) => message.kind === 'said')?.from).toBe('priya');
		await expect(room.seat('replacement')).rejects.toThrow();
	});

	it('preserves membership on resume and records extra definitions for the new run', async () => {
		const { runtime, host, room } = await open('catalog-resume', {
			agents: [alpha, beta],
			seats: { alpha: 'named' },
		});
		await room.seat(beta.name, { attention: 'none' });
		await waitForRoom(room);
		await room.unseat(alpha.name);
		await waitForRoom(room);
		expect(stateOf(room).reserve.map((agent) => agent.name)).toEqual(['alpha']);
		crash(runtime, room);
		const resumed = stopAtEnd(
			await resumeRoom(room.name, {
				agents: [alpha, beta, gamma],
				runtime: host(),
				execution: silent(),
			}),
		);
		expect(await participantsOf(resumed)).toMatchObject([{ name: 'beta', attention: 'none' }]);
		expect(
			stateOf(resumed)
				.reserve.map((agent) => agent.name)
				.sort(),
		).toEqual(['alpha', 'gamma']);
		await resumed.seat('gamma', { attention: 'named' });
		await waitForRoom(resumed);
		const read = await readRoom(room.name, { runtime: host() });
		expect(read.participants.map((participant) => participant.name)).toEqual(['beta', 'gamma']);
		await expect(
			resumeRoom(room.name, { agents: [beta, gamma], runtime: host(), execution: silent() }),
		).rejects.toThrow();
		// Failed validation must not fence the current host.
		await resumed.seat('alpha');
		expect((await participantsOf(resumed)).map((participant) => participant.name)).toContain(
			'alpha',
		);
	});

	it('rejects an added definition that collides with a person without fencing the host', async () => {
		const { opened, host, room } = await open('catalog-person-collision', { agents: [alpha] });
		const visit = await room.visit(priya);
		const before = await storedOf(opened.journals, room.name);
		await expect(
			resumeRoom(room.name, {
				agents: [alpha, { ...beta, name: priya.name }],
				runtime: host(),
				execution: silent(),
			}),
		).rejects.toThrow(/person/);
		expect(await storedOf(opened.journals, room.name)).toEqual(before);
		await visit.send({ to: alpha.name, text: 'The original run still works.' });
		await waitForRoom(room);
		expect((await messagesOf(room)).some((message) => message.kind === 'said')).toBe(true);
	});

	it('revalidates definitions against a competing resume before fencing it', async () => {
		const { opened, host, room } = await open('catalog-competing-resume', { agents: [alpha] });
		const entered = deferred();
		const release = deferred();
		onTestFinished(release.resolve);
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
		const old = resumeRoom(room.name, { agents: [alpha], runtime: delayed, execution: silent() });
		const rejected = expect(old).rejects.toThrow(/beta/);
		await entered.promise;
		const newer = stopAtEnd(
			await resumeRoom(room.name, { agents: [alpha, beta], runtime: host(), execution: silent() }),
		);
		const before = await storedOf(opened.journals, room.name);
		release.resolve();
		await rejected;
		expect(await storedOf(opened.journals, room.name)).toEqual(before);
		await newer.seat('beta');
		expect((await participantsOf(newer)).map((participant) => participant.name)).toContain('beta');
	});
});
