import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { openHost, respondingStream } from './hosting.ts';

const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage([fauxToolCall(name, args as Record<string, string>)], {
		stopReason: 'toolUse',
	});
const quiet = () => fauxAssistantMessage('quiet', { stopReason: 'stop' });

/** The assistant pins the kit file with a once action in its first activation, and stays quiet after. */
function asking() {
	const steps = [
		call('show', {
			name: 'keep-kit',
			kind: 'markdown',
			source: { type: 'file', path: '/shared/kit.md' },
			title: 'The kit',
			actions: [{ id: 'keep', label: 'Keep the kit', once: true }],
		}),
		quiet(),
	];
	return respondingStream((agent, _request, closing) => {
		if (closing) return call('say', { text: 'Summary: asked.' });
		return agent === 'assistant' ? (steps.shift() ?? quiet()) : quiet();
	});
}

describe('Workbench widget acts', () => {
	it('sends the press of a person as a message and draws the pin as answered', async () => {
		const workbench = await openHost({ stream: asking() });
		await workbench.visit('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'k1', 'Ask me whether to keep the kit.');
		await vi.waitFor(
			async () => expect((await workbench.pins('bringup')).pins[0]?.actions).toHaveLength(1),
			{ timeout: 10_000, interval: 20 },
		);
		const [pin] = (await workbench.pins('bringup')).pins;
		expect(pin?.name).toBe('keep-kit');
		expect(pin?.answered).toBeUndefined();

		const press = {
			room: 'bringup',
			widget: 'keep-kit',
			revision: pin?.revision ?? '',
			action: 'keep',
			press: 'press-1',
		};
		const sent = await workbench.act('mira', press);
		expect(sent.kind).toBe('sent');
		const seq = sent.kind === 'sent' ? sent.seq : 0;
		const message = (await workbench.read('bringup', 0)).messages.find((one) => one.seq === seq);
		expect(message).toMatchObject({
			from: 'mira',
			key: `act:${press.revision}`,
			text: expect.stringContaining('Keep the kit [keep]'),
		});

		// The answer reaches the pin with no new read of the room by the caller.
		await vi.waitFor(
			async () =>
				expect((await workbench.pins('bringup')).pins[0]?.answered).toEqual({ seq, by: 'mira' }),
			{ timeout: 10_000, interval: 20 },
		);
		// The same press again lands once. Another person gets the answer.
		expect(await workbench.act('mira', press)).toEqual({ kind: 'sent', seq });
		expect(await workbench.act('theo', { ...press, press: 'press-2' })).toEqual({
			kind: 'answered',
			seq,
		});
	}, 30_000);
});
