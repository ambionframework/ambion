import type { JournalOpener } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import { createRuntime, defineAgent, type Room, resumeRoom, startRoom } from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import {
	andrei,
	assistant,
	collect,
	deferred,
	roomName,
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
import { storages } from './support/storage.ts';

const product = defineAgent({
	name: 'product',
	identity: 'Answers questions.',
	executor: pi({ instructions: 'Contribute when useful.', model: 'scripted/product' }),
});

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

describe.each(storages)('audit failure isolation on $name', (storage) => {
	it.each(['spoken', 'silent'] as const)(
		'completes %s work without another activation',
		async (outcome) => {
			const opened = await storage.open();
			const clock = fakeClock();
			let calls = 0;
			const runtime = () => createRuntime({ clock, storage: auditOutage(opened.storage) });
			const room = await startRoom({
				name: roomName('audit-outcome'),
				agents: [product],
				runtime: runtime(),
				execution: piExecution({
					stream: scripted(() => {
						calls += 1;
						return outcome === 'spoken' && calls === 1 ? speak('Accepted answer.') : quiet();
					}),
				}),
			});
			const events = collect(room);
			let resumed: Room | undefined;
			try {
				const exchange = await (await room.visit(andrei)).send({ text: 'Ready?' });
				await waitForRoom(room, 'quiet', 2_000);
				const discussion = await exchange.waitForClose();
				expect(discussion.filter((message) => message.from === product.name)).toHaveLength(
					outcome === 'spoken' ? 1 : 0,
				);
				expect(events.filter((event) => event.type === 'audit_error')).toHaveLength(1);
				expect(events.filter((event) => event.type === 'error')).toEqual([]);
				expect([...stateOf(room).leases.values()]).toEqual([
					expect.objectContaining({ phase: 'ended', reason: 'released' }),
				]);
				const finishedCalls = calls;
				await clock.advance(120_000);
				expect(calls).toBe(finishedCalls);
				await room.stop();
				resumed = await resumeRoom(room.name, {
					runtime: runtime(),
					agents: [product],
					execution: piExecution({
						stream: scripted(() => {
							calls += 1;
							return quiet();
						}),
					}),
				});
				await waitForRoom(resumed, 'quiet', 2_000);
				expect(calls).toBe(finishedCalls);
				await expect(resumed.exchange(exchange.from)?.waitForClose()).resolves.toEqual(discussion);
			} finally {
				await resumed?.stop();
				await room.stop();
				await opened.dispose();
			}
		},
	);

	it.each(['published', 'silent'] as const)('retains a %s closing response', async (outcome) => {
		const opened = await storage.open();
		const clock = fakeClock();
		let summaryCalls = 0;
		const room = await startRoom({
			name: roomName('audit-closing'),
			agents: [product, assistant],
			summary: assistant.name,
			seats: { [product.name]: 'broadcast', [assistant.name]: 'none' },
			runtime: createRuntime({ clock, storage: auditOutage(opened.storage) }),
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
		});
		const events = collect(room);
		try {
			const exchange = await (await room.visit(andrei)).send({ text: 'Result?' });
			await waitForRoom(room, 'quiet', 2_000);
			const response = await exchange.waitForSummary();
			expect(response?.text).toBe(outcome === 'published' ? 'Consolidated answer.' : undefined);
			expect(summaryCalls).toBeGreaterThan(0);
			expect(
				events.filter((event) => event.type === 'audit_error' && event.agent === assistant.name),
			).toHaveLength(1);
			expect(events.filter((event) => event.type === 'error')).toEqual([]);
			const finishedCalls = summaryCalls;
			await clock.advance(120_000);
			expect(summaryCalls).toBe(finishedCalls);
			expect(stateOf(room).owed).toEqual([]);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('consumes later context after a failed audit without starting another activation', async () => {
		const opened = await storage.open();
		const auditing = deferred();
		const releaseAudit = deferred();
		const contexts: string[] = [];
		const room = await startRoom({
			name: roomName('audit-context-refresh'),
			agents: [product],
			runtime: createRuntime({
				storage: auditOutage(opened.storage, async () => {
					auditing.resolve();
					await releaseAudit.promise;
				}),
			}),
			execution: piExecution({
				stream: scripted((context) => {
					contexts.push(contextText(context));
					return quiet();
				}),
			}),
		});
		const events = collect(room);
		try {
			const visit = await room.visit(andrei);
			const exchange = await visit.send({ text: 'First question.' });
			await auditing.promise;
			await visit.send({ text: 'Later correction.' });
			releaseAudit.resolve();
			await waitForRoom(room, 'quiet', 2_000);
			expect(contexts).toHaveLength(2);
			expect(contexts[0]).not.toContain('Later correction.');
			expect(contexts[1]).toContain('Later correction.');
			expect(events.filter((event) => event.type === 'activation_start')).toHaveLength(1);
			expect(events.filter((event) => event.type === 'audit_error')).toHaveLength(2);
			expect(events.filter((event) => event.type === 'error')).toEqual([]);
			const messages = await exchange.waitForClose();
			expect([...stateOf(room).leases.values()]).toEqual([
				expect.objectContaining({ reason: 'released', readThrough: messages.at(-1)?.seq }),
			]);
		} finally {
			releaseAudit.resolve();
			await room.stop();
			await opened.dispose();
		}
	});

	it('keeps a provider failure eligible for retry when its audit also fails', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		let calls = 0;
		const room = await startRoom({
			name: roomName('audit-provider-failure'),
			agents: [product],
			runtime: createRuntime({
				clock,
				storage: auditOutage(opened.storage),
				limits: { activation: { attempts: 2, backoff: () => 100 } },
			}),
			execution: piExecution({
				stream: scripted(() => {
					calls += 1;
					if (calls === 1) throw new Error('Provider unavailable.');
					return calls === 2 ? speak('Recovered answer.') : quiet();
				}),
			}),
		});
		const events = collect(room);
		try {
			const exchange = await (await room.visit(andrei)).send({ text: 'Ready?' });
			await expect
				.poll(() => events.filter((event) => event.type === 'activation_end').length)
				.toBe(1);
			expect(events.filter((event) => event.type === 'error')).toEqual([
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
			expect(events.filter((event) => event.type === 'audit_error')).toHaveLength(2);
			const finishedCalls = calls;
			await clock.advance(120_000);
			expect(calls).toBe(finishedCalls);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});
});
