/** The `/testing` subpath: the scripted stream, and the stub model it routes on. */

import { byAgent, callTool, later, quiet, speak, spend } from '@ambionframework/ambion/testing';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage, normalizeContext } from '@earendil-works/pi-ai';
import { expect, expectTypeOf, it } from 'vitest';
import { streamModels } from '../src/models.ts';
import { stubModel } from '../src/services.ts';
import { isClosingContext, scriptedStream, scriptOf } from '../src/testing.ts';

it('names the seat in the stub model and needs no cast', async () => {
	const model = await stubModel('anthropic/x', 'product');
	expect(model.name).toBe('product');
	expect(model.id).toBe('anthropic/x');
	expectTypeOf(model.api).toBeString();
});

it('routes on the seat the stub model names, whatever the model id', async () => {
	const seen: string[] = [];
	const stream = scriptedStream(
		byAgent({
			a: (_context, seat, call) => {
				seen.push(`${seat}:${call}`);
				return quiet();
			},
		}),
	);
	const model = await stubModel('anthropic/claude-x', 'a');
	await (await stream(model, normalizeContext({ messages: [] }))).result();
	await (await stream(model, normalizeContext({ messages: [] }))).result();
	expect(seen).toEqual(['a:1', 'a:2']);
});

it('answers an already aborted signal with an aborted message', async () => {
	const controller = new AbortController();
	controller.abort();
	const model = await stubModel('anthropic/x', 'product');
	const result = await (
		await scriptedStream(() => speak('never'))(model, normalizeContext({ messages: [] }), {
			signal: controller.signal,
		})
	).result();
	expect(result.stopReason).toBe('aborted');
});

it('turns a script that throws into an error message', async () => {
	const model = await stubModel('anthropic/x', 'product');
	const result = await (
		await scriptedStream(() => {
			throw new Error('script failed');
		})(model, normalizeContext({ messages: [] }))
	).result();
	expect(result.stopReason).toBe('error');
	expect(result.errorMessage).toContain('script failed');
});

it('turns a reply into one message with one tool call for each call', async () => {
	const model = await stubModel('anthropic/x', 'product');
	const args = { text: 'Yes.', list: [1, 'two', null, { deep: true }] };
	const stream = scriptedStream(() => [{ tool: 'say', args }, ...later('Soon.', 60)]);
	const result = await (await stream(model, normalizeContext({ messages: [] }))).result();
	expect(result.stopReason).toBe('toolUse');
	expect(result.content).toMatchObject([
		{ type: 'toolCall', name: 'say', arguments: args },
		{ type: 'toolCall', name: 'schedule', arguments: { text: 'Soon.', after: 60 } },
	]);
});

it('turns an empty reply into a message that ends the run', async () => {
	const model = await stubModel('anthropic/x', 'product');
	const result = await (
		await scriptedStream(() => quiet())(model, normalizeContext({ messages: [] }))
	).result();
	expect(result.stopReason).toBe('stop');
	expect(result.content).toEqual([{ type: 'text', text: 'nothing to add' }]);
});

it.each([
	['a spend call', spend({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), /cannot spend/],
	['a value that is not JSON', callTool('say', { text: undefined }), /not JSON/],
	['an instance of a class', callTool('say', { at: new Date(0) }), /not JSON/],
] as const)('turns a reply with %s into an error message', async (_name, reply, error) => {
	const model = await stubModel('anthropic/x', 'product');
	const result = await (
		await scriptedStream(() => reply)(model, normalizeContext({ messages: [] }))
	).result();
	expect(result.stopReason).toBe('error');
	expect(result.errorMessage).toMatch(error);
});

it('reads the closing activation from the system prompt', () => {
	expect(isClosingContext({ messages: [], systemPrompt: 'The exchange is over.' })).toBe(true);
	expect(isClosingContext(normalizeContext({ messages: [] }))).toBe(false);
});

it('serves the stream through one provider that holds the model under its provider and id', async () => {
	const model = await stubModel('scripted/product', 'product');
	const seen: string[] = [];
	const models = streamModels(
		model,
		scriptedStream((_context, seat) => {
			seen.push(seat);
			return fauxAssistantMessage('Here.', { stopReason: 'stop' });
		}),
	);
	expect(models.getModel('scripted', 'scripted/product')).toBe(model);
	expect(models.getModel('scripted', 'another')).toBeUndefined();
	const answer = await models.streamSimple(model, normalizeContext({ messages: [] })).result();
	expect(answer.content).toEqual([{ type: 'text', text: 'Here.' }]);
	expect(seen).toEqual(['product']);
});

const fails =
	(reason: unknown): StreamFn =>
	() => {
		throw reason;
	};

it.each([
	[
		'answers later',
		scriptedStream(() => fauxAssistantMessage('Later.', { stopReason: 'stop' })),
		{ content: [{ type: 'text', text: 'Later.' }] },
	],
	[
		'throws an error',
		fails(new Error('no stream')),
		{ stopReason: 'error', errorMessage: 'no stream' },
	],
	['throws anything else', fails('no stream'), { stopReason: 'error', errorMessage: 'no stream' }],
] as const)('ends the provider stream when the stream function %s', async (_name, stream, end) => {
	const model = await stubModel('scripted/product', 'product');
	const models = streamModels(model, async (...args) => stream(...args));
	expect(
		await models.streamSimple(model, normalizeContext({ messages: [] })).result(),
	).toMatchObject(end);
});

it('ends the wait for a steer that never comes', async () => {
	const results = Array.from({ length: 500 }, (_, index) => ({
		role: 'toolResult' as const,
		toolCallId: `look-${index}`,
		toolName: 'wait',
		content: [],
		isError: true,
		timestamp: 0,
	}));
	const answer = await scriptOf({ kind: 'awaitSteer', text: 'Here.' })(
		{ messages: results },
		'product',
		501,
	);
	expect(answer).toEqual(quiet());
});
