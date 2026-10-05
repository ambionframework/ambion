import { memoryJournals } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	type AgentDefinition,
	type Attention,
	createRuntime,
	definePerson,
	isPresence,
	type Message,
	type Room,
	type RoomNotification,
	readRoom,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import {
	collect,
	deferred,
	messagesOf,
	participantsOf,
	roomName,
	scriptedAgent,
	waitForRoom,
} from './support/room.ts';
import {
	byAgent,
	callTool,
	contextText,
	type PiScript,
	quiet,
	say,
	scriptedStream,
	seat,
	toolNames,
	toolResultTexts,
} from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';

const product = scriptedAgent('product', 'The product lead.');
const surveyor = scriptedAgent('surveyor', 'Quantity surveyor. Holds the tonnage.');
const architect = scriptedAgent('architect', 'Architect. Holds the drawings.');
const greeter = scriptedAgent('greeter', 'Meets people at the door.');
const writer = scriptedAgent('writer', 'Writes the one message a person reads at the close.');
const priya = definePerson({ name: 'priya', identity: 'Project manager.' });

const runtime = createRuntime({ storage: memoryJournals(), clock: fakeClock() });

async function open(options: {
	script: PiScript;
	agents?: readonly AgentDefinition[];
	available?: readonly AgentDefinition[];
	seats?: Readonly<Record<string, Attention>>;
	summary?: boolean;
	seating?: boolean;
}): Promise<Room> {
	const definitions = [
		...(options.agents ?? []),
		...(options.available ?? []),
		...(options.summary ? [writer] : []),
	];
	const seats = options.seats ?? {
		...(options.summary ? { [writer.name]: 'none' as const } : {}),
		...Object.fromEntries((options.agents ?? []).map((agent) => [agent.name, 'broadcast'])),
	};
	const session = await startRoom({
		name: roomName('roster'),
		goal: 'Decide the pour date.',
		agents: definitions,
		seats,
		...(options.summary ? { summaryWriter: writer.name } : {}),
		...(options.seating === undefined ? {} : { seating: options.seating }),
		runtime,
		execution: piExecution({ sessions: 'memory', stream: scriptedStream(options.script) }),
	});
	return stopAtEnd(session);
}

const kinds = (record: readonly Message[]) => record.map((message) => message.kind);
const presence = (record: readonly Message[]) => record.filter(isPresence);
const activated = (events: RoomNotification[]) =>
	events.filter((event) => event.type === 'activation_start').map((event) => event.seat);
const seatNames = async (session: Room) =>
	(await participantsOf(session)).filter((seat) => seat.kind === 'agent').map((seat) => seat.name);
