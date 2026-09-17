import type { CreateRuntimeOptions, RoomSnapshot } from '@ambionframework/ambion';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { createHumanSimulator } from '../src/human-simulator.ts';

type StreamFn = NonNullable<CreateRuntimeOptions['stream']>;

const humans = [
	{ name: 'priya', identity: 'Owns the request.' },
	{ name: 'cara', identity: 'Requests a revision.' },
] as const;

const observation = {
	name: 'public-room',
	messages: [],
	participants: [],
} as unknown as RoomSnapshot;

describe('model-driven human simulator', () => {
	it('validates person selection, sends public context, and retains raw decision', async () => {
		const raw = JSON.stringify({ kind: 'say', human: 'cara', text: 'Please revise the draft.' });
		let prompt = '';
		const simulator = createHumanSimulator({
			model: 'scripted/human',
			instructions: 'Choose the person who should speak next.',
			streamFn: scriptedStream(raw, (context) => {
				prompt = `${context.systemPrompt ?? ''}\n${context.messages.map((message) => JSON.stringify(message.content)).join('\n')}`;
			}),
		});
		const decision = await simulator.decide({
			humans,
			observation,
			actions: [],
			signal: new AbortController().signal,
		});

		expect(decision).toEqual({
			action: { kind: 'say', human: 'cara', text: 'Please revise the draft.' },
			rawResponse: raw,
		});
		expect(prompt).toContain('public-observation-json');
		expect(prompt).toContain('Requests a revision.');
	});

	it('accepts a finish action without a selected person', async () => {
		const simulator = createHumanSimulator({
			model: 'scripted/human',
			instructions: 'Decide whether the simulation is complete.',
			streamFn: scriptedStream(
				JSON.stringify({ kind: 'finish', reason: 'No decision is needed.' }),
			),
		});

		await expect(
			simulator.decide({ humans, observation, actions: [], signal: new AbortController().signal }),
		).resolves.toMatchObject({ action: { kind: 'finish', reason: 'No decision is needed.' } });
	});

	it('rejects malformed actions and retains the raw response as the error cause', async () => {
		const raw = 'The request is complete; no JSON is needed.';
		const simulator = createHumanSimulator({
			model: 'scripted/human',
			instructions: 'Return JSON.',
			streamFn: scriptedStream(raw),
		});

		await expect(
			simulator.decide({ humans, observation, actions: [], signal: new AbortController().signal }),
		).rejects.toMatchObject({
			message: 'The simulator actor response is not valid JSON.',
			cause: { rawResponse: raw },
		});
	});

	it('rejects a human name outside the declared scene and retains the raw response', async () => {
		const raw = JSON.stringify({ kind: 'say', human: 'unknown', text: 'Not allowed.' });
		const simulator = createHumanSimulator({
			model: 'scripted/human',
			instructions: 'Return JSON.',
			streamFn: scriptedStream(raw),
		});

		await expect(
			simulator.decide({ humans, observation, actions: [], signal: new AbortController().signal }),
		).rejects.toMatchObject({
			message: 'The simulator selected an unregistered human.',
			cause: { rawResponse: raw },
		});
	});

	it('uses a fresh actor room for every decision from one factory', async () => {
		const prompts: string[] = [];
		const simulator = createHumanSimulator({
			model: 'scripted/human',
			instructions: 'Return the first declared human.',
			streamFn: scriptedStream(
				JSON.stringify({ kind: 'say', human: 'priya', text: 'Hello.' }),
				(context) => {
					if (!context.messages.some((message) => message.role === 'toolResult'))
						prompts.push(`${context.systemPrompt ?? ''}\n${JSON.stringify(context.messages)}`);
				},
			),
		});
		const signal = new AbortController().signal;
		await simulator.decide({ humans, observation, actions: [], signal });
		await simulator.decide({
			humans,
			observation: { ...observation, name: 'second' },
			actions: [],
			signal,
		});

		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain('public-room');
		expect(prompts[1]).toContain('second');
		expect(prompts[0]).not.toBe(prompts[1]);
	});

	it('honors cancellation of an active provider call and performs room cleanup', async () => {
		let started!: () => void;
		const providerStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const simulator = createHumanSimulator({
			model: 'scripted/human',
			instructions: 'Return JSON.',
			streamFn: waitingStream(started),
		});
		const controller = new AbortController();
		const pending = simulator.decide({
			humans,
			observation,
			actions: [],
			signal: controller.signal,
		});
		await providerStarted;
		controller.abort(new Error('stop actor'));

		await expect(pending).rejects.toThrow('stop actor');
	});
});

function scriptedStream(
	response: string,
	observe?: (context: Parameters<StreamFn>[1]) => void,
): StreamFn {
	return (_model, context) => {
		observe?.(context);
		const stream = createAssistantMessageEventStream();
		const call = context.messages.some((message) => message.role === 'toolResult') ? 2 : 1;
		const message =
			call === 1
				? fauxAssistantMessage(
						[
							fauxToolCall('say', {
								to: 'human-simulator-controller',
								text: response,
							}),
						],
						{ stopReason: 'toolUse' },
					)
				: fauxAssistantMessage('', { stopReason: 'stop' });
		queueMicrotask(() => {
			stream.push({ type: 'start', partial: message });
			stream.push({
				type: 'done',
				reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
				message,
			});
		});
		return stream;
	};
}

function waitingStream(started: () => void): StreamFn {
	return (_model, _context, options) => {
		const stream = createAssistantMessageEventStream();
		started();
		options?.signal?.addEventListener(
			'abort',
			() => {
				const message = fauxAssistantMessage('', {
					stopReason: 'aborted',
					errorMessage: 'aborted',
				});
				stream.push({ type: 'error', reason: 'aborted', error: message });
			},
			{ once: true },
		);
		return stream;
	};
}
