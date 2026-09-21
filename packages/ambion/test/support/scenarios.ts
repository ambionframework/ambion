/**
 * The scenarios every storage runs. Each one starts a room in the runtime it
 * is given, drives it on a scripted stream, checks the invariants, and stops
 * it. `@ambionframework/workspace` holds the scenario that runs a room on two
 * workspace backends, because the backends live there.
 */
import type { Context } from '@earendil-works/pi-ai';
import { expect } from 'vitest';
import { type PiOptions, pi, piExecution } from '../../../pi/src/index.ts';
import { hostingOf, inProcessTransport } from '../../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	isSummary,
	type Room,
	type Runtime,
	startRoom,
} from '../../src/index.ts';
import { fakeClock } from '../../src/testing.ts';
import { invariants } from './invariants.ts';
import { collect, messagesOf, participantsOf, roomName, waitForRoom } from './room.ts';
import {
	answersLastQuestion,
	byAgent,
	contextText,
	insists,
	isClosing,
	quiet,
	type Script,
	scripted,
	seat,
	speak,
	summarise,
	toolNames,
	toolResultTexts,
} from './scripted.ts';
import type { Storage } from './storage.ts';
import { serializing } from './transport.ts';

export interface ScenarioContext {
	readonly runtime: Runtime;
	/** A room name no other scenario in the process has used. */
	readonly name: string;
}

export interface Scenario {
	readonly name: string;
	run(ctx: ScenarioContext): Promise<void>;
}

export const assistant = defineAgent({
	name: 'assistant',
	identity: 'Composes the room, and writes the one message a person reads.',
	executor: pi({
		instructions: 'Seat who the question needs. Answer what was asked, once.',
		model: 'scripted/assistant',
	}),
});

export const priya = defineHuman({
	name: 'priya',
	identity: 'Project manager.',
	preferences: 'Lead with the decision.',
});
const sam = defineHuman({ name: 'sam', identity: 'Site foreman.' });

export const agent = (name: string, identity: string, extra: Partial<PiOptions> = {}) =>
	defineAgent({
		name,
		identity,
		executor: pi({ instructions: `You are ${name}.`, model: `scripted/${name}`, ...extra }),
	});

const product = agent('product', 'The product.');
const colleague = agent('colleague', 'The second product.');
const surveyor = agent('surveyor', 'Quantity surveyor. Holds the tonnage.');

const holding = (context: Context, tool: string) => toolNames(context).includes(tool);

/** An assistant that seats every name given at an open, and writes once at a close. */
function composes(names: string[], summary: string): Script {
	return (context) => {
		if (holding(context, 'seat')) {
			const next = names.shift();
			return next ? seat(next) : quiet();
		}
		return isClosing(context) ? summarise(summary) : quiet();
	};
}

/** Two answers to every question, then silence until the next. */
const twoAnswersEach: Script = (_context, _name, call) =>
	call % 3 === 0 ? quiet() : speak(`answer ${call}`);

export async function finish(
	session: Room,
	events: ReturnType<typeof collect>,
	runtime: Runtime,
): Promise<void> {
	await invariants(session, events, { journals: hostingOf(runtime).journals });
	await session.stop();
}

export const oneExchange: Scenario = {
	name: 'one exchange closes into one message',
	async run({ runtime, name }) {
		const session = await startRoom({
			name,
			runtime,
			summary: assistant.name,
			seats: { [product.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [product, assistant],
			execution: piExecution({
				stream: scripted(
					byAgent({ product: twoAnswersEach, assistant: composes([], 'The one message.') }),
				),
			}),
		});
		const events = collect(session);
		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		await waitForRoom(session);
		const record = await messagesOf(session);
		expect(record.filter(isSpoken).map((m) => m.from)).toEqual(['priya', 'product', 'product']);
		const summary = record.find(isSummary);
		expect(summary).toMatchObject({ to: 'priya', text: 'The one message.' });
		await finish(session, events, runtime);
	},
};

export const twoPeopleTwoExchanges: Scenario = {
	name: 'two people open two exchanges, and each is written for',
	async run({ runtime, name }) {
		const session = await startRoom({
			name,
			runtime,
			summary: assistant.name,
			seats: {
				[product.name]: 'broadcast',
				[colleague.name]: 'broadcast',
				[assistant.name]: 'none',
			},
			agents: [product, colleague, assistant],
			execution: piExecution({
				stream: scripted(
					byAgent({
						product: answersLastQuestion(['priya', 'sam']),
						colleague: answersLastQuestion(['priya', 'sam']),
						assistant: (context) => {
							const person = /(\w+)'s exchange is over/.exec(contextText(context))?.[1] ?? '';
							if (!isClosing(context) || toolResultTexts(context).includes('delivered')) {
								return quiet();
							}
							return summarise(`for ${person}`);
						},
					}),
				),
			}),
		});
		const events = collect(session);
		const hers = await session.visit(priya);
		const his = await session.visit(sam);
		await hers.send({ text: 'First?' });
		await waitForRoom(session);
		await his.send({ text: 'Second?' });
		await waitForRoom(session);
		await hers.leave();
		const summaries = (await messagesOf(session)).filter(isSummary);
		expect(summaries.map((m) => [m.to, m.text])).toEqual([
			['priya', 'for priya'],
			['sam', 'for sam'],
		]);
		expect((await participantsOf(session)).find((s) => s.name === 'priya')).toMatchObject({
			presence: 'absent',
		});
		await finish(session, events, runtime);
	},
};

export const seatFromReserve: Scenario = {
	name: 'the assistant seats from the reserve, and the newcomer answers',
	async run({ runtime, name }) {
		const session = await startRoom({
			name,
			runtime,
			summary: assistant.name,
			agents: [product, surveyor, assistant],
			seats: { [assistant.name]: 'broadcast', ...{ [product.name]: 'broadcast' } },
			execution: piExecution({
				stream: scripted(
					byAgent({
						assistant: composes(['surveyor'], 'Steel: 11.7 tonnes.'),
						product: (_context, _name, call) =>
							call <= 3 ? speak('The pour is Saturday.') : quiet(),
						surveyor: insists('11.7 tonnes on site.'),
					}),
				),
			}),
		});
		const events = collect(session);
		const visit = await session.visit(priya);
		await visit.send({ text: 'Is there enough steel for the pour?' });
		await waitForRoom(session);
		const record = await messagesOf(session);
		expect(record.find((m) => m.kind === 'seated')).toMatchObject({
			from: 'assistant',
			subject: 'surveyor',
		});
		expect(record.filter(isSpoken).map((m) => m.from)).toContain('surveyor');
		expect(record.find(isSummary)).toBeDefined();
		expect((await participantsOf(session)).map((s) => s.name)).toContain('surveyor');
		await finish(session, events, runtime);
	},
};

export const scenarios: readonly Scenario[] = [oneExchange, twoPeopleTwoExchanges, seatFromReserve];

/**
 * One scenario on one storage, on a clock the test holds and a transport that
 * checks every request and response against the wire. Both matrices run a
 * scenario this way: the core's over `scenarios` above, and
 * `@ambionframework/workspace`'s over the one that needs a backend.
 */
export async function runScenario(
	storage: Storage,
	scenario: Scenario,
	prefix: string,
): Promise<void> {
	const opened = await storage.open();
	// Every request and response between a seat and the room crosses as JSON.
	const transport = serializing(inProcessTransport());
	try {
		const runtime = createRuntime({ storage: opened.storage, clock: fakeClock(), transport });
		await scenario.run({ runtime, name: roomName(prefix) });
		expect(transport.violations).toEqual([]);
	} finally {
		await opened.dispose();
	}
}
