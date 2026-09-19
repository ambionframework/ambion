import { afterEach, describe, expect, it } from 'vitest';
import {
	type AgentDefinition,
	type Attention,
	createRuntime,
	defineAgent,
	defineHuman,
	isPresence,
	type Message,
	type Room,
	type RoomNotification,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import {
	collect,
	deferred,
	messagesOf,
	participantsOf,
	roomName,
	waitForRoom,
} from './support/room.ts';
import {
	byAgent,
	callTool,
	contextText,
	quiet,
	type Script,
	scripted,
	seat,
	speak,
	toolNames,
} from './support/scripted.ts';

const product = defineAgent({
	name: 'product',
	identity: 'The product lead.',
	instructions: 'Answer questions and bring in a specialist when needed.',
	model: 'scripted/product',
});
const surveyor = defineAgent({
	name: 'surveyor',
	identity: 'Quantity surveyor. Holds the tonnage.',
	instructions: 'Answer questions about quantities.',
	model: 'scripted/surveyor',
});
const architect = defineAgent({
	name: 'architect',
	identity: 'Architect. Holds the drawings.',
	instructions: 'Answer questions about drawings.',
	model: 'scripted/architect',
});
const greeter = defineAgent({
	name: 'greeter',
	identity: 'Meets people at the door.',
	instructions: 'Notice arrivals and departures.',
	model: 'scripted/greeter',
});
const writer = defineAgent({
	name: 'writer',
	identity: 'Writes the one message a person reads at the close.',
	instructions: 'Write only the useful answer for the person.',
	model: 'scripted/writer',
});
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

const clock = fakeClock();
const runtime = createRuntime({ clock });
const started: Room[] = [];

async function open(options: {
	script: Script;
	agents?: readonly AgentDefinition[];
	available?: readonly AgentDefinition[];
	seats?: Readonly<Record<string, Attention>>;
	summary?: boolean;
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
		...(options.summary ? { summary: writer.name } : {}),
		runtime,
		streamFn: scripted(options.script),
	});
	started.push(session);
	return session;
}

afterEach(async () => {
	for (const session of started.splice(0)) await session.stop();
});

const kinds = (record: readonly Message[]) => record.map((message) => message.kind);
const presence = (record: readonly Message[]) => record.filter(isPresence);
const activated = (events: RoomNotification[]) =>
	events.filter((event) => event.type === 'activation_start').map((event) => event.agent);
const seatNames = async (session: Room) =>
	(await participantsOf(session)).filter((seat) => seat.kind === 'agent').map((seat) => seat.name);
describe('ordinary participation', () => {
	it('shows every ordinary seat the reserve and membership tools', async () => {
		const contexts: string[] = [];
		const tools: string[][] = [];
		const session = await open({
			agents: [product],
			available: [surveyor],
			script: byAgent({
				product: (context, _name, call) => {
					contexts.push(contextText(context));
					tools.push(toolNames(context));
					return call === 1 ? seat(surveyor.name) : quiet();
				},
				surveyor: (_context, _name, call) => (call === 1 ? speak('11.7 tonnes on site.') : quiet()),
			}),
		});
		const events = collect(session);

		await (await session.visit(priya)).send({ text: 'How much steel is on site?' });
		await waitForRoom(session);

		expect(tools[0]).toEqual(['say', 'task', 'task_update', 'seat', 'unseat']);
		expect(contexts[0]).toContain('The reserve: agents not in the room.');
		expect(contexts[0]).toContain('- surveyor: Quantity surveyor. Holds the tonnage.');
		expect(kinds(await messagesOf(session))).toEqual(['arrived', 'said', 'seated', 'said']);
		expect(
			presence(await messagesOf(session)).find((message) => message.kind === 'seated'),
		).toMatchObject({
			from: 'product',
			subject: 'surveyor',
		});
		expect(activated(events)).toContain('surveyor');
		expect(await seatNames(session)).toEqual(['product', 'surveyor']);
	});

	it('lets an ordinary seat add several colleagues without a local call quota', async () => {
		const session = await open({
			agents: [product],
			available: [surveyor, architect, greeter],
			script: byAgent({
				product: (_context, _name, call) => {
					const next = [surveyor, architect, greeter][call - 1];
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

	it('returns an unchanged membership result without acknowledging or duplicating it', async () => {
		const contexts: string[] = [];
		const session = await open({
			agents: [product, surveyor],
			script: byAgent({
				product: (context, _name, call) => {
					contexts.push(contextText(context));
					return call === 1 ? callTool('seat', { name: surveyor.name }) : quiet();
				},
				surveyor: () => quiet(),
			}),
		});

		await (await session.visit(priya)).send({ text: 'Is the team ready?' });
		await waitForRoom(session);

		const record = await messagesOf(session);
		expect(record.filter((message) => message.kind === 'seated')).toHaveLength(0);
		expect(await seatNames(session)).toEqual(['product', 'surveyor']);
		expect(contexts[1]).toContain('delivered');
	});

	it('wakes presence observers when membership changes', async () => {
		const session = await open({
			agents: [product, greeter],
			available: [surveyor],
			seats: { product: 'broadcast', greeter: 'presence' },
			script: byAgent({
				product: (_context, _name, call) => (call === 1 ? seat(surveyor.name) : quiet()),
				greeter: () => quiet(),
			}),
		});
		const events = collect(session);

		await (await session.visit(priya)).send({ text: 'Who should join?' });
		await waitForRoom(session);

		expect(activated(events)).toContain('greeter');
		expect(activated(events)).toContain('surveyor');
	});

	it('passes a colleague steering message to an ordinary seat still selecting membership', async () => {
		const held = deferred();
		const contexts: string[] = [];
		const session = await open({
			agents: [product, surveyor],
			available: [architect],
			script: byAgent({
				product: async (context, _name, call) => {
					contexts.push(contextText(context));
					if (call === 1) {
						await held.promise;
						return seat(architect.name);
					}
					return quiet();
				},
				surveyor: (_context, _name, call) =>
					call === 1 ? speak('The drawings will settle this.', product.name) : quiet(),
			}),
		});
		const events = collect(session);

		await (await session.visit(priya)).send({ text: 'How should we plan the pour?' });
		await new Promise<void>((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type !== 'activation_end' || event.agent !== surveyor.name) return;
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
	it('lets an ordinary seat unseat a colleague and records the departure', async () => {
		const session = await open({
			agents: [product, surveyor],
			script: byAgent({
				product: (_context, _name, call) =>
					call === 1 ? callTool('unseat', { name: surveyor.name }) : quiet(),
				surveyor: () => quiet(),
			}),
		});
		const events = collect(session);

		await (await session.visit(priya)).send({ text: 'Can anyone decide?' });
		await waitForRoom(session);

		const record = await messagesOf(session);
		expect(
			record.some((message) => message.kind === 'unseated' && message.subject === surveyor.name),
		).toBe(true);
		expect(await seatNames(session)).toEqual([product.name]);
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

		const name = session.name;
		await session.stop();
		started.pop();
		const { readRoom, resumeRoom } = await import('../src/index.ts');
		const stopped = await readRoom(name, { runtime });
		expect(stopped.participants.map((seat) => seat.name)).toEqual([product.name]);
		const resumed = await resumeRoom(name, {
			agents: [product, surveyor],
			runtime,
			streamFn: scripted(byAgent({})),
		});
		started.push(resumed);
		expect(await seatNames(resumed)).toEqual([product.name]);
	});
});
