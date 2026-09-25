/**
 * One agent run outside a room: the call that ends it, the calls before it,
 * the spend, the context each tool receives, and each way the run rejects.
 * Every case runs on the scripted stream.
 */
import { AmbionError, defineTool, type ToolContext } from '@ambionframework/ambion';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { beforeEach, describe, expect, it } from 'vitest';
import { createExecutionServices, type RunAgentRequest, runAgent } from '../src/index.ts';
import { byAgent, callTool, quiet, type Script, scripted } from '../src/testing.ts';

/** What each tool call received, in order. */
const seen: { tool: string; context: ToolContext }[] = [];

const lookup = defineTool({
	name: 'lookup',
	description: 'Look up one fact.',
	parameters: Type.Object({ key: Type.String() }),
	execute: ({ key }, context) => {
		seen.push({ tool: 'lookup', context });
		return `${key}: dry`;
	},
});

const finish = defineTool({
	name: 'finish',
	description: 'End the run with an answer.',
	parameters: Type.Object({ answer: Type.String() }),
	execute: ({ answer }, context) => {
		seen.push({ tool: 'finish', context });
		if (answer === '') throw new Error('An answer needs text.');
		return 'finished';
	},
});

const services = (script: Script) =>
	createExecutionServices({ stream: scripted(script), sessions: 'memory' });

const request = (overrides: Partial<RunAgentRequest> = {}): RunAgentRequest => ({
	model: 'scripted/actor',
	name: 'actor',
	agent: { name: 'priya', identity: 'Site manager.' },
	system: 'Play the person.',
	prompt: 'Ask about Thursday.',
	tools: [lookup, finish],
	ends: ['finish'],
	...overrides,
});

/** A message that spends `input` tokens. */
const spending = (message: AssistantMessage, input: number): AssistantMessage => ({
	...message,
	usage: {
		...message.usage,
		input,
		totalTokens: input,
		cost: { ...message.usage.cost, total: input / 1000 },
	},
});

