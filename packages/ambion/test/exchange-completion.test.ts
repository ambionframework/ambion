import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	createRuntime,
	defineHuman,
	type ExchangeHandle,
	type Room,
	type Runtime,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { settledFlag, turn } from './support/core-exchange.ts';
import { owedOf } from './support/fold.ts';
import {
	assistantEnded,
	closedExchange,
	crash,
	deferred,
	messagesOf,
	roomName,
	scriptedAgent,
	stateOf,
	storedOf,
	waitForRoom,
} from './support/room.ts';
import {
	byAgent,
	contextText,
	isClosingContext,
	type PiScript,
	quiet,
	say,
	says,
	scriptedStream,
	summarise,
} from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { faultyJournals, memory, storages } from './support/storage.ts';

const assistant = scriptedAgent('assistant');
const alpha = scriptedAgent('alpha');
const beta = scriptedAgent('beta');
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

/** A room where each named specialist answers at `broadcast` and the assistant writes the summary. */
const summaryRoom = async (runtime: Runtime, script: PiScript, specialists = [alpha]) =>
	stopAtEnd(
		await startRoom({
			name: roomName('exchange'),
			runtime,
			agents: [...specialists, assistant],
			summary: assistant.name,
			seats: {
				...Object.fromEntries(specialists.map((agent) => [agent.name, 'broadcast' as const])),
				[assistant.name]: 'none',
			},
			execution: piExecution({ sessions: 'memory', stream: scriptedStream(script) }),
		}),
	);

const outcomes = ['published', 'silent', 'failed'] as const;
type Outcome = (typeof outcomes)[number];

const summaryFor =
	(outcome: Outcome): PiScript =>
	(_context, _agent, request) => {
		if (outcome === 'failed') throw new Error('Summary failed.');
		return outcome === 'published' && request === 1 ? summarise('Recorded result.') : quiet();
	};

async function expectOutcome(exchange: ExchangeHandle | undefined, outcome: Outcome) {
	const summary = exchange?.waitForSummary();
	if (outcome === 'failed') await expect(summary).rejects.toThrow(/interrupted/i);
	else if (outcome === 'published')
		await expect(summary).resolves.toMatchObject({ text: 'Recorded result.' });
	else await expect(summary).resolves.toBeUndefined();
}

const resumeWith = async (room: Room, runtime: Runtime, script: PiScript) =>
	stopAtEnd(
		await resumeRoom(room.name, {
			runtime,
			agents: [alpha, assistant],
			execution: piExecution({ sessions: 'memory', stream: scriptedStream(script) }),
		}),
	);

describe.each(storages)('replayed exchange responses on $name', (storage) => {
	const runtimeOver = async (attempts: number, backoff: number) => {
		const opened = await openFor(storage);
		const clock = fakeClock();
		const runtime = () =>
			createRuntime({
				clock,
				storage: opened.storage,
				limits: { activation: { attempts, backoff: () => backoff } },
			});
		return { clock, runtime };
	};
	const facts = says(['First fact.', 'Second fact.']);

	it.each(outcomes)('retains a %s result without scheduling another summary', async (outcome) => {
		const { clock, runtime } = await runtimeOver(1, 0);
		const room = await summaryRoom(
			runtime(),
			byAgent({ alpha: facts, assistant: summaryFor(outcome) }),
		);
		const exchange = await (await room.visit(priya)).send({ text: 'Result?' });
		await waitForRoom(room);
		expect(closedExchange(room, exchange.from)?.summary).toEqual(assistant.name);
		await expectOutcome(exchange, outcome);
		await room.stop();
		let calls = 0;
		const resumed = await resumeWith(room, runtime(), () => {
			calls += 1;
			return quiet();
		});
		await expectOutcome(resumed.exchange(exchange.from), outcome);
		await clock.advance(120_000);
		await waitForRoom(resumed);
		expect(owedOf(stateOf(resumed))).toEqual([]);
		expect(calls).toBe(0);
	});

	it('keeps a failed response pending across restart until its retry can publish', async () => {
		const { clock, runtime } = await runtimeOver(2, 1_000);
		const first = runtime();
		const room = await summaryRoom(
			first,
			byAgent({ alpha: facts, assistant: summaryFor('failed') }),
		);
		const failed = assistantEnded(room);
		const exchange = await (await room.visit(priya)).send({ text: 'Result?' });
		await failed;
		crash(first, room);
		const resumed = await resumeWith(
			room,
			runtime(),
			byAgent({ assistant: summaryFor('published') }),
		);
		const response = resumed.exchange(exchange.from)?.waitForSummary();
		const settled = settledFlag(Promise.resolve(response));
		await clock.advance(999);
		expect(settled()).toBe(false);
		expect(owedOf(stateOf(resumed))).toHaveLength(1);
		await clock.advance(1);
		await expect(response).resolves.toMatchObject({
			text: 'Recorded result.',
			covers: { from: exchange.from, through: closedExchange(resumed, exchange.from)?.through },
		});
		await waitForRoom(resumed);
		expect(owedOf(stateOf(resumed))).toEqual([]);
	});
});