describe('ordinary participation', () => {
	it('shows every ordinary seat the reserve and membership tools, and wakes presence observers', async () => {
		const contexts: string[] = [];
		const tools: string[][] = [];
		const session = await open({
			agents: [product, greeter],
			available: [surveyor],
			seats: { product: 'broadcast', greeter: 'presence' },
			script: byAgent({
				product: (context, _name, request) => {
					contexts.push(contextText(context));
					tools.push(toolNames(context));
					return request === 1 ? seat(surveyor.name) : quiet();
				},
				surveyor: (_context, _name, request) =>
					request === 1 ? say('11.7 tonnes on site.') : quiet(),
				greeter: () => quiet(),
			}),
		});
		const events = collect(session);

		await (await session.visit(priya)).send({ text: 'How much steel is on site?' });
		await waitForRoom(session);

		expect(tools[0]).toEqual([
			'say',
			'schedule',
			'seat',
			'unseat',
			'dismiss',
			'recall',
			'compose',
			'describe',
		]);
		expect(contexts[1]).toMatch(/seated surveyor \(#\d+\)/);
		expect(contexts[0]).toContain('The reserve: agents not in the room.');
		expect(contexts[0]).toContain('- surveyor: Quantity surveyor. Holds the tonnage.');
		const record = await messagesOf(session);
		expect(kinds(record)).toEqual(['arrived', 'said', 'seated', 'said']);
		expect(presence(record).find((message) => message.kind === 'seated')).toMatchObject({
			from: 'product',
			subject: 'surveyor',
		});
		expect(activated(events)).toContain('surveyor');
		expect(activated(events)).toContain('greeter');
		expect(await seatNames(session)).toEqual(['product', 'greeter', 'surveyor']);
	});

	it.each([
		['an empty reserve', undefined, ['say', 'schedule', 'unseat', 'dismiss', 'recall']],
		[
			'an agent in the reserve',
			surveyor,
			['say', 'schedule', 'seat', 'unseat', 'dismiss', 'recall'],
		],
	])(
		'with %s, offers `seat` only when the reserve holds an agent',
		async (_case, held, offered) => {
			const contexts: string[] = [];
			const tools: string[][] = [];
			const session = await open({
				agents: [product],
				available: held === undefined ? [] : [held],
				script: byAgent({
					product: (context) => {
						contexts.push(contextText(context));
						tools.push(toolNames(context));
						return quiet();
					},
				}),
			});
			await (await session.visit(priya)).send({ text: 'Who is here?' });
			await waitForRoom(session);
			expect(tools[0]?.filter((name) => name !== 'compose' && name !== 'describe')).toEqual(
				offered,
			);
			expect(contexts[0]?.includes('The reserve: agents not in the room.')).toBe(
				held !== undefined,
			);
		},
	);

	it.each([
		[
			'a reserve that the seating empties',
			[surveyor],
			['say', 'schedule', 'seat', 'unseat', 'dismiss', 'recall'],
			surveyor.name,
			'seat',
		],
		[
			'no reserve that the unseating fills',
			[],
			['say', 'schedule', 'unseat', 'dismiss', 'recall'],
			surveyor.name,
			'unseat',
		],
	])(
		'keeps the tool list of a seat the same after %s',
		async (_case, reserve, offered, name, operation) => {
			const tools: string[][] = [];
			const session = await open({
				agents: reserve.length === 0 ? [product, surveyor] : [product],
				available: reserve,
				script: byAgent({
					product: (context, _name, request) => {
						tools.push(toolNames(context));
						return request === 1 ? callTool(operation, { name }) : quiet();
					},
					surveyor: () => quiet(),
				}),
			});
			await (await session.visit(priya)).send({ text: 'Change the team.' });
			await waitForRoom(session);
			expect(await seatNames(session)).toEqual(
				operation === 'seat' ? [product.name, name] : [product.name],
			);
			expect(tools).toHaveLength(2);
			expect(tools[1]).toEqual(tools[0]);
			expect(tools[0]?.filter((tool) => tool !== 'compose' && tool !== 'describe')).toEqual(
				offered,
			);
		},
	);

	it('keeps the tool list of a seat the same across a stop and a resume', async () => {
		const tools: string[][] = [];
		const session = await open({
			agents: [product],
			available: [surveyor],
			script: byAgent({ surveyor: () => quiet() }),
		});
		await session.seat(surveyor.name);
		await waitForRoom(session);
		await session.stop();
		// The reserve is empty now, and the recomposed entry holds no agent in its reserve.
		const resumed = stopAtEnd(
			await resumeRoom(session.name, {
				agents: [product, surveyor],
				runtime,
				execution: piExecution({
					sessions: 'memory',
					stream: scriptedStream(
						byAgent({
							product: (context) => {
								tools.push(toolNames(context));
								return quiet();
							},
							surveyor: () => quiet(),
						}),
					),
				}),
			}),
		);
		await (await resumed.visit(priya)).send({ text: 'Who is here?' });
		await waitForRoom(resumed);
		expect(tools[0]).toContain('seat');
	});

	it('keeps a room composed with an empty reserve without `seat` after an unseat, a stop, and a resume', async () => {
		const before: string[][] = [];
		const after: string[][] = [];
		const session = await open({
			agents: [product, surveyor],
			script: byAgent({
				product: (context, _name, request) => {
					before.push(toolNames(context));
					return request === 1 ? callTool('unseat', { name: surveyor.name }) : quiet();
				},
				surveyor: () => quiet(),
			}),
		});
		await (await session.visit(priya)).send({ text: 'Change the team.' });
		await waitForRoom(session);
		expect(await seatNames(session)).toEqual([product.name]);
		await session.stop();
		// The reserve holds the unseated agent now. No agent is new, so the rule stays.
		const resumed = stopAtEnd(
			await resumeRoom(session.name, {
				agents: [product, surveyor],
				runtime,
				execution: piExecution({
					sessions: 'memory',
					stream: scriptedStream(
						byAgent({
							product: (context) => {
								after.push(toolNames(context));
								return quiet();
							},
						}),
					),
				}),
			}),
		);
		await (await resumed.visit(priya)).send({ text: 'Who is here?' });
		await waitForRoom(resumed);
		expect(before[0]).not.toContain('seat');
		expect(after[0]).toEqual(before[0]);
	});

	it('offers neither `seat` nor `unseat` when the host turned seating off, and the host still seats', async () => {
		const contexts: string[] = [];
		const tools: string[][] = [];
		const session = await open({
			agents: [product],
			available: [surveyor],
			seating: false,
			script: byAgent({
				product: (context) => {
					contexts.push(contextText(context));
					tools.push(toolNames(context));
					return quiet();
				},
				surveyor: () => quiet(),
			}),
		});
		await (await session.visit(priya)).send({ text: 'Who is here?' });
		await waitForRoom(session);
		expect(tools[0]).toEqual(['say', 'schedule', 'dismiss', 'recall', 'compose', 'describe']);
		expect(contexts[0]).not.toContain('The reserve:');
		// The host keeps its own seating, and the room still reads the reserve.
		expect((await readRoom(session.name, { runtime })).reserve.map((one) => one.name)).toEqual([
			surveyor.name,
		]);
		await session.seat(surveyor.name);
		expect(await seatNames(session)).toEqual([product.name, surveyor.name]);
		await session.unseat(surveyor.name);
		expect(await seatNames(session)).toEqual([product.name]);
	});

	it('recalls a message of the record through the room, and the recall commits nothing', async () => {
		const recalled: string[] = [];
		const session = await open({
			agents: [product],
			script: byAgent({
				product: (context, _name, request) => {
					if (request === 2) recalled.push(...toolResultTexts(context));
					// The ask line names the URI of the question.
					const uri = /The opening message's URI is (\S+)\./.exec(contextText(context))?.[1];
					return request === 1 && uri !== undefined ? callTool('recall', { refs: [uri] }) : quiet();
				},
			}),
		});
		await (await session.visit(priya)).send({ text: 'How much steel is on site?' });
		await waitForRoom(session);
		expect(recalled).toEqual([
			expect.stringMatching(/^#\d+ \[priya\] How much steel is on site\?$/),
		]);
		expect(kinds(await messagesOf(session))).toEqual(['arrived', 'said']);
	});

	it('lets an ordinary seat add several colleagues without a local call quota', async () => {
		const session = await open({
			agents: [product],
			available: [surveyor, architect, greeter],
			script: byAgent({
				product: (_context, _name, request) => {
					const next = [surveyor, architect, greeter][request - 1];
					return next === undefined ? quiet() : seat(next.name);
				},
			}),
		});

		await (await session.visit(priya)).send({ text: 'Bring everyone needed.' });
		await waitForRoom(session);

		expect(await seatNames(session)).toEqual(['product', 'surveyor', 'architect', 'greeter']);
		expect(kinds(await messagesOf(session))).toEqual([
			'arrived',
			'said',
			'seated',
			'seated',
			'seated',
		]);
	});

	it('passes a colleague steering message to an ordinary seat still selecting membership', async () => {
		const held = deferred();
		const contexts: string[] = [];
		const session = await open({
			agents: [product, surveyor],
			available: [architect],
			script: byAgent({
				product: async (context, _name, request) => {
					contexts.push(contextText(context));
					if (request === 1) {
						await held.promise;
						return seat(architect.name);
					}
					return quiet();
				},
				surveyor: (_context, _name, request) =>
					request === 1 ? say('The drawings will settle this.', product.name) : quiet(),
			}),
		});
		const events = collect(session);

		await (await session.visit(priya)).send({ text: 'How should we plan the pour?' });
		await new Promise<void>((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type !== 'activation_end' || event.seat !== surveyor.name) return;
				off();
				resolve();
			});
		});
		held.resolve();
		await waitForRoom(session);

		expect(contexts.at(-1)).toContain('[surveyor → product] The drawings will settle this.');
		expect(await seatNames(session)).toContain(architect.name);
		expect(activated(events)).toContain(product.name);
	});
});

