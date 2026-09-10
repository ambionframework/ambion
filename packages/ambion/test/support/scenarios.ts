/**
 * The scenarios every storage and every backend runs. Each one starts a
 * room in the runtime it is given, drives it on a scripted stream, checks
 * the invariants, and stops it.
 */
import type { Context } from '@earendil-works/pi-ai';
import { expect } from 'vitest';
import {
	defineAgent,
	defineHuman,
	defineWorkspace,
	destroyWorkspace,
	isSpoken,
	isSummary,
	type Runtime,
	type Session,
	startSession,
	stopSession,
	visitSession,
} from '../../src/index.ts';
import { invariants } from './invariants.ts';
import { collect, deferred } from './room.ts';
import {
	byAgent,
	callTool,
	contextText,
	insists,
	quiet,
	type Script,
	scripted,
	seat,
	speak,
	summarise,
	toolNames,
} from './scripted.ts';
import { backends } from './storage.ts';

export interface ScenarioContext {
	readonly runtime: Runtime;
	/** A room name no other scenario in the process has used. */
	readonly name: string;
}

export interface Scenario {
	readonly name: string;
	run(ctx: ScenarioContext): Promise<void>;
}

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Composes the room, and writes the one message a person reads.',
	instructions: 'Seat who the question needs. Answer what was asked, once.',
	model: 'scripted/assistant',
});

const priya = defineHuman({
	name: 'priya',
	identity: 'Project manager.',
	preferences: 'Lead with the decision.',
});
const sam = defineHuman({ name: 'sam', identity: 'Site foreman.' });

const agent = (
	name: string,
	identity: string,
	extra: Partial<Parameters<typeof defineAgent>[0]> = {},
) =>
	defineAgent({
		name,
		identity,
		instructions: `You are ${name}.`,
		model: `scripted/${name}`,
		...extra,
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
		return holding(context, 'summarise') ? summarise(summary) : quiet();
	};
}

/** Every tool result the model has been shown so far, oldest first. */
function toolResults(context: Context): string[] {
	return context.messages.flatMap((message) =>
		message.role === 'toolResult'
			? [message.content.map((c) => (c.type === 'text' ? c.text : '')).join('')]
			: [],
	);
}

/** Two answers to every question, then silence until the next. */
const twoAnswersEach: Script = (_context, _name, call) =>
	call % 3 === 0 ? quiet() : speak(`answer ${call}`);

/**
 * A seat that answers the last question on the record once. A refused say
 * speaks again; a delivered one ends the pass; a record that already holds
 * the answer stays quiet.
 */
const answersOnce: Script = (context, name) => {
	const text = contextText(context);
	const question = [...text.matchAll(/^\[(?:priya|sam)\] (.+?)(?: {2}\(.*\))?$/gm)].at(-1)?.[1];
	if (question === undefined) return quiet();
	const answer = `${name} on ${question}`;
	if (text.includes(`[${name}] ${answer}`) || toolResults(context).includes('delivered')) {
		return quiet();
	}
	return speak(answer);
};

async function finish(
	session: Session,
	events: ReturnType<typeof collect>,
	runtime: Runtime,
): Promise<void> {
	await invariants(session, events, { sessions: runtime.sessions });
	await stopSession(session);
}

export const oneExchange: Scenario = {
	name: 'one exchange closes into one message',
	async run({ runtime, name }) {
		const session = startSession({
			name,
			runtime,
			assistant,
			agents: [product],
			streamFn: scripted(
				byAgent({ product: twoAnswersEach, assistant: composes([], 'The one message.') }),
			),
		});
		const events = collect(session);
		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await session.quiet();
		const record = await session.messages();
		expect(record.filter(isSpoken).map((m) => m.from)).toEqual(['priya', 'product', 'product']);
		const summary = record.find(isSummary);
		expect(summary).toMatchObject({ to: 'priya', text: 'The one message.' });
		await finish(session, events, runtime);
	},
};

export const twoPeopleTwoExchanges: Scenario = {
	name: 'two people open two exchanges, and each is written for',
	async run({ runtime, name }) {
		const session = startSession({
			name,
			runtime,
			assistant,
			agents: [product, colleague],
			streamFn: scripted(
				byAgent({
					product: answersOnce,
					colleague: answersOnce,
					assistant: (context) => {
						const person = /(\w+)'s exchange is over/.exec(contextText(context))?.[1] ?? '';
						if (!holding(context, 'summarise') || toolResults(context).includes('delivered')) {
							return quiet();
						}
						return summarise(`for ${person}`);
					},
				}),
			),
		});
		const events = collect(session);
		const hers = await visitSession(session, priya);
		const his = await visitSession(session, sam);
		await hers.deliver({ text: 'First?' });
		await session.quiet();
		await his.deliver({ text: 'Second?' });
		await session.quiet();
		await hers.leave();
		const summaries = (await session.messages()).filter(isSummary);
		expect(summaries.map((m) => [m.to, m.text])).toEqual([
			['priya', 'for priya'],
			['sam', 'for sam'],
		]);
		expect(session.seats().find((s) => s.name === 'priya')).toMatchObject({ presence: 'absent' });
		await finish(session, events, runtime);
	},
};

