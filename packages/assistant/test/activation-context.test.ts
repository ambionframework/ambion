import { createRuntime, defineAgent, defineHuman, pi, startRoom } from '@ambionframework/ambion';
import {
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { defineAssistant } from '../src/index.ts';

const request = 'Bring in writer for R-19 only. Draft two sentences. Do not edit any files.';
const goal = 'Resolve customer reports within the static prototype scope.';
const override = 'Application override: use the local response format in every activation.';
const preferences = 'PRIVATE_READER_PREFERENCE: lead with customer impact.';

interface Capture {
	agent: string;
	phase: number;
	closing: boolean;
	system: string;
	input: string;
	tools: string[];
}

/** Capture the real provider boundary; scripted decisions do not evaluate model judgment. */
async function captureActivations(attention: 'reserve' | 'named'): Promise<Capture[]> {
	const captures: Capture[] = [];
	let phase = 0;
	const route = () =>
		fauxToolCall('say', {
			to: 'writer',
			text: 'Handle R-19 only, two sentences, no file edits.',
		});
	const answer = () =>
		fauxToolCall('say', {
			to: 'assistant',
			text: 'R-19 is unsupported email delivery. No files edited.',
		});
	const planned = new Map([
		['assistant:0', attention === 'reserve' ? fauxToolCall('seat', { name: 'writer' }) : route()],
		['assistant:1', route()],
		['writer:0', answer()],
		['writer:1', answer()],
	]);
	const runtime = createRuntime({
		stream: (model, context: Context) => {
			const agent = model.id.endsWith('writer') ? 'writer' : 'assistant';
			const tools = context.tools?.map((tool) => tool.name) ?? [];
			const closing = tools.length === 1 && tools[0] === 'say';
			captures.push({
				agent,
				phase,
				closing,
				tools,
				system: context.systemPrompt ?? '',
				input: JSON.stringify(context.messages),
			});
			const key = `${agent}:${phase}`;
			const call = closing
				? fauxToolCall('say', { text: 'R-19: draft supplied; no files edited.' })
				: planned.get(key);
			planned.delete(key);
			const message = call
				? fauxAssistantMessage([call], { stopReason: 'toolUse' })
				: fauxAssistantMessage('', { stopReason: 'stop' });
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: 'start', partial: message });
				stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
			});
			return stream;
		},
	});
	const room = await startRoom({
		name: `prompt-review-${attention}`,
		goal,
		runtime,
		assistant: defineAssistant({ model: 'scripted/assistant', instructions: override }),
		agents: [
			defineAgent({
				name: 'writer',
				identity: 'Customer writer.',
				executor: pi({
					instructions: 'Draft within the user constraints.',
					model: 'scripted/writer',
				}),
			}),
		],
		seats: attention === 'named' ? { writer: 'named' } : {},
	});
	try {
		const visit = await room.visit(
			defineHuman({ name: 'cara', identity: 'Customer lead.', preferences }),
		);
		await (await visit.send({ text: request })).waitForSummary();
		phase = 1;
		await (await visit.send({ text: request })).waitForSummary();
		return captures;
	} finally {
		await room.stop();
	}
}

it.each(['reserve', 'named'] as const)(
	'preserves activation context for %s handoff and renewed work',
	async (attention) => {
		const captures = await captureActivations(attention);
		const ordinary = captures.filter((capture) => !capture.closing);
		const closing = captures.filter((capture) => capture.closing);
		expect(closing.length).toBeGreaterThanOrEqual(2);
		for (const phase of [0, 1]) {
			const writer = ordinary.find(
				(capture) => capture.phase === phase && capture.agent === 'writer',
			);
			expect(writer?.input).toContain(request);
			const assistant = ordinary.find(
				(capture) => capture.phase === phase && capture.agent === 'assistant',
			);
			expect(assistant?.input).toContain(request);
			expect(assistant?.tools).toEqual(expect.arrayContaining(['say', 'seat', 'unseat']));
		}
		for (const capture of ordinary) {
			expect(capture.system).toContain(goal);
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
		const renewed = ordinary.find(
			(capture) => capture.phase === 1 && capture.agent === 'assistant',
		);
		expect(renewed?.input).toContain('R-19: draft supplied; no files edited.');
		expect(renewed?.input).toContain('An explicit later request to recheck');
		expect(renewed?.system).toContain('summary as a recorded report');
		expect(renewed?.input).toContain('Current exchange begins here');
		expect(renewed?.input.indexOf('Current exchange begins here')).toBeGreaterThan(
			renewed?.input.indexOf('R-19: draft supplied; no files edited.') ?? -1,
		);
	},
);
