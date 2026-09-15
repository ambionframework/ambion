import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { createRuntime, defineAgent, defineHuman, startRoom } from '../src/index.ts';
import { inProcessTransport } from '../src/transport.ts';
import { fakeClock } from './support/clock.ts';
import { closedExchange, deferred, roomName, storedOf } from './support/room.ts';
import { contextText, quiet, scripted, speak, summarise, toolNames } from './support/scripted.ts';
import { faultyJournals, memory } from './support/storage.ts';

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes summaries.',
	instructions: 'Summarise every exchange.',
	model: 'scripted/assistant',
});
const alpha = defineAgent({
	name: 'alpha',
	identity: 'Answers questions.',
	instructions: 'Answer every question.',
	model: 'scripted/alpha',
});
const beta = defineAgent({
	name: 'beta',
	identity: 'Checks answers.',
	instructions: 'Check every question.',
	model: 'scripted/beta',
});
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

describe('exchange completion handles', () => {
	it('keeps a close wait pending when the close append fails, then resolves after retry', async () => {
		const opened = await memory.open();
		const faulty = faultyJournals(opened.storage);
		const clock = fakeClock();
		const room = await startRoom({
			name: roomName('exchange-close-retry'),
			runtime: createRuntime({
				clock,
				storage: faulty.journals,
				transport: inProcessTransport(),
			}),
			streamFn: scripted(() => quiet()),
		});
		try {
			const visit = await room.visit(priya);
			faulty.fail('before', 'close');
			const exchange = await visit.send({ text: 'First?', key: 'close-retry-1' });
			const waiting = exchange.messages();
			let closed = false;
			void waiting.then(
				() => {
					closed = true;
				},
				() => {
					closed = true;
				},
			);
			for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
			expect(closed).toBe(false);
			faulty.fail(false);
			await room.reconcile();
			await expect(waiting).resolves.toEqual(expect.any(Array));
			expect(closedExchange(room, exchange.from)).toMatchObject({ from: exchange.from });
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('resolves an earlier response while a later same-owner exchange is held', async () => {
		const opened = await memory.open();
		const firstSummaryStarted = deferred();
		const firstSummaryRelease = deferred();
		const laterAgentStarted = deferred();
		const laterAgentRelease = deferred();
		const specialists = new Map<string, number>();
		const summarised = new Set<string>();
		const summaryReply = async (context: Context) => {
			if (!toolNames(context).includes('summarise') || summarised.has('first')) return quiet();
			summarised.add('first');
			firstSummaryStarted.resolve();
			await firstSummaryRelease.promise;
			return summarise('First result.');
		};
		const specialistReply = async (context: Context, agent: string) => {
			const text = contextText(context);
			if (!text.includes('First?') && !text.includes('Second?')) return quiet();
			const question = text.includes('Second?') ? 'Second?' : 'First?';
			const key = `${agent}:${question}`;
			const count = specialists.get(key) ?? 0;
			if (count >= 2) return quiet();
			specialists.set(key, count + 1);
			if (agent === beta.name && question === 'Second?' && count === 0) {
				laterAgentStarted.resolve();
				await laterAgentRelease.promise;
			}
			return speak(`${agent} answer ${count + 1}.`);
		};
		const room = await startRoom({
			name: roomName('exchange-response-isolation'),
			runtime: createRuntime({
				clock: fakeClock(),
				storage: opened.storage,
				transport: inProcessTransport(),
			}),
			agents: [alpha, beta],
			assistant,
			streamFn: scripted((context, agent) =>
				agent === assistant.name ? summaryReply(context) : specialistReply(context, agent),
			),
		});
		try {
			const visit = await room.visit(priya);
			const first = await visit.send({ text: 'First?', key: 'response-isolation-1' });
			await first.messages();
			await firstSummaryStarted.promise;
			const response = first.response();
			const second = await visit.send({ text: 'Second?', key: 'response-isolation-2' });
			await laterAgentStarted.promise;
			firstSummaryRelease.resolve();
			await expect(response).resolves.toMatchObject({ text: 'First result.', to: priya.name });
			let secondDone = false;
			void second.response().then(
				() => {
					secondDone = true;
				},
				() => {
					secondDone = true;
				},
			);
			await new Promise((resolve) => setImmediate(resolve));
			expect(secondDone).toBe(false);
			laterAgentRelease.resolve();
			const secondConversation = await second.messages();
			const durableSummary = (await room.messages()).find((message) => message.kind === 'summary');
			expect(secondConversation.every((message) => message.kind !== 'summary')).toBe(true);
			expect(durableSummary?.seq).toBeGreaterThan(second.from);
			expect(durableSummary?.seq).toBeLessThanOrEqual(
				closedExchange(room, second.from)?.through ?? 0,
			);
			await expect(second.response()).resolves.toBeUndefined();
		} finally {
			firstSummaryRelease.resolve();
			laterAgentRelease.resolve();
			await room.stop();
			await opened.dispose();
		}
	});

	it('rejects a pending response after an unclaimed summary exhausts retries', async () => {
		const opened = await memory.open();
		const clock = fakeClock();
		const summaryStarted = deferred();
		const summaryRelease = deferred();
		const answers = new Map<string, number>();
		const room = await startRoom({
			name: roomName('exchange-summary-unclaimed'),
			runtime: createRuntime({
				clock,
				storage: opened.storage,
				transport: inProcessTransport(),
				retry: { attempts: 1, backoff: () => 0 },
			}),
			agents: [alpha, beta],
			assistant,
			streamFn: scripted(async (context, agent) => {
				if (agent === assistant.name) {
					if (!toolNames(context).includes('summarise')) return quiet();
					summaryStarted.resolve();
					await summaryRelease.promise;
					throw new Error('summary failed');
				}
				const text = contextText(context);
				if (!text.includes('No summary?')) return quiet();
				const count = answers.get(agent) ?? 0;
				if (count >= 2) return quiet();
				answers.set(agent, count + 1);
				return speak(`${agent} answer ${count + 1}.`);
			}),
		});
		try {
			const exchange = await (
				await room.visit(priya)
			).send({
				text: 'No summary?',
				key: 'summary-unclaimed-1',
			});
			await summaryStarted.promise;
			const response = exchange.response().then(
				() => ({ resolved: true, error: '' }),
				(error: unknown) => ({ resolved: false, error: String(error) }),
			);
			summaryRelease.resolve();
			for (let i = 0; i < 3; i += 1) {
				await clock.advance(1);
				await room.reconcile();
			}
			const result = await response;
			expect(result).toEqual({ resolved: false, error: expect.stringMatching(/interrupted/i) });
			const entries = await storedOf(opened.journals, room.name);
			expect(entries).toContainEqual(
				expect.objectContaining({
					kind: 'lease',
					body: expect.objectContaining({ phase: 'ended', reason: 'abandoned' }),
				}),
			);
		} finally {
			summaryRelease.resolve();
			await room.stop();
			await opened.dispose();
		}
	});
});
