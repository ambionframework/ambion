/**
 * A transcript write that fails is an audit failure. The room reports it once
 * and keeps the collaboration record whole: the activation still ends, a
 * summary still lands, and an audit failure alone starts no new activation.
 */
import type { JournalOpener } from '@ambionframework/journal';
import { describe, expect, it, onTestFinished } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { type CreateRuntimeOptions, createRuntime, resumeRoom, startRoom } from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import {
	andrei,
	assistant,
	collect,
	deferred,
	roomName,
	scriptedAgent,
	stateOf,
	waitForRoom,
} from './support/room.ts';
import {
	byAgent,
	contextText,
	quiet,
	says,
	scripted,
	speak,
	summarise,
} from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { type Storage, storages } from './support/storage.ts';

const product = scriptedAgent('product', 'Answers questions.');

/** Fail only transcript writes; the collaboration journal remains available. */
function auditOutage(storage: JournalOpener, before?: () => Promise<void>): JournalOpener {
	return {
		async open(name) {
			const journal = await storage.open(name);
			if (!name.startsWith('["ambion/pi-session",')) return journal;
			return {
				read: journal.read.bind(journal),
				append: async () => {
					await before?.();
					throw new Error('Audit storage unavailable.');
				},
			};
		},
	};
}

/** Runtimes on one clock over a storage whose transcript writes fail. */
async function outage(storage: Storage, before?: () => Promise<void>) {
	const opened = await storage.open();
	onTestFinished(() => opened.dispose());
	const clock = fakeClock();
	const runtime = (options: Omit<CreateRuntimeOptions, 'storage' | 'clock'> = {}) =>
		createRuntime({ clock, storage: auditOutage(opened.storage, before), ...options });
	return { clock, runtime };
}

const ofType = (events: ReturnType<typeof collect>, type: string, agent?: string) =>
	events.filter(
		(event) =>
			event.type === type && (agent === undefined || ('agent' in event && event.agent === agent)),
	);

