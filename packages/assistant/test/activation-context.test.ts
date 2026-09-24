/**
 * What the assistant and a specialist see at the provider boundary. Scripted
 * models make the decisions, so these tests check the context the room builds
 * and do not evaluate model judgment.
 */
import { defineAgent, defineHuman, type Room, startRoom } from '@ambionframework/ambion';
import { pi, piExecution } from '@ambionframework/pi';
import { quiet, scripted, seat, speak, toolNames } from '@ambionframework/pi/testing';
import type { Context } from '@earendil-works/pi-ai';
import { expect, it, onTestFinished } from 'vitest';
import { defineAssistant } from '../src/index.ts';

/**
 * Stop the room when the test ends. The declaration build reads the test
 * files, so a test here imports no test file of another package.
 */
function stopAtEnd(room: Room): Room {
	onTestFinished(() => room.stop());
	return room;
}

const request = 'Bring in writer for R-19 only. Draft two sentences. Do not edit any files.';
const goal = 'Resolve customer reports within the static prototype scope.';
const override = 'Application override: use the local response format in every activation.';
const preferences = 'PRIVATE_READER_PREFERENCE: lead with customer impact.';
const summary = 'R-19: draft supplied; no files edited.';

const agent = (name: string, identity: string, instructions: string) =>
	defineAgent({ name, identity, executor: pi({ instructions, model: `scripted/${name}` }) });

const isClosing = (context: Context) => {
	const tools = toolNames(context);
	return tools.length === 1 && tools[0] === 'say';
};

interface Capture {
	agent: string;
	phase: number;
	closing: boolean;
	system: string;
	input: string;
	tools: string[];
}

/** Run two exchanges with the same request, and capture every provider request. */
async function captureActivations(attention: 'reserve' | 'named'): Promise<Capture[]> {
	const captures: Capture[] = [];
	let phase = 0;
	const route = () => speak('Handle R-19 only, two sentences, no file edits.', 'writer');
	const answer = () => speak('R-19 is unsupported email delivery. No files edited.', 'assistant');
	const planned = new Map([
		['assistant:0', attention === 'reserve' ? seat('writer') : route()],
		['assistant:1', route()],
		['writer:0', answer()],
		['writer:1', answer()],
	]);
	const stream = scripted((context, name) => {
		const closing = isClosing(context);
		captures.push({
			agent: name,
			phase,
			closing,
			tools: toolNames(context),
			system: context.systemPrompt ?? '',
			input: JSON.stringify(context.messages),
		});
		if (closing) return speak(summary);
		const key = `${name}:${phase}`;
		const message = planned.get(key);
		planned.delete(key);
		return message ?? quiet('');
	});
	const room = stopAtEnd(
		await startRoom({
			name: `prompt-review-${attention}`,
			goal,
			execution: piExecution({ sessions: 'memory', stream }),
			assistant: defineAssistant({ model: 'scripted/assistant', instructions: override }),
			agents: [agent('writer', 'Customer writer.', 'Draft within the user constraints.')],
			seats: attention === 'named' ? { writer: 'named' } : {},
		}),
	);
	const visit = await room.visit(
		defineHuman({ name: 'cara', identity: 'Customer lead.', preferences }),
	);
	await (await visit.send({ text: request })).waitForSummary();
	phase = 1;
	await (await visit.send({ text: request })).waitForSummary();
	return captures;
}

