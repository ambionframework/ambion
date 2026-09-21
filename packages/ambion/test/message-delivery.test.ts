import { describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import { inProcessTransport, type Steer, type Transport } from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	type Room,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import {
	assistant,
	assistantEnded,
	collect,
	crash,
	deferred,
	messagesOf,
	roomName,
	stateOf,
	waitForRoom,
} from './support/room.ts';
import { byAgent, contextText, quiet, says, scripted, summarise } from './support/scripted.ts';
import { storages } from './support/storage.ts';

const alpha = defineAgent({
	name: 'alpha',
	identity: 'Answers questions.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/alpha' }),
});
const beta = defineAgent({
	name: 'beta',
	identity: 'Answers directed questions.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/beta' }),
});
const priya = defineHuman({ name: 'priya', identity: 'Asks questions.' });
const quietSeats = { alpha: 'named', beta: 'named' } as const;

/** Observe the actual transport boundary while the ordinary executor runs. */
function observedTransport(): { transport: Transport; steers: Steer[] } {
	const transport = inProcessTransport();
	const steers: Steer[] = [];
	return {
		steers,
		transport: {
			connect(room, context) {
				const port = transport.connect(room, context);
				return {
					cut: (activation) => port.cut(activation),
					steer: (steer) => {
						steers.push(steer);
						return port.steer(steer);
					},
					wake: (wake) => port.wake(wake),
				};
			},
		},
	};
}

describe.each(storages)('message delivery on $name', (storage) => {
	it('steers a directed message to an active agent with narrow idle attention', async () => {
		const opened = await storage.open();
		const started = deferred();
		const release = deferred();
		const contexts: string[] = [];
		const observed = observedTransport();
		const room = await startRoom({
			name: roomName('delivery-active'),

			agents: [alpha, beta, assistant],
			seats: { [assistant.name]: 'none', ...quietSeats },
			runtime: createRuntime({ storage: opened.storage, transport: observed.transport }),
			execution: piExecution({
				stream: scripted(
					byAgent({
						alpha: async (context, _agent, call) => {
							contexts.push(contextText(context));
							if (call === 1) {
								started.resolve();
								await release.promise;
							}
							return quiet();
						},
					}),
				),
			}),
		});
		const events = collect(room);
		try {
			const visit = await room.visit(priya);
			await visit.send({ to: alpha.name, text: 'Begin analysis.' });
			await started.promise;
			await visit.send({ to: priya.name, text: 'The requirement has changed.' });
			const update = (await messagesOf(room)).at(-1);
			expect(update?.wakes ?? []).toEqual([]);
			expect(
				observed.steers.filter((steer) => steer.message.seq === update?.seq).map((s) => s.seat),
			).toEqual(['alpha']);
			expect(observed.steers.find((steer) => steer.message.seq === update?.seq)?.activation).toBe(
				[...stateOf(room).leases.values()].find((lease) => lease.phase === 'running')?.id,
			);
			release.resolve();
			await waitForRoom(room);
			expect(contexts.slice(1).some((text) => text.includes('The requirement has changed.'))).toBe(
				true,
			);
			expect(
				events.filter((event) => event.type === 'activation_start').map((event) => event.agent),
			).toEqual(['alpha']);
			expect(stateOf(room).pending).toEqual([]);
		} finally {
			release.resolve();
			await room.stop();
			await opened.dispose();
		}
	});

	it('recovers unconsumed steering from the journal after its activation expires', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const started = deferred();
		const release = deferred();
		const runtime = () =>
			createRuntime({
				storage: opened.storage,
				clock,
				limits: { activation: { attempts: 3, backoff: () => 1_000 } },
			});
		const firstRuntime = runtime();
		const room = await startRoom({
			name: roomName('delivery-replay'),

			agents: [alpha, beta, assistant],
			seats: { [assistant.name]: 'none', ...quietSeats },
			runtime: firstRuntime,
			execution: piExecution({
				stream: scripted(
					byAgent({
						alpha: async () => {
							started.resolve();
							await release.promise;
							return quiet();
						},
					}),
				),
			}),
		});
		let resumed: Room | undefined;
		try {
			const visit = await room.visit(priya);
			await visit.send({ to: alpha.name, text: 'Begin analysis.' });
			await started.promise;
			await visit.send({ to: priya.name, text: 'Recover this unconsumed context.' });
			const update = (await messagesOf(room)).at(-1);
			expect(update?.wakes ?? []).toEqual([]);
			crash(firstRuntime, room);
			release.resolve();
			await clock.advance(61_000);
			const contexts: string[] = [];
			resumed = await resumeRoom(room.name, {
				runtime: runtime(),
				agents: [alpha, beta, assistant],
				execution: piExecution({
					stream: scripted(
						byAgent({
							alpha: (context) => {
								contexts.push(contextText(context));
								return quiet();
							},
						}),
					),
				}),
			});
			expect(stateOf(resumed).pending).toEqual(
				expect.arrayContaining([expect.objectContaining({ seat: alpha.name, seq: update?.seq })]),
			);
			await clock.advance(1_000);
			await waitForRoom(resumed);
			expect(contexts.some((text) => text.includes('Recover this unconsumed context.'))).toBe(true);
			expect(stateOf(resumed).pending).toEqual([]);
		} finally {
			release.resolve();
			await resumed?.stop();
			await room.stop();
			await opened.dispose();
		}
	});

	it('keeps summary input fixed while delivering its result to an active ordinary agent', async () => {
		const opened = await storage.open();
		const summaryStarted = deferred();
		const summaryRelease = deferred();
		const betaStarted = deferred();
		const betaRelease = deferred();
		const contexts: string[] = [];
		const observed = observedTransport();
		const room = await startRoom({
			name: roomName('delivery-summary-boundary'),
			summary: assistant.name,
			agents: [alpha, beta, assistant],
			seats: { [assistant.name]: 'none', [alpha.name]: 'broadcast', [beta.name]: 'named' },
			runtime: createRuntime({ storage: opened.storage, transport: observed.transport }),
			execution: piExecution({
				stream: scripted(
					byAgent({
						alpha: says(['First fact.', 'Second fact.']),
						beta: async (_context, _agent, call) => {
							if (call === 1) {
								betaStarted.resolve();
								await betaRelease.promise;
							}
							return quiet();
						},
						assistant: async (context, _agent, call) => {
							contexts.push(contextText(context));
							if (call !== 1) return quiet();
							summaryStarted.resolve();
							await summaryRelease.promise;
							return summarise('First exchange result.');
						},
					}),
				),
			}),
		});
		try {
			const visit = await room.visit(priya);
			const first = await visit.send({ text: 'First question.' });
			await summaryStarted.promise;
			await visit.send({ to: beta.name, text: 'Later question outside the summary.' });
			await betaStarted.promise;
			expect(observed.steers.filter((steer) => steer.seat === assistant.name)).toEqual([]);
			const ended = assistantEnded(room);
			summaryRelease.resolve();
			const summary = await first.waitForSummary();
			await ended;
			expect(summary?.text).toBe('First exchange result.');
			expect(contexts.every((text) => !text.includes('Later question outside the summary.'))).toBe(
				true,
			);
			expect(
				observed.steers
					.filter((steer) => steer.message.seq === summary?.seq)
					.map((steer) => steer.seat),
			).toEqual(['beta']);
			betaRelease.resolve();
			await waitForRoom(room);
		} finally {
			summaryRelease.resolve();
			betaRelease.resolve();
			await room.stop();
			await opened.dispose();
		}
	});
});
