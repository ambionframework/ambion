import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { inProcessTransport } from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	type ExchangeHandle,
	pi,
	type Room,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import {
	assistantEnded,
	closedExchange,
	crash,
	deferred,
	messagesOf,
	roomName,
	stateOf,
	storedOf,
	waitForRoom,
} from './support/room.ts';
import {
	byAgent,
	contextText,
	isClosing,
	quiet,
	type Script,
	says,
	scripted,
	speak,
	summarise,
} from './support/scripted.ts';
import { faultyJournals, memory, storages } from './support/storage.ts';

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes summaries.',
	executor: pi({ instructions: 'Summarise every exchange.', model: 'scripted/assistant' }),
});
const alpha = defineAgent({
	name: 'alpha',
	identity: 'Answers questions.',
	executor: pi({ instructions: 'Answer every question.', model: 'scripted/alpha' }),
});
const beta = defineAgent({
	name: 'beta',
	identity: 'Checks answers.',
	executor: pi({ instructions: 'Check every question.', model: 'scripted/beta' }),
});
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

const outcomes = ['published', 'silent', 'failed'] as const;
type Outcome = (typeof outcomes)[number];

const summaryFor =
	(outcome: Outcome): Script =>
	(_context, _agent, call) => {
		if (outcome === 'failed') throw new Error('Summary failed.');
		return outcome === 'published' && call === 1 ? summarise('Recorded result.') : quiet();
	};

async function expectOutcome(exchange: ExchangeHandle, outcome: Outcome): Promise<void> {
	if (outcome === 'failed') {
		await expect(exchange.waitForSummary()).rejects.toThrow(/interrupted/i);
	} else if (outcome === 'published') {
		await expect(exchange.waitForSummary()).resolves.toMatchObject({ text: 'Recorded result.' });
	} else {
		await expect(exchange.waitForSummary()).resolves.toBeUndefined();
	}
}

describe.each(storages)('replayed exchange responses on $name', (storage) => {
	it.each(outcomes)('retains a %s result without scheduling another summary', async (outcome) => {
		const opened = await storage.open();
		const clock = fakeClock();
		const runtime = () =>
			createRuntime({
				clock,
				storage: opened.storage,
				limits: { activation: { attempts: 1, backoff: () => 0 } },
			});
		const room = await startRoom({
			name: roomName('exchange-terminal-replay'),
			runtime: runtime(),
			agents: [alpha, assistant],
			summary: assistant.name,
			seats: { [alpha.name]: 'broadcast', [assistant.name]: 'none' },
			stream: scripted(
				byAgent({ alpha: says(['First fact.', 'Second fact.']), assistant: summaryFor(outcome) }),
			),
		});
		let resumed: Room | undefined;
		try {
			const exchange = await (await room.visit(priya)).send({ text: 'Result?' });
			await waitForRoom(room);
			expect(closedExchange(room, exchange.from)?.summary).toEqual(assistant.name);
			await expectOutcome(exchange, outcome);
			await room.stop();
			let calls = 0;
			resumed = await resumeRoom(room.name, {
				runtime: runtime(),
				agents: [alpha, assistant],
				stream: scripted(() => {
					calls += 1;
					return quiet();
				}),
			});
			const recovered = resumed.exchange(exchange.from);
			if (recovered === undefined) throw new Error('Expected the recorded exchange.');
			await expectOutcome(recovered, outcome);
			await clock.advance(120_000);
			await waitForRoom(resumed);
			expect(stateOf(resumed).owed).toEqual([]);
			expect(calls).toBe(0);
		} finally {
			await resumed?.stop();
			await room.stop();
			await opened.dispose();
		}
	});

	it('keeps a failed response pending across restart until its retry can publish', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const runtime = () =>
			createRuntime({
				clock,
				storage: opened.storage,
				limits: { activation: { attempts: 2, backoff: () => 1_000 } },
			});
		const firstRuntime = runtime();
		const room = await startRoom({
			name: roomName('exchange-pending-replay'),
			runtime: firstRuntime,
			agents: [alpha, assistant],
			summary: assistant.name,
			seats: { [alpha.name]: 'broadcast', [assistant.name]: 'none' },
			stream: scripted(
				byAgent({ alpha: says(['First fact.', 'Second fact.']), assistant: summaryFor('failed') }),
			),
		});
		let resumed: Room | undefined;
		try {
			const failed = assistantEnded(room);
			const exchange = await (await room.visit(priya)).send({ text: 'Result?' });
			await failed;
			crash(firstRuntime, room);
			resumed = await resumeRoom(room.name, {
				runtime: runtime(),
				agents: [alpha, assistant],
				stream: scripted(byAgent({ assistant: summaryFor('published') })),
			});
			const recovered = resumed.exchange(exchange.from);
			if (recovered === undefined) throw new Error('Expected the recorded exchange.');
			let settled = false;
			const response = recovered.waitForSummary().then((message) => {
				settled = true;
				return message;
			});
			await clock.advance(999);
			expect(settled).toBe(false);
			expect(stateOf(resumed).owed).toHaveLength(1);
			await clock.advance(1);
			await expect(response).resolves.toMatchObject({
				text: 'Recorded result.',
				covers: { from: exchange.from, through: closedExchange(resumed, exchange.from)?.through },
			});
			await waitForRoom(resumed);
			expect(stateOf(resumed).owed).toEqual([]);
		} finally {
			await resumed?.stop();
			await room.stop();
			await opened.dispose();
		}
	});
});

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
			stream: scripted(() => quiet()),
		});
		try {
			const visit = await room.visit(priya);
			faulty.fail('before', 'close');
			const exchange = await visit.send({ text: 'First?', key: 'close-retry-1' });
			const waiting = exchange.waitForClose();
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
			if (!isClosing(context) || summarised.has('first')) return quiet();
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
			agents: [alpha, beta, assistant],
			summary: assistant.name,
			seats: { [alpha.name]: 'broadcast', [beta.name]: 'broadcast', [assistant.name]: 'none' },
			stream: scripted((context, agent) =>
				agent === assistant.name ? summaryReply(context) : specialistReply(context, agent),
			),
		});
		try {
			const visit = await room.visit(priya);
			const first = await visit.send({ text: 'First?', key: 'response-isolation-1' });
			await first.waitForClose();
			await firstSummaryStarted.promise;
			const response = first.waitForSummary();
			const second = await visit.send({ text: 'Second?', key: 'response-isolation-2' });
			await laterAgentStarted.promise;
			firstSummaryRelease.resolve();
			await expect(response).resolves.toMatchObject({ text: 'First result.', to: priya.name });
			let secondDone = false;
			void second.waitForSummary().then(
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
			const secondConversation = await second.waitForClose();
			const durableSummary = (await messagesOf(room)).find((message) => message.kind === 'summary');
			expect(secondConversation.every((message) => message.kind !== 'summary')).toBe(true);
			expect(durableSummary?.seq).toBeGreaterThan(second.from);
			expect(durableSummary?.seq).toBeLessThanOrEqual(
				closedExchange(room, second.from)?.through ?? 0,
			);
			await expect(second.waitForSummary()).resolves.toBeUndefined();
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
				limits: { activation: { attempts: 1, backoff: () => 0 } },
			}),
			agents: [alpha, beta, assistant],
			summary: assistant.name,
			seats: { [alpha.name]: 'broadcast', [beta.name]: 'broadcast', [assistant.name]: 'none' },
			stream: scripted(async (context, agent) => {
				if (agent === assistant.name) {
					if (!isClosing(context)) return quiet();
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
			const response = exchange.waitForSummary().then(
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