describe('exchange completion handles', () => {
	const memoryRuntime = async (options: Partial<Parameters<typeof createRuntime>[0]> = {}) => {
		const opened = await openFor(memory);
		return {
			opened,
			runtime: createRuntime({
				clock: fakeClock(),
				storage: opened.storage,
				...options,
			}),
		};
	};

	it('opens an exchange with a post of the host, retries its key, and joins an open exchange', async () => {
		const answered = new Set<string>();
		const script: PiScript = (context, agent) => {
			if (agent === assistant.name)
				return isClosingContext(context) ? summarise('For priya.') : quiet();
			for (const cue of ['ci: build 412', 'Was the build green?']) {
				if (!contextText(context).includes(cue) || answered.has(cue)) continue;
				answered.add(cue);
				return say(`Seen: ${cue}`);
			}
			return quiet();
		};
		const { runtime } = await memoryRuntime();
		const room = await summaryRoom(runtime, script);
		// A post opens an exchange with no person, and the exchange owes no summary.
		const post = {
			to: alpha.name,
			text: 'ci: build 412 failed.',
			refs: ['https://ci.example/412'],
			key: 'ci-412',
		};
		const posted = await room.post(post);
		expect(posted).toMatchObject({ opened: true });
		expect(posted).not.toHaveProperty('person');
		await expect(posted.waitForClose()).resolves.toMatchObject([
			{ kind: 'posted', to: alpha.name, text: post.text, refs: post.refs, key: 'ci-412' },
			{ kind: 'said', from: alpha.name, text: 'Seen: ci: build 412' },
		]);
		await expect(posted.waitForSummary()).resolves.toBeUndefined();
		expect(closedExchange(room, posted.from)).not.toHaveProperty('person');
		// The key lands once, refuses another post, and names nothing in the key space of a visit.
		const again = await room.post(post);
		expect(again.from).toBe(posted.from);
		await expect(room.post({ text: 'ci: other.', key: 'ci-412' })).rejects.toThrow(
			/already names a different room operation/,
		);
		const asked = await (
			await room.visit(priya)
		).send({ text: 'Was the build green?', key: 'ci-412' });
		expect(asked).toMatchObject({ opened: true, person: priya.name });
		// A post into an open exchange joins it and keeps its person.
		const joined = await room.post({ text: 'ci: build 413 passed.' });
		expect(joined).toMatchObject({ from: asked.from, opened: false, person: priya.name });
		await expect(asked.waitForSummary()).resolves.toMatchObject({ to: priya.name });
		// A post goes to someone in the room who hears it.
		await expect(room.post({ to: 'nobody', text: 'x' })).rejects.toMatchObject({
			code: 'unknown_participant',
		});
		await expect(room.post({ to: assistant.name, text: 'x' })).rejects.toThrow(/wakes for nothing/);
		expect((await messagesOf(room)).filter((message) => message.kind === 'posted')).toHaveLength(2);
		// A resumed room finds the exchange that the post opened.
		await room.stop();
		const resumed = stopAtEnd(
			await resumeRoom(room.name, {
				runtime,
				agents: [alpha, assistant],
				execution: piExecution({ sessions: 'memory', stream: scriptedStream(script) }),
			}),
		);
		expect(resumed.exchange(posted.from)).toMatchObject({ from: posted.from, opened: false });
	});

	it('keeps a close wait pending when the close append fails, then resolves after retry', async () => {
		const opened = await openFor(memory);
		const faulty = faultyJournals(opened.storage);
		const room = stopAtEnd(
			await startRoom({
				name: roomName('exchange-close-retry'),
				runtime: createRuntime({
					clock: fakeClock(),
					storage: faulty.journals,
				}),
				execution: piExecution({ sessions: 'memory', stream: scriptedStream(() => quiet()) }),
			}),
		);
		const visit = await room.visit(priya);
		faulty.fail('before', 'close');
		const exchange = await visit.send({ text: 'First?', key: 'close-retry-1' });
		const waiting = exchange.waitForClose();
		const closed = settledFlag(waiting);
		for (let i = 0; i < 4; i += 1) await turn();
		expect(closed()).toBe(false);
		faulty.fail(false);
		await room.reconcile();
		await expect(waiting).resolves.toEqual(expect.any(Array));
		expect(closedExchange(room, exchange.from)).toMatchObject({ from: exchange.from });
	});

	it('resolves an earlier response while a later same-owner exchange is held', async () => {
		const firstSummaryStarted = deferred();
		const firstSummaryRelease = deferred();
		const laterAgentStarted = deferred();
		const laterAgentRelease = deferred();
		const specialists = new Map<string, number>();
		let summarised = false;
		const summaryReply = async (context: Context) => {
			if (!isClosingContext(context) || summarised) return quiet();
			summarised = true;
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
			return say(`${agent} answer ${count + 1}.`);
		};
		const { runtime } = await memoryRuntime();
		const room = await summaryRoom(
			runtime,
			(context, agent) =>
				agent === assistant.name ? summaryReply(context) : specialistReply(context, agent),
			[alpha, beta],
		);
		const visit = await room.visit(priya);
		const first = await visit.send({ text: 'First?', key: 'response-isolation-1' });
		await first.waitForClose();
		await firstSummaryStarted.promise;
		const response = first.waitForSummary();
		const second = await visit.send({ text: 'Second?', key: 'response-isolation-2' });
		await laterAgentStarted.promise;
		firstSummaryRelease.resolve();
		await expect(response).resolves.toMatchObject({ text: 'First result.', to: priya.name });
		const secondDone = settledFlag(second.waitForSummary());
		await turn();
		expect(secondDone()).toBe(false);
		laterAgentRelease.resolve();
		const secondConversation = await second.waitForClose();
		const durableSummary = (await messagesOf(room)).find((message) => message.kind === 'summary');
		expect(secondConversation.every((message) => message.kind !== 'summary')).toBe(true);
		expect(durableSummary?.seq).toBeGreaterThan(second.from);
		expect(durableSummary?.seq).toBeLessThanOrEqual(
			closedExchange(room, second.from)?.through ?? 0,
		);
		await expect(second.waitForSummary()).resolves.toBeUndefined();
	});

	it('rejects a pending response after an unclaimed summary exhausts retries', async () => {
		const clock = fakeClock();
		const summaryStarted = deferred();
		const summaryRelease = deferred();
		const answers = new Map<string, number>();
		const { opened, runtime } = await memoryRuntime({
			clock,
			limits: { activation: { attempts: 1, backoff: () => 0 } },
		});
		const room = await summaryRoom(
			runtime,
			async (context, agent) => {
				if (agent === assistant.name) {
					if (!isClosingContext(context)) return quiet();
					summaryStarted.resolve();
					await summaryRelease.promise;
					throw new Error('summary failed');
				}
				if (!contextText(context).includes('No summary?')) return quiet();
				const count = answers.get(agent) ?? 0;
				if (count >= 2) return quiet();
				answers.set(agent, count + 1);
				return say(`${agent} answer ${count + 1}.`);
			},
			[alpha, beta],
		);
		const exchange = await (
			await room.visit(priya)
		).send({
			text: 'No summary?',
			key: 'summary-unclaimed-1',
		});
		await summaryStarted.promise;
		const rejected = expect(exchange.waitForSummary()).rejects.toThrow(/interrupted/i);
		summaryRelease.resolve();
		for (let i = 0; i < 3; i += 1) {
			await clock.advance(1);
			await room.reconcile();
		}
		await rejected;
		expect(await storedOf(opened.journals, room.name)).toContainEqual(
			expect.objectContaining({
				kind: 'lease',
				body: expect.objectContaining({ phase: 'ended', reason: 'abandoned' }),
			}),
		);
	});
});
