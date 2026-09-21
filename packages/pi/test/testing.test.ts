/** The `/testing` subpath: the scripted stream, and the stub model it routes on. */
import { expect, expectTypeOf, it } from 'vitest';
import { stubModel } from '../src/services.ts';
import { byAgent, isClosing, quiet, scripted, speak } from '../src/testing.ts';

it('names the seat in the stub model and needs no cast', async () => {
	const model = await stubModel('anthropic/x', 'product');
	expect(model.name).toBe('product');
	expect(model.id).toBe('anthropic/x');
	expectTypeOf(model.api).toBeString();
});

it('routes on the seat the stub model names, whatever the model id', async () => {
	const seen: string[] = [];
	const stream = scripted(
		byAgent({
			a: (_context, seat, call) => {
				seen.push(`${seat}:${call}`);
				return quiet();
			},
		}),
	);
	const model = await stubModel('anthropic/claude-x', 'a');
	await (await stream(model, { messages: [] })).result();
	await (await stream(model, { messages: [] })).result();
	expect(seen).toEqual(['a:1', 'a:2']);
});

it('answers an already aborted signal with an aborted message', async () => {
	const controller = new AbortController();
	controller.abort();
	const model = await stubModel('anthropic/x', 'product');
	const result = await (
		await scripted(() => speak('never'))(model, { messages: [] }, { signal: controller.signal })
	).result();
	expect(result.stopReason).toBe('aborted');
});

it('turns a script that throws into an error message', async () => {
	const model = await stubModel('anthropic/x', 'product');
	const result = await (
		await scripted(() => {
			throw new Error('script failed');
		})(model, { messages: [] })
	).result();
	expect(result.stopReason).toBe('error');
	expect(result.errorMessage).toContain('script failed');
});

it('reads the closing activation from the system prompt', () => {
	expect(isClosing({ messages: [], systemPrompt: 'The exchange is over.' })).toBe(true);
	expect(isClosing({ messages: [] })).toBe(false);
});