describe('runAgent', () => {
	beforeEach(() => {
		seen.length = 0;
	});

	it('returns the call that ends the run, the calls before it, and the spend of each request', async () => {
		const script: Script = (_context, _agent, call) => {
			if (call === 1) return spending(callTool('lookup', { key: 'thursday' }), 10);
			if (call === 2) return spending(callTool('finish', { answer: '' }), 20);
			return spending(callTool('finish', { answer: 'Thursday is dry.' }), 30);
		};
		const result = await runAgent(services(script), request());
		expect(result.end).toEqual({ tool: 'finish', args: { answer: 'Thursday is dry.' } });
		// The refused finish is a call before the end.
		expect(result.calls).toEqual([
			{ tool: 'lookup', args: { key: 'thursday' } },
			{ tool: 'finish', args: { answer: '' } },
		]);
		expect(result.usage).toMatchObject({ input: 60, cost: 0.06 });
		// Each tool sees the agent, and no room, activation, or exchange.
		for (const { context } of seen) {
			expect(context.agent).toEqual({ name: 'priya', identity: 'Site manager.' });
			expect(context).not.toHaveProperty('room');
			expect(context).not.toHaveProperty('activation');
			expect(context).not.toHaveProperty('exchange');
			expect(context.callId).toEqual(expect.any(String));
		}
	});

	it('keeps the first end when one message holds two, and sends no other request', async () => {
		// Both calls are in flight at once. The first ends once the second has
		// started, and the second ends after the first.
		let secondStarted = () => {};
		const started = new Promise<void>((resolve) => {
			secondStarted = resolve;
		});
		let firstEnded = () => {};
		const first = new Promise<void>((resolve) => {
			firstEnded = resolve;
		});
		const parallel = defineTool({
			name: 'finish',
			description: 'End the run with an answer.',
			parameters: Type.Object({ answer: Type.String() }),
			executionMode: 'parallel',
			execute: async ({ answer }) => {
				if (answer === 'first') {
					await started;
					firstEnded();
					return 'finished';
				}
				secondStarted();
				await first;
				await new Promise((resolve) => setTimeout(resolve, 0));
				return 'finished';
			},
		});
		let requests = 0;
		const script: Script = () => {
			requests += 1;
			return fauxAssistantMessage(
				[fauxToolCall('finish', { answer: 'first' }), fauxToolCall('finish', { answer: 'second' })],
				{ stopReason: 'toolUse' },
			);
		};
		const result = await runAgent(services(script), request({ tools: [lookup, parallel] }));
		expect(result.end.args).toEqual({ answer: 'first' });
		expect(requests).toBe(1);
	});

	it('ends after a sequential batch that holds another call before the end', async () => {
		let requests = 0;
		const script: Script = () => {
			requests += 1;
			if (requests > 1) return quiet();
			return fauxAssistantMessage(
				[fauxToolCall('lookup', { key: 'thursday' }), fauxToolCall('finish', { answer: 'dry' })],
				{ stopReason: 'toolUse' },
			);
		};
		const result = await runAgent(services(script), request());
		expect(result.end).toEqual({ tool: 'finish', args: { answer: 'dry' } });
		expect(result.calls).toEqual([{ tool: 'lookup', args: { key: 'thursday' } }]);
		expect(requests).toBe(2);
	});

	it('routes each run on its name, and shows the model the system prompt, the guidance, and the thinking level', async () => {
		const systems: string[] = [];
		const script = byAgent({
			actor: (context) => {
				systems.push(context.systemPrompt ?? '');
				return callTool('finish', { answer: 'from the actor' });
			},
			judge: () => callTool('finish', { answer: 'from the judge' }),
		});
		const reasoning: unknown[] = [];
		const base = scripted(script);
		const shared = createExecutionServices({
			stream: (model, context, options) => {
				reasoning.push(options?.reasoning);
				return base(model, context, options);
			},
			sessions: 'memory',
		});
		const bundles = [{ tools: [lookup], guidance: 'Look a fact up before you answer.' }];
		const actor = await runAgent(shared, request({ tools: [finish], bundles, thinking: 'medium' }));
		const judge = await runAgent(shared, request({ name: 'judge' }));
		expect(actor.end.args).toEqual({ answer: 'from the actor' });
		expect(judge.end.args).toEqual({ answer: 'from the judge' });
		expect(systems).toEqual(['Play the person.\n\nLook a fact up before you answer.']);
		expect(reasoning).toEqual(['medium', undefined]);
	});

	it('rejects when the signal aborts the run', async () => {
		const controller = new AbortController();
		const script: Script = () => {
			controller.abort(new Error('The move passed its timeout.'));
			return new Promise<AssistantMessage>(() => {});
		};
		await expect(
			runAgent(services(script), request({ signal: controller.signal })),
		).rejects.toThrow('The move passed its timeout.');
	});

	it('rejects a signal that aborts while the run opens, and sends no request', async () => {
		let requests = 0;
		const script: Script = () => {
			requests += 1;
			return callTool('finish', { answer: 'dry' });
		};
		const controller = new AbortController();
		const base = services(script);
		// The abort lands between the first check of the signal and the prompt.
		const opening = {
			...base,
			sessions: {
				open: base.sessions.open,
				create: (...args: Parameters<typeof base.sessions.create>) => {
					controller.abort(new Error('The move passed its timeout.'));
					return base.sessions.create(...args);
				},
			},
		};
		await expect(runAgent(opening, request({ signal: controller.signal }))).rejects.toThrow(
			'The move passed its timeout.',
		);
		expect(requests).toBe(0);
	});

	// The lane ignores an abort that lands before it admits the prompt. The
	// abort lands at each session write in turn, the admission among them.
	it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
		'rejects a signal that aborts at session write %i',
		async (write) => {
			const controller = new AbortController();
			const base = services(() => callTool('finish', { answer: 'dry' }));
			let writes = 0;
			const counting: typeof base.sessions = {
				open: base.sessions.open,
				create: async (...args) => {
					const session = await base.sessions.create(...args);
					return new Proxy(session, {
						get(target, key) {
							const value: unknown = Reflect.get(target, key);
							if (key !== 'mutate' || typeof value !== 'function') return value;
							return (...call: unknown[]) => {
								writes += 1;
								if (writes === write) controller.abort(new Error('The move passed its timeout.'));
								return value.apply(target, call);
							};
						},
					});
				},
			};
			await expect(
				runAgent({ ...base, sessions: counting }, request({ signal: controller.signal })),
			).rejects.toThrow('The move passed its timeout.');
		},
	);

	it.each([
		[
			'reaches the output limit',
			// The output reaches the limit of the stub model, so the harness does not compact and retry.
			() => {
				const cut = fauxAssistantMessage('Thursday looks', { stopReason: 'length' });
				return { ...cut, usage: { ...cut.usage, output: 64_000, totalTokens: 64_000 } };
			},
			/reached the output limit with no call to 'finish'/,
		],
		['stops with no call to a tool in ends', () => quiet(), /stopped with no call to 'finish'/],
		[
			'fails on the provider',
			() => fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'overloaded' }),
			/overloaded/,
		],
	] as const)('rejects when the agent %s', async (_case, answer, error) => {
		await expect(runAgent(services(answer), request())).rejects.toThrow(error);
	});

	it.each([
		['a tool in ends that the run does not hold', request({ ends: ['send'] }), /'send'/],
		['no tool in ends', request({ ends: [] }), /at least one tool/],
		[
			'a bundle tool with the name of a tool',
			request({ bundles: [{ tools: [finish] }] }),
			/duplicate tools named 'finish'/,
		],
		[
			'a thinking level that Pi does not name',
			request({ thinking: 'huge' as RunAgentRequest['thinking'] }),
			/Thinking must be one of/,
		],
	] as const)('refuses %s before any request', async (_case, bad, error) => {
		let requests = 0;
		const script: Script = () => {
			requests += 1;
			return quiet();
		};
		await expect(runAgent(services(script), bad)).rejects.toThrow(error);
		expect(requests).toBe(0);
	});

	it('refuses a tool with a name the room keeps', async () => {
		const say = defineTool({
			name: 'say',
			description: 'Speak.',
			parameters: Type.Object({}),
			execute: () => 'said',
		});
		const run = runAgent(
			services(() => quiet()),
			request({ tools: [say, finish] }),
		);
		await expect(run).rejects.toThrow(AmbionError);
		await expect(run).rejects.toThrow("brings a tool named 'say'");
	});
});