describe('ordinary unseating and host membership', () => {
	it('returns an unchanged seating unacknowledged, refuses to unseat the fixed writer, and unseats a colleague', async () => {
		const contexts: string[] = [];
		const session = await open({
			agents: [product, surveyor],
			// The reserve holds an agent, so the activation holds the `seat` tool.
			available: [architect],
			summary: true,
			script: byAgent({
				product: (context, _name, request) => {
					contexts.push(contextText(context));
					if (request === 1) return callTool('seat', { name: surveyor.name });
					if (request === 2) return callTool('unseat', { name: writer.name });
					return request === 3 ? callTool('unseat', { name: surveyor.name }) : quiet();
				},
				surveyor: () => quiet(),
			}),
		});
		const events = collect(session);

		await (await session.visit(priya)).send({ text: 'Is the team ready?' });
		await waitForRoom(session);

		expect(contexts[1]).toContain(`${surveyor.name} is already seated`);
		expect(contexts[3]).toMatch(/unseated surveyor \(#\d+\)/);
		const record = await messagesOf(session);
		expect(record.filter((message) => message.kind === 'seated')).toHaveLength(0);
		expect(record.filter((message) => message.kind === 'unseated')).toMatchObject([
			{ from: product.name, subject: surveyor.name },
		]);
		expect(await seatNames(session)).toEqual([product.name, writer.name]);
		expect(activated(events)).toContain(product.name);
	});

	it('preserves host seat and unseat records across a stopped and resumed room', async () => {
		const session = await open({
			agents: [product],
			available: [surveyor],
			script: byAgent({ surveyor: () => quiet() }),
		});

		await session.seat(surveyor.name);
		await waitForRoom(session);
		expect(await seatNames(session)).toEqual([product.name, surveyor.name]);
		await session.unseat(surveyor.name);
		expect(await seatNames(session)).toEqual([product.name]);
		const record = await messagesOf(session);
		expect(kinds(record)).toEqual(['seated', 'unseated']);
		expect(presence(record).every((message) => message.from === undefined)).toBe(true);

		await session.stop();
		const stopped = await readRoom(session.name, { runtime });
		expect(stopped.participants.map((seat) => seat.name)).toEqual([product.name]);
		const resumed = await resumeRoom(session.name, {
			agents: [product, surveyor],
			runtime,
			execution: piExecution({ sessions: 'memory', stream: scriptedStream(byAgent({})) }),
		});
		expect(await seatNames(stopAtEnd(resumed))).toEqual([product.name]);
	});
});
