/**
 * The loop on the scripted tier: each way it ends, what the person sees,
 * and the simulation it returns. Every room is a real room on the scripted
 * execution, and every person is a `scriptedActor` or a plain function.
 */
import { definePerson, isSaid, type Message } from '@ambionframework/ambion';
import {
	byAgent,
	isSummarizing,
	quiet,
	ScriptedFailure,
	say,
	spend,
} from '@ambionframework/ambion/testing';
import { describe, expect, it } from 'vitest';
import {
	type Actor,
	LIST_ENDED,
	type Move,
	PACKAGE_NAME,
	type Seen,
	scriptedActor,
	simulate,
} from '../src/index.ts';
import { forever, open, priya } from './support.ts';

/** A desk that answers each message once, and spends 10 input tokens doing it. */
const answering = byAgent({
	desk: (step) => {
		const done = step.results.length;
		if (done === 0) return spend({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 });
		return done === 1 ? say('Thursday is dry.') : quiet();
	},
});

const spoken = (messages: readonly Message[]) => messages.filter(isSaid);

describe('simulate', () => {
	it('ends with `stopped` when the list ends, and keeps the stop as the last move', async () => {
		const room = await open(answering, ['desk']);
		const simulation = await simulate(room, {
			person: priya,
			actor: scriptedActor(['Can we pour on Thursday?']),
			messages: 3,
		});
		expect(simulation.ended).toBe('stopped');
		expect(simulation.moves).toEqual([{ text: 'Can we pour on Thursday?' }, { stop: LIST_ENDED }]);
		expect(simulation.exchanges).toHaveLength(1);
		expect(simulation.exchanges[0]?.sent).toBe('Can we pour on Thursday?');
		expect(spoken(simulation.exchanges[0]?.discussion ?? []).map((m) => m.from)).toEqual([
			'priya',
			'desk',
		]);
		expect(simulation.error).toBeUndefined();
	});

	it('ends with `limit` after `messages` messages, one exchange for each, and leaves the room running', async () => {
		const room = await open(answering, ['desk']);
		const simulation = await simulate(room, {
			person: priya,
			actor: scriptedActor(['First?', 'Second?', 'Third?']),
			messages: 2,
		});
		expect(simulation.ended).toBe('limit');
		expect(simulation.moves).toHaveLength(2);
		const views = simulation.exchanges.map((exchange) => exchange.view);
		expect(views.map((view) => view.outcome.kind)).toEqual(['complete', 'complete']);
		expect(new Set(views.map((view) => view.from)).size).toBe(2);
		expect(simulation.room.exchanges.filter((view) => view.status === 'closed')).toHaveLength(2);
		// The room usage is the sum of the closed views.
		expect(simulation.usage.room).toMatchObject({ input: 20 });
		expect(simulation.usage.actor).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		// The events start at the subscription, and the person left at the end.
		expect(simulation.events.filter((event) => event.type === 'exchange_opened')).toHaveLength(2);
		expect(simulation.room.messages.at(-1)).toMatchObject({ kind: 'left', from: 'priya' });
		// The test owns the room: it still takes a question.
		const again = await (await room.visit(priya)).send({ text: 'Friday?' });
		expect(again.opened).toBe(true);
	});

	it('shows the actor each discussion, a question to the person, and each summary', async () => {
		const script = byAgent({
			desk: (step) => {
				if (step.results.length > 0) return quiet();
				const asked = step.view.context.messages.some((m) => isSaid(m) && m.text === 'Thursday.');
				return asked ? say('Thursday is dry.', 'priya') : say('Which day?', 'priya');
			},
			editor: (step) =>
				isSummarizing(step.view) && step.results.length === 0 ? say('Summary.') : quiet(),
		});
		const room = await open(script, ['desk', 'editor'], { summaryWriter: 'editor' });
		const seen: Seen[] = [];
		const actor: Actor = (view) => {
			seen.push(view);
			const question = spoken(view.exchanges[0]?.discussion ?? []).find((m) => m.from === 'desk');
			if (view.exchanges.length === 0) return { text: 'Can we pour?' };
			if (view.exchanges.length === 1)
				return { text: question?.text === 'Which day?' ? 'Thursday.' : '?' };
			return { stop: 'I have my answer.' };
		};
		const simulation = await simulate(room, { person: priya, actor, messages: 3 });
		expect(simulation.ended).toBe('stopped');
		expect(simulation.moves.map((move) => ('text' in move ? move.text : move.stop))).toEqual([
			'Can we pour?',
			'Thursday.',
			'I have my answer.',
		]);
		// A question to the owner answers the owner, so the exchange closes complete.
		expect(simulation.exchanges[0]?.view.outcome.kind).toBe('complete');
		expect(seen[2]?.exchanges.map((exchange) => exchange.summary?.text)).toEqual([
			'Summary.',
			'Summary.',
		]);
		expect(
			seen[2]?.exchanges[1]?.discussion.some((m) => isSaid(m) && m.text === 'Thursday is dry.'),
		).toBe(true);
		// What the actor saw carries no view of the room.
		expect(seen[2]?.exchanges[0]).not.toHaveProperty('view');
		expect(Object.isFrozen(seen[2]?.exchanges)).toBe(true);
	});

	it.each([
		['a seat keeps the exchange open', 'cancelled'],
		['the summary outlasts the deadline', 'complete'],
	] as const)('ends with `timeout` when %s', async (hanging, outcome) => {
		const script = byAgent({
			desk: (step) => {
				if (hanging === 'a seat keeps the exchange open') return forever();
				return step.results.length > 0 ? quiet() : say('Thursday is dry.');
			},
			editor: (step) => (isSummarizing(step.view) ? forever() : quiet()),
		});
		const room = await open(script, ['desk', 'editor'], { summaryWriter: 'editor' });
		const simulation = await simulate(room, {
			person: priya,
			actor: scriptedActor(['Can we pour?', 'And Friday?']),
			messages: 2,
			// Long enough for the desk to speak on a loaded runner before the deadline.
			exchangeMs: 2_000,
		});
		expect(simulation.ended).toBe('timeout');
		expect(simulation.moves).toHaveLength(1);
		const exchange = simulation.exchanges[0];
		expect(exchange?.view.outcome.kind).toBe(outcome);
		expect(exchange?.summary).toBeUndefined();
		if (outcome === 'complete') expect(exchange?.view.summary.kind).toBe('failed');
		expect(simulation.error).toBeUndefined();
	});

	it.each([
		[
			'the cancel rejects',
			() => Promise.reject(new Error('The journal refused the cancel.')),
			/cancel at the deadline failed: The journal refused the cancel/,
		],
		[
			'no close follows the cancel',
			() => Promise.resolve(),
			/did not close 200 ms after the cancel/,
		],
	] as const)('ends with `failed` when %s', async (_case, cancel, error) => {
		const room = await open(byAgent({ desk: () => forever() }), ['desk']);
		// The room itself, with a cancel that cannot end the exchange.
		const stuck = new Proxy(room, {
			get(target, key) {
				if (key === 'cancel') return cancel;
				const value: unknown = Reflect.get(target, key);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const simulation = await simulate(stuck, {
			person: priya,
			actor: scriptedActor(['Can we pour?']),
			messages: 1,
			exchangeMs: 200,
		});
		expect(simulation.ended).toBe('failed');
		expect(simulation.error).toMatch(error);
		expect(simulation.exchanges).toEqual([]);
	});

	it('ends with `failed` when the message joins an exchange that was already open', async () => {
		const room = await open(byAgent({ desk: () => forever() }), ['desk']);
		const sam = definePerson({ name: 'sam', identity: 'Another manager.' });
		await (await room.visit(sam)).send({ text: 'Sam asks first.' });
		const simulation = await simulate(room, {
			person: priya,
			actor: scriptedActor(['Priya asks second.']),
			messages: 1,
		});
		expect(simulation.ended).toBe('failed');
		expect(simulation.error).toMatch(/joined the open exchange/);
		expect(simulation.exchanges).toEqual([]);
	});

	it('ends with `failed` when the room stops while the cancel at the deadline runs', async () => {
		const script = byAgent({
			desk: (step) => (step.results.length > 0 ? quiet() : say('Thursday is dry.')),
			editor: (step) => (isSummarizing(step.view) ? forever() : quiet()),
		});
		const room = await open(script, ['desk', 'editor'], { summaryWriter: 'editor' });
		// The room itself, stopped before its cancel runs: the cancel then rejects.
		const stopping = new Proxy(room, {
			get(target, key) {
				if (key === 'cancel')
					return async () => {
						await target.stop();
						return target.cancel();
					};
				const value: unknown = Reflect.get(target, key);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const simulation = await simulate(stopping, {
			person: priya,
			actor: scriptedActor(['Can we pour?']),
			messages: 1,
			exchangeMs: 2_000,
		});
		expect(simulation.ended).toBe('failed');
		expect(simulation.error).toMatch(/cancel at the deadline failed: .*stopped/);
	});

	it('ends with `failed` when the room refuses a send', async () => {
		const room = await open(answering, ['desk']);
		const simulation = await simulate(room, {
			person: priya,
			actor: scriptedActor([{ text: '   ' }]),
			messages: 1,
		});
		expect(simulation.ended).toBe('failed');
		expect(simulation.error).toMatch(/blank|empty|text/i);
		expect(simulation.exchanges).toEqual([]);
	});

	it('ends with `failed` when the room stops during an exchange', async () => {
		let stop = () => {};
		const room = await open(
			byAgent({
				desk: () => {
					stop();
					return forever();
				},
			}),
			['desk'],
		);
		stop = () => void room.stop();
		const simulation = await simulate(room, {
			person: priya,
			actor: scriptedActor(['Can we pour?']),
			messages: 1,
		});
		expect(simulation.ended).toBe('failed');
		expect(simulation.error).toMatch(/stop/i);
		expect(simulation.exchanges).toEqual([]);
	});

	it('ends with `failed` when a required summary fails', async () => {
		const script = byAgent({
			desk: (step) => (step.results.length > 0 ? quiet() : say('Thursday is dry.')),
			editor: (step) => {
				if (!isSummarizing(step.view)) return quiet();
				throw new ScriptedFailure('permanent', 'The editor cannot write.');
			},
		});
		const room = await open(script, ['desk', 'editor'], { summaryWriter: 'editor' });
		const simulation = await simulate(room, {
			person: priya,
			actor: scriptedActor(['Can we pour?']),
			messages: 1,
		});
		expect(simulation.ended).toBe('failed');
		expect(simulation.error).toMatch(/summary/i);
	});

	it('ends with `failed` when the actor throws, and sums the usage of the moves', async () => {
		const usage = { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 };
		const moves: Move[] = [{ text: 'Can we pour?', usage }];
		const actor: Actor = (seen) => {
			const move = moves[seen.exchanges.length];
			if (move === undefined) throw new Error('The actor timed out.');
			return move;
		};
		const room = await open(answering, ['desk']);
		const simulation = await simulate(room, { person: priya, actor, messages: 3 });
		expect(simulation.ended).toBe('failed');
		expect(simulation.error).toBe('The actor timed out.');
		expect(simulation.usage.actor).toEqual(usage);
	});

	it('returns a detached value', async () => {
		const room = await open(answering, ['desk']);
		const simulation = await simulate(room, {
			person: priya,
			actor: scriptedActor(['Can we pour?']),
			messages: 1,
		});
		expect(structuredClone(simulation)).toEqual(simulation);
	});

	it.each([
		[{ messages: 0 }, /`messages`/],
		[{ messages: 1.5 }, /`messages`/],
		[{ messages: 1, exchangeMs: 0 }, /`exchangeMs`/],
	])('refuses %o before the person arrives', async (bounds, error) => {
		const room = await open(answering, ['desk']);
		await expect(
			simulate(room, { person: priya, actor: scriptedActor([]), ...bounds }),
		).rejects.toThrow(error);
		expect((await room.read()).messages).toEqual([]);
	});

	it('keeps the package name in step with the manifest', async () => {
		const { default: manifest } = await import('../package.json', { with: { type: 'json' } });
		expect(PACKAGE_NAME).toBe(manifest.name);
	});
});