describe.each(storages)('audit failure isolation on $name', (storage) => {
	it.each(['spoken', 'silent'] as const)(
		'completes %s work without another activation, and a resumed room starts none',
		async (outcome) => {
			const { clock, runtime } = await outage(storage);
			let calls = 0;
			const counted = (answer?: string) =>
				piExecution({
					stream: scripted(() => {
						calls += 1;
						return answer !== undefined && calls === 1 ? speak(answer) : quiet();
					}),
				});
			const room = stopAtEnd(
				await startRoom({
					name: roomName('audit-outcome'),
					agents: [product],
					runtime: runtime(),
					execution: counted(outcome === 'spoken' ? 'Accepted answer.' : undefined),
				}),
			);
			const events = collect(room);
			const exchange = await (await room.visit(andrei)).send({ text: 'Ready?' });
			await waitForRoom(room, 'quiet', 2_000);
			const discussion = await exchange.waitForClose();
			expect(discussion.filter((message) => message.from === product.name)).toHaveLength(
				outcome === 'spoken' ? 1 : 0,
			);
			expect(ofType(events, 'audit_error')).toHaveLength(1);
			expect(ofType(events, 'error')).toEqual([]);
			expect([...stateOf(room).leases.values()]).toEqual([
				expect.objectContaining({ phase: 'ended', reason: 'released' }),
			]);
			const finishedCalls = calls;
			await clock.advance(120_000);
			expect(calls).toBe(finishedCalls);
			await room.stop();

			const resumed = stopAtEnd(
				await resumeRoom(room.name, {
					runtime: runtime(),
					agents: [product],
					execution: counted(),
				}),
			);
			await waitForRoom(resumed, 'quiet', 2_000);
			expect(calls).toBe(finishedCalls);
			await expect(resumed.exchange(exchange.from)?.waitForClose()).resolves.toEqual(discussion);
		},
	);

	it.each(['published', 'silent'] as const)('retains a %s closing response', async (outcome) => {
		const { clock, runtime } = await outage(storage);
		let summaryCalls = 0;
		const room = stopAtEnd(
			await startRoom({
				name: roomName('audit-closing'),
				agents: [product, assistant],
				summary: assistant.name,
				seats: { [product.name]: 'broadcast', [assistant.name]: 'none' },
				runtime: runtime(),
				execution: piExecution({
					stream: scripted(
						byAgent({
							product: says(['First fact.', 'Second fact.']),
							assistant: () => {
								summaryCalls += 1;
								return outcome === 'published' && summaryCalls === 1
									? summarise('Consolidated answer.')
									: quiet();
							},
						}),
					),
				}),
			}),
		);
		const events = collect(room);
		const exchange = await (await room.visit(andrei)).send({ text: 'Result?' });
		await waitForRoom(room, 'quiet', 2_000);
		const response = await exchange.waitForSummary();
		expect(response?.text).toBe(outcome === 'published' ? 'Consolidated answer.' : undefined);
		expect(summaryCalls).toBeGreaterThan(0);
		expect(ofType(events, 'audit_error', assistant.name)).toHaveLength(1);
		expect(ofType(events, 'error')).toEqual([]);
		const finishedCalls = summaryCalls;
		await clock.advance(120_000);
		expect(summaryCalls).toBe(finishedCalls);
		expect(stateOf(room).owed).toEqual([]);
	});

	it('consumes later context after a failed audit without starting another activation', async () => {
		const auditing = deferred();
		const releaseAudit = deferred();
		onTestFinished(releaseAudit.resolve);
		const { runtime } = await outage(storage, async () => {
			auditing.resolve();
			await releaseAudit.promise;
		});
		const contexts: string[] = [];
		const room = stopAtEnd(
			await startRoom({
				name: roomName('audit-context-refresh'),
				agents: [product],
				runtime: runtime(),
				execution: piExecution({
					stream: scripted((context) => {
						contexts.push(contextText(context));
						return quiet();
					}),
				}),
			}),
		);
		const events = collect(room);
		const visit = await room.visit(andrei);
		const exchange = await visit.send({ text: 'First question.' });
		await auditing.promise;
		await visit.send({ text: 'Later correction.' });
		releaseAudit.resolve();
		await waitForRoom(room, 'quiet', 2_000);
		expect(contexts).toHaveLength(2);
		expect(contexts[0]).not.toContain('Later correction.');
		expect(contexts[1]).toContain('Later correction.');
		expect(ofType(events, 'activation_start')).toHaveLength(1);
		expect(ofType(events, 'audit_error')).toHaveLength(2);
		expect(ofType(events, 'error')).toEqual([]);
		const messages = await exchange.waitForClose();
		expect([...stateOf(room).leases.values()]).toEqual([
			expect.objectContaining({ reason: 'released', readThrough: messages.at(-1)?.seq }),
		]);
	});

	it('keeps a provider failure eligible for retry when its audit also fails', async () => {
		const { clock, runtime } = await outage(storage);
		let calls = 0;
		const room = stopAtEnd(
			await startRoom({
				name: roomName('audit-provider-failure'),
				agents: [product],
				runtime: runtime({ limits: { activation: { attempts: 2, backoff: () => 100 } } }),
				execution: piExecution({
					stream: scripted(() => {
						calls += 1;
						if (calls === 1) throw new Error('Provider unavailable.');
						return calls === 2 ? speak('Recovered answer.') : quiet();
					}),
				}),
			}),
		);
		const events = collect(room);
		const exchange = await (await room.visit(andrei)).send({ text: 'Ready?' });
		await expect.poll(() => ofType(events, 'activation_end').length).toBe(1);
		expect(ofType(events, 'error')).toEqual([
			expect.objectContaining({
				error: expect.objectContaining({
					message: expect.stringContaining('Provider unavailable.'),
				}),
			}),
		]);
		await clock.advance(100);
		await waitForRoom(room, 'quiet', 2_000);
		expect(
			(await exchange.waitForClose()).filter((message) => message.from === product.name),
		).toEqual([expect.objectContaining({ text: 'Recovered answer.' })]);
		expect(ofType(events, 'audit_error')).toHaveLength(2);
		const finishedCalls = calls;
		await clock.advance(120_000);
		expect(calls).toBe(finishedCalls);
	});
});
