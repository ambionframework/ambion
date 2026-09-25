import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	type AgentDefinition,
	type Attention,
	createRuntime,
	defineHuman,
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
	quiet,
	type Script,
	scripted,
	seat,
	speak,
	toolNames,
} from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';

const product = scriptedAgent('product', 'The product lead.');
const surveyor = scriptedAgent('surveyor', 'Quantity surveyor. Holds the tonnage.');
const architect = scriptedAgent('architect', 'Architect. Holds the drawings.');
const greeter = scriptedAgent('greeter', 'Meets people at the door.');
const writer = scriptedAgent('writer', 'Writes the one message a person reads at the close.');
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

const runtime = createRuntime({ clock: fakeClock() });

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
		execution: piExecution({ sessions: 'memory', stream: scripted(options.script) }),
	});
	return stopAtEnd(session);
}

const kinds = (record: readonly Message[]) => record.map((message) => message.kind);
const presence = (record: readonly Message[]) => record.filter(isPresence);
const activated = (events: RoomNotification[]) =>
	events.filter((event) => event.type === 'activation_start').map((event) => event.agent);
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
				product: (context, _name, call) => {
					contexts.push(contextText(context));
					tools.push(toolNames(context));
					return call === 1 ? seat(surveyor.name) : quiet();
				},
				surveyor: (_context, _name, call) => (call === 1 ? speak('11.7 tonnes on site.') : quiet()),
				greeter: () => quiet(),
			}),
		});
		const events = collect(session);

		await (await session.visit(priya)).send({ text: 'How much steel is on site?' });
		await waitForRoom(session);

		expect(tools[0]).toEqual(['say', 'seat', 'unseat', 'dismiss']);
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
	it('returns an unchanged seating unacknowledged, refuses to unseat the fixed writer, and unseats a colleague', async () => {
		const contexts: string[] = [];
		const session = await open({
			agents: [product, surveyor],
			summary: true,
			script: byAgent({
				product: (context, _name, call) => {
					contexts.push(contextText(context));
					if (call === 1) return callTool('seat', { name: surveyor.name });
					if (call === 2) return callTool('unseat', { name: writer.name });
					return call === 3 ? callTool('unseat', { name: surveyor.name }) : quiet();
				},
				surveyor: () => quiet(),
			}),
		});
		const events = collect(session);

		await (await session.visit(priya)).send({ text: 'Is the team ready?' });
		await waitForRoom(session);

		expect(contexts[1]).toContain('delivered');
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
			execution: piExecution({ sessions: 'memory', stream: scripted(byAgent({})) }),
		});
		expect(await seatNames(stopAtEnd(resumed))).toEqual([product.name]);
	});
});