export const seatFromReserve: Scenario = {
	name: 'the assistant seats from the reserve, and the newcomer answers',
	async run({ runtime, name }) {
		const session = startSession({
			name,
			runtime,
			assistant,
			agents: [product],
			available: [surveyor],
			streamFn: scripted(
				byAgent({
					assistant: composes(['surveyor'], 'Steel: 11.7 tonnes.'),
					product: (_context, _name, call) =>
						call <= 3 ? speak('The pour is Saturday.') : quiet(),
					surveyor: insists('11.7 tonnes on site.'),
				}),
			),
		});
		const events = collect(session);
		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Is there enough steel for the pour?' });
		await session.quiet();
		const record = await session.messages();
		expect(record.find((m) => m.kind === 'seated')).toMatchObject({
			from: 'surveyor',
			by: 'assistant',
		});
		expect(record.filter(isSpoken).map((m) => m.from)).toContain('surveyor');
		expect(record.find(isSummary)).toBeDefined();
		expect(session.seats().map((s) => s.name)).toContain('surveyor');
		await finish(session, events, runtime);
	},
};

export const twoWorkspaces: Scenario = {
	name: 'two workspaces on two backends, and one destroyed mid-activation',
	async run({ runtime, name }) {
		const [memoryBackend, directoryBackend] = await Promise.all(backends.map((b) => b.open()));
		if (!memoryBackend || !directoryBackend) throw new Error('two backends are expected');
		const memoryDrive = defineWorkspace({
			name: `${name}-memory`,
			backend: memoryBackend.backend,
			runtime,
		});
		const directoryDrive = defineWorkspace({
			name: `${name}-directory`,
			backend: directoryBackend.backend,
			runtime,
		});
		const alpha = agent('alpha', 'Works in memory.', { workspace: memoryDrive });
		const beta = agent('beta', 'Works on disk.', { workspace: directoryDrive });
		const gamma = agent('gamma', 'Has no workspace.');
		const destroyed = deferred();
		const alphaResults: string[] = [];
		const betaResults: string[] = [];
		const session = startSession({
			name,
			runtime,
			assistant,
			agents: [alpha, beta, gamma],
			streamFn: scripted(
				byAgent({
					alpha: async (context, _name, call) => {
						alphaResults.push(...toolResults(context).slice(alphaResults.length));
						if (call === 1)
							return callTool('write', { path: '/home/alpha/note.txt', content: 'one' });
						if (call === 2) {
							await destroyed.promise;
							return callTool('read', { path: '/home/alpha/note.txt' });
						}
						return call === 3 ? speak('alpha done') : quiet();
					},
					beta: (context, _name, call) => {
						betaResults.push(...toolResults(context).slice(betaResults.length));
						if (call === 1) return callTool('bash', { command: 'echo two > /home/beta/note.txt' });
						if (call === 2) return callTool('read', { path: '/home/beta/note.txt' });
						return call === 3 ? speak('beta done') : quiet();
					},
					gamma: (context) => {
						expect(toolNames(context)).toEqual(['say']);
						return quiet();
					},
				}),
			),
		});
		const events = collect(session);
		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'go' });
		// alpha has written; destroy its workspace while its activation runs
		await new Promise<void>((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type !== 'tool_execution_end' || event.agent !== 'alpha') return;
				off();
				resolve();
			});
		});
		await destroyWorkspace(memoryDrive);
		destroyed.resolve();
		await session.quiet();

		expect(alphaResults.some((r) => r.includes('destroyed'))).toBe(true);
		expect(betaResults.some((r) => r.includes('two'))).toBe(true);
		const said = (await session.messages()).filter(isSpoken).map((m) => m.text);
		expect(said).toContain('alpha done');
		expect(said).toContain('beta done');
		await finish(session, events, runtime);
		await destroyWorkspace(directoryDrive);
		await Promise.all([memoryBackend.dispose(), directoryBackend.dispose()]);
	},
};

export const scenarios: readonly Scenario[] = [
	oneExchange,
	twoPeopleTwoExchanges,
	seatFromReserve,
	twoWorkspaces,
];
