/**
 * One Pi agent serves every pass of an activation. The first pass hands the
 * model the whole view. A later pass hands it the delta: the messages that
 * landed beyond `readThrough`. The transcript and the audit stay whole.
 */
import type { Message } from '@ambionframework/ambion';
import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { tick } from '../../ambion/test/support/room.ts';
import { contextText, quiet, scripted } from '../../ambion/test/support/scripted.ts';
import { playSeat, worker } from './support/runner.ts';

const said = (seq: number, text: string): Message => ({
	kind: 'said',
	seq,
	at: '2026-01-01T09:00:00.000Z',
	from: 'andrei',
	text,
});

/**
 * Run one activation. Each successive view holds the next of `records`, and
 * each renewal reports the next of `positions`. The last of each repeats.
 */
async function play(records: readonly (readonly Message[])[], positions: readonly number[]) {
	const seen: Context[] = [];
	const nth = <T>(items: readonly T[], index: number) => items[Math.min(index, items.length - 1)];
	let views = 0;
	let renewals = 0;
	const { room, actor, services } = playSeat({
		name: 'passes',
		stream: scripted((context) => {
			seen.push({ ...context, messages: [...context.messages] });
			return quiet();
		}),
		view: async (id) => {
			views += 1;
			return {
				view: {
					spec: { id, seat: worker.name, attempt: 1, purpose: { kind: 'respond', message: 1 } },
					through: nth(positions, views - 1) ?? 1,
					context: {
						name: 'passes',
						now: 0,
						participants: [],
						messages: [...(nth(records, views - 1) ?? [])],
						reserve: [],
					},
				},
			};
		},
		lease: (request) => {
			if (request.operation !== 'renew') return undefined;
			renewals += 1;
			return { ok: { expiresAt: Number.MAX_SAFE_INTEGER, lastSeq: nth(positions, renewals) ?? 1 } };
		},
	});
	await actor.run('message:1:worker:1');
	await tick();
	return { renewals: room.of('renew'), seen, services };
}

const first = [said(1, 'Can we ship?')];

const texts = (context: Context) =>
	context.messages.map((message) => contextText({ ...context, messages: [message] }));

describe('the Pi executor across the passes of one activation', () => {
	it('keeps one agent, prompts a later pass with the delta alone, and advances readThrough', async () => {
		const { renewals, seen } = await play([first, [...first, said(2, 'And the pump?')]], [1, 2, 2]);

		expect(seen).toHaveLength(2);
		const [before, after] = seen;
		expect(before?.messages).toHaveLength(1);
		// The second request carries the first pass whole, then only what is new:
		// two prompts and one answer, and nothing from the first pass repeats.
		expect(after?.messages).toHaveLength(3);
		const prompts = texts(after as Context).filter((text) => text.length > 0);
		expect(prompts[0]).toContain("The record of 'passes' so far:");
		const last = prompts.at(-1) ?? '';
		expect(last).toContain('[new]');
		expect(last).toContain('And the pump?');
		expect(last).not.toContain('The record of');
		expect(last).not.toContain('Can we ship?');

		// The renewals name what the seat had read: the first pass, then the delta.
		expect(renewals.at(-1)).toMatchObject({ readThrough: 2 });
	});

	it('starts no run when the record moved and no message came with it', async () => {
		// The room position moves to 2 with no message: an entry a model does not read.
		const { renewals, seen } = await play([first], [1, 2, 2]);
		expect(seen).toHaveLength(1);
		expect(renewals.at(-1)).toMatchObject({ readThrough: 2 });
	});
});
