/** Pi context ranges advance only when Pi gives their exact messages to a provider. */
import { Agent } from '@earendil-works/pi-agent-core';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type UserMessage,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { quiet, scripted } from '../../ambion/test/support/scripted.ts';
import { PiContext } from '../src/context.ts';
import { stubModel } from '../src/services.ts';

const at = Date.parse('2026-01-01T09:00:00.000Z');

const capturedSteers = () => {
	const messages: UserMessage[] = [];
	return { messages, agent: { steer: (message: UserMessage) => messages.push(message) } };
};

describe('PiContext', () => {
	it('acknowledges the initial view only when a real Pi request contains it', async () => {
		const context = new PiContext();
		const initial = context.initial(4, 'The initial room.', at);
		expect(context.readThrough).toBe(0);
		const requests: object[][] = [];
		const provider = scripted(() => quiet());
		const agent = new Agent({
			initialState: { model: await stubModel('scripted/pi-context', 'pi-context') },
			streamFn: (model, request, options) => {
				requests.push(request.messages);
				context.providerRequestStarted(request.messages);
				return provider(model, request, options);
			},
		});
		await agent.prompt(initial);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(initial);
		expect(context.readThrough).toBe(4);
	});

	it('does not acknowledge a steer until Pi sends it in a later request', () => {
		const context = new PiContext();
		context.acknowledgeThrough(4);
		const steers = capturedSteers();
		context.steer(steers.agent, { after: 4, seq: 7, line: 'Steered during request.' }, at);
		context.providerRequestStarted([]);
		expect(context.readThrough).toBe(4);
		context.providerRequestStarted(steers.messages);
		expect(context.readThrough).toBe(7);
	});

	it('keeps a steer queued during a real provider request out of that request', async () => {
		const context = new PiContext();
		const initial = context.initial(4, 'The initial room.', at);
		const requests: object[][] = [];
		let requestStarted = () => {};
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve;
		});
		let finish = () => {};
		const provider = scripted(() => quiet());
		let calls = 0;
		const agent = new Agent({
			initialState: { model: await stubModel('scripted/pi-context', 'pi-context') },
			streamFn: (model, request, options) => {
				calls += 1;
				requests.push(request.messages);
				context.providerRequestStarted(request.messages);
				if (calls > 1) return provider(model, request, options);
				const stream = createAssistantMessageEventStream();
				finish = () => {
					const message = fauxAssistantMessage('quiet', { stopReason: 'stop' });
					stream.push({ type: 'start', partial: message });
					stream.push({ type: 'done', reason: 'stop', message });
				};
				requestStarted();
				return stream;
			},
		});
		const run = agent.prompt(initial);
		await started;
		context.steer(agent, { after: 4, seq: 7, line: 'Steered during request.' }, at);
		expect(context.readThrough).toBe(4);
		finish();
		await run;
		expect(requests).toHaveLength(2);
		expect(
			requests[0]?.some((message) => JSON.stringify(message).includes('Steered during request.')),
		).toBe(false);
		expect(
			requests[1]?.some((message) => JSON.stringify(message).includes('Steered during request.')),
		).toBe(true);
		expect(context.readThrough).toBe(7);
	});

	it('requires contiguous consumed ranges and ignores duplicate or plain text lookalikes', () => {
		const context = new PiContext();
		context.acknowledgeThrough(4);
		const steers = capturedSteers();
		context.steer(steers.agent, { after: 4, seq: 7, line: 'Seven.' }, at);
		context.steer(steers.agent, { after: 7, seq: 11, line: 'Eleven.' }, at);
		const [seven, eleven] = steers.messages;
		if (seven === undefined || eleven === undefined) throw new Error('Expected two steers.');
		context.providerRequestStarted([{ role: 'user', content: '[new] unknown text' }, eleven]);
		expect(context.readThrough).toBe(4);
		context.providerRequestStarted([seven, seven]);
		expect(context.readThrough).toBe(11);
	});

	it('advances expected tool context only for its matching result in a provider request', () => {
		const context = new PiContext();
		context.toolResultExpected('say-1', 8);
		context.providerRequestStarted([{ role: 'toolResult', toolCallId: 'other' }]);
		expect(context.readThrough).toBe(0);
		context.providerRequestStarted([{ role: 'assistant', content: '[new] say-1' }]);
		expect(context.readThrough).toBe(0);
		context.providerRequestStarted([{ role: 'toolResult', toolCallId: 'say-1' }]);
		expect(context.readThrough).toBe(8);
	});

	it('keeps an unconsumed steer separate from an accepted own message and recovers it in a fresh view', () => {
		const context = new PiContext();
		context.acknowledgeThrough(4);
		const steers = capturedSteers();
		context.steer(steers.agent, { after: 4, seq: 7, line: 'Dropped steer.' }, at);
		// A successful own message can only use the record position it already read.
		context.acknowledgeThrough(4);
		expect(context.readThrough).toBe(4);
		// The steer was dropped. The next full view remains the recovery path.
		const fresh = context.initial(7, 'The fresh full room.', at);
		context.providerRequestStarted([fresh]);
		expect(context.readThrough).toBe(7);
	});
});