it.each(['reserve', 'named'] as const)(
	'preserves activation context for %s handoff and renewed work',
	async (attention) => {
		const captures = await captureActivations(attention);
		const ordinary = captures.filter((capture) => !capture.closing);
		const closing = captures.filter((capture) => capture.closing);
		const find = (phase: number, name: string) =>
			ordinary.find((capture) => capture.phase === phase && capture.agent === name);
		expect(closing.length).toBeGreaterThanOrEqual(2);
		for (const phase of [0, 1]) {
			expect(find(phase, 'writer')?.input).toContain(request);
			expect(find(phase, 'assistant')?.input).toContain(request);
			expect(find(phase, 'assistant')?.tools).toEqual(
				expect.arrayContaining(['say', 'seat', 'unseat']),
			);
		}
		for (const capture of ordinary) {
			expect(capture.input).toContain(goal);
			expect(capture.system + capture.input).not.toContain(preferences);
		}
		for (const capture of captures.filter((entry) => entry.agent === 'assistant')) {
			expect(capture.system).toContain(override);
			expect(capture.system).toContain('Application instructions take precedence');
			expect(capture.system.includes('This is an ordinary activation.')).toBe(!capture.closing);
		}
		for (const capture of closing) {
			expect(capture.tools).toEqual(['say']);
			expect(capture.system).toContain(preferences);
			expect(capture.input).toContain(request);
		}
		const renewed = find(1, 'assistant')?.input ?? '';
		expect(renewed).toContain(summary);
		expect(renewed).toContain('An explicit later request to recheck');
		expect(renewed).toContain('summary as a recorded report');
		expect(renewed.indexOf('Current exchange begins here')).toBeGreaterThan(
			renewed.indexOf(summary),
		);
	},
);

/** The text of the last message in a provider request. */
function lastText(context: Context): string {
	const content = context.messages.at(-1)?.content;
	if (typeof content === 'string') return content;
	return (content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run one exchange. The assistant routes the question and ends. Only then
 * does the specialist speak, so the room steers the result into the
 * assistant. Return the system prompt and the last message of the request
 * that follows the steer.
 */
async function requestAfterSteer(): Promise<{ system: string; steered: string }> {
	let room: Room | undefined;
	let specialistAnswered = false;
	let captured: { system: string; steered: string } | undefined;
	const specialistSpoke = async () => {
		const snapshot = await room?.read({ messages: { since: 0 } });
		return snapshot?.messages.some((m) => m.kind === 'said' && m.from === 'inventory') ?? false;
	};
	const inventory = () => {
		if (specialistAnswered) return quiet('');
		specialistAnswered = true;
		return speak('There are 8 units in stock.', 'assistant');
	};
	const assistant = async (context: Context) => {
		if (isClosing(context)) return speak('8 units.');
		const tail = context.messages.at(-1);
		if (tail?.role === 'user' && lastText(context).startsWith('[')) {
			captured = { system: context.systemPrompt ?? '', steered: lastText(context) };
			return quiet('');
		}
		if (tail?.role !== 'toolResult') return speak('Check the stock of SKU A.', 'inventory');
		for (let wait = 0; wait < 200 && !(await specialistSpoke()); wait += 1) await sleep(10);
		await sleep(50);
		return quiet('');
	};
	const stream = scripted((context, name) =>
		name === 'inventory' ? inventory() : assistant(context),
	);
	room = stopAtEnd(
		await startRoom({
			name: 'steer-marker',
			assistant: defineAssistant({ model: 'scripted/assistant' }),
			agents: [agent('inventory', 'Checks stock.', 'Report the stock once.')],
			seats: { inventory: 'named' },
			execution: piExecution({ sessions: 'memory', stream }),
		}),
	);
	const exchange = await (
		await room.visit(defineHuman({ name: 'priya', identity: 'Owns the request.' }))
	).send({ text: 'How many units of SKU A can we dispatch?' });
	await exchange.waitForSummary();
	if (!captured) throw new Error('The assistant never received the steered result.');
	return captured;
}

it('names the marker that the room puts on a specialist result steered into the assistant', async () => {
	const { system, steered } = await requestAfterSteer();
	const marker = /^\[[^\]]+\]/.exec(steered)?.[0];

	expect(steered).toContain('[inventory → assistant] There are 8 units in stock.');
	expect(marker).toBeDefined();
	// The guidance and the marker change together. A marker of [steer] raised the rate of
	// relayed results from 5 in 30 to 18 in 30 in a live trial. Measure before a rename.
	expect(system).toContain(`starts with \`${marker}\``);
});
