/**
 * Steering: a message that reaches a seat while its activation runs goes
 * into that activation. A steer that the transport loses, delays,
 * reorders or repeats, or that outlives its activation, reaches the seat
 * once, from the journal.
 */
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import type { Steer, Wake } from '../src/hosting.ts';
import { createRuntime, defineHuman, resumeRoom, startRoom } from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { tapped } from './support/core-failure.ts';
import {
	assistant,
	assistantEnded,
	collect,
	crash,
	deferred,
	messagesOf,
	roomName,
	scriptedAgent,
	stateOf,
	waitForRoom,
} from './support/room.ts';
import { byAgent, contextText, quiet, says, scripted, summarise } from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { storages } from './support/storage.ts';

const alpha = scriptedAgent('alpha');
const beta = scriptedAgent('beta');
const priya = defineHuman({ name: 'priya', identity: 'Asks questions.' });

/**
 * Record every wake and steer. `deferSteers` keeps each steer for the test
 * to deliver, and `holdRelease` holds alpha's first release until the test
 * resolves `release`.
 */
function observe(options: { holdRelease?: boolean; deferSteers?: boolean } = {}) {
	const ending = deferred();
	const release = deferred();
	const wakes: Wake[] = [];
	const steers: Steer[] = [];
	const deliver: (() => Promise<void>)[] = [];
	let held = false;
	const transport = tapped({
		room: (room, context) => ({
			lease: async (request) => {
				if (
					options.holdRelease &&
					context.seat === alpha.name &&
					request.operation === 'release' &&
					!held
				) {
					held = true;
					ending.resolve();
					await release.promise;
				}
				return room.lease(request);
			},
		}),
		wake: (wake, port) => {
			wakes.push(wake);
			return port.wake(wake);
		},
		steer: async (steer, port) => {
			steers.push(steer);
			if (options.deferSteers) deliver.push(() => port.steer(steer));
			else await port.steer(steer);
		},
	});
	return { transport, ending, release, wakes, steers, deliver };
}

/** Alpha records every context it reads, and holds its activation on call `hold`. */
function holdingAlpha(hold: number) {
	const started = deferred();
	const release = deferred();
	const contexts: string[] = [];
	const execution = piExecution({
		sessions: 'memory',
		stream: scripted(
			byAgent({
				alpha: async (context, _agent, call) => {
					contexts.push(contextText(context));
					if (call === hold) {
						started.resolve();
						await release.promise;
					}
					return quiet();
				},
			}),
		),
	});
	return { started, release, contexts, execution };
}

describe.each(storages)('steering on $name', (storage) => {
	it.each(['lost', 'late'] as const)(
		'recovers a message through reconciliation when steering is %s',
		async (delivery) => {
			const opened = await openFor(storage);
			const clock = fakeClock();
			const before = clock.now();
			const observed = observe({ holdRelease: true, deferSteers: true });
			const next = holdingAlpha(2);
			const room = stopAtEnd(
				await startRoom({
					name: roomName('steering-release'),
					agents: [alpha, assistant],
					seats: { [assistant.name]: 'none', [alpha.name]: 'named' },
					runtime: createRuntime({ storage: opened.storage, clock, transport: observed.transport }),
					execution: next.execution,
				}),
			);
			const visit = await room.visit(priya);
			await visit.send({ to: alpha.name, text: 'Start analysis.' });
			await observed.ending.promise;
			// The caller sends an ordinary message while the executor releases.
			// Its active recipient is recorded even though idle attention excludes it.
			await visit.send({ to: priya.name, text: 'Keep this final correction.' });
			const update = (await messagesOf(room)).at(-1);
			expect(update?.wakes ?? []).toEqual([]);
			expect(observed.steers).toHaveLength(1);
			expect(observed.steers[0]?.message).toEqual(update);
			expect(observed.wakes).toHaveLength(1);
			observed.release.resolve();
			await next.started.promise;
			expect(observed.wakes.map((wake) => wake.activation)).toEqual([
				observed.steers[0]?.activation,
				`message:${update?.seq}:alpha:1`,
			]);
			// A delayed transport operation must not enter the later activation.
			if (delivery === 'late') await observed.deliver[0]?.();
			next.release.resolve();
			await waitForRoom(room);
			if (delivery === 'late') await observed.deliver[0]?.();
			await waitForRoom(room);
			expect(next.contexts).toHaveLength(2);
			expect(next.contexts[0]).not.toContain('Keep this final correction.');
			expect(next.contexts[1]?.split('Keep this final correction.')).toHaveLength(2);
			expect(observed.wakes).toHaveLength(2);
			expect(stateOf(room).pending).toEqual([]);
			expect(clock.now()).toBe(before);
		},
	);

	it('steers a message to an active agent with narrow idle attention, and consumes reordered and repeated steers in one activation', async () => {
		const opened = await openFor(storage);
		const observed = observe({ deferSteers: true });
		const first = holdingAlpha(1);
		const room = stopAtEnd(
			await startRoom({
				name: roomName('steering-order'),
				agents: [alpha, assistant],
				seats: { [assistant.name]: 'none', [alpha.name]: 'named' },
				runtime: createRuntime({ storage: opened.storage, transport: observed.transport }),
				execution: first.execution,
			}),
		);
		const events = collect(room);
		const visit = await room.visit(priya);
		await visit.send({ to: alpha.name, text: 'Start analysis.' });
		await first.started.promise;
		await visit.send({ to: priya.name, text: 'First correction.' });
		const update = (await messagesOf(room)).at(-1);
		expect(update?.wakes ?? []).toEqual([]);
		expect(observed.steers.map((steer) => [steer.seat, steer.message.seq])).toEqual([
			['alpha', update?.seq],
		]);
		expect(observed.steers[0]?.activation).toBe(
			[...stateOf(room).leases.values()].find((lease) => lease.phase === 'running')?.id,
		);
		await visit.send({ to: priya.name, text: 'Second correction.' });
		expect(observed.steers).toHaveLength(2);
		await observed.deliver[1]?.();
		await observed.deliver[1]?.();
		await observed.deliver[0]?.();
		first.release.resolve();
		await waitForRoom(room);
		expect(first.contexts.at(-1)).toContain('First correction.');
		expect(first.contexts.at(-1)).toContain('Second correction.');
		expect(observed.wakes).toHaveLength(1);
		expect(
			events.filter((event) => event.type === 'activation_start').map((event) => event.agent),
		).toEqual(['alpha']);
		expect(stateOf(room).pending).toEqual([]);
		const last = observed.steers.at(-1);
		expect(stateOf(room).leases.get(last?.activation ?? '')?.readThrough).toBe(last?.message.seq);
	});

	it('recovers unconsumed steering from the journal after its activation expires', async () => {
		const opened = await openFor(storage);
		const clock = fakeClock();
		const runtime = () =>
			createRuntime({
				storage: opened.storage,
				clock,
				limits: { activation: { attempts: 3, backoff: () => 1_000 } },
			});
		const firstRuntime = runtime();
		const first = holdingAlpha(1);
		const room = stopAtEnd(
			await startRoom({
				name: roomName('steering-replay'),
				agents: [alpha, beta, assistant],
				seats: { [assistant.name]: 'none', [alpha.name]: 'named', [beta.name]: 'named' },
				runtime: firstRuntime,
				execution: first.execution,
			}),
		);
		const visit = await room.visit(priya);
		await visit.send({ to: alpha.name, text: 'Begin analysis.' });
		await first.started.promise;
		await visit.send({ to: priya.name, text: 'Recover this unconsumed context.' });
		const update = (await messagesOf(room)).at(-1);
		expect(update?.wakes ?? []).toEqual([]);
		crash(firstRuntime, room);
		first.release.resolve();
		await clock.advance(61_000);
		const contexts: string[] = [];
		const resumed = stopAtEnd(
			await resumeRoom(room.name, {
				runtime: runtime(),
				agents: [alpha, beta, assistant],
				execution: piExecution({
					sessions: 'memory',
					stream: scripted(
						byAgent({
							alpha: (context) => {
								contexts.push(contextText(context));
								return quiet();
							},
						}),
					),
				}),
			}),
		);
		expect(stateOf(resumed).pending).toEqual(
			expect.arrayContaining([expect.objectContaining({ seat: alpha.name, seq: update?.seq })]),
		);
		await clock.advance(1_000);
		await waitForRoom(resumed);
		expect(contexts.some((text) => text.includes('Recover this unconsumed context.'))).toBe(true);
		expect(stateOf(resumed).pending).toEqual([]);
	});

	it('keeps summary input fixed while delivering its result to an active ordinary agent', async () => {
		const opened = await openFor(storage);
		const summaryStarted = deferred();
		const summaryRelease = deferred();
		const betaStarted = deferred();
		const betaRelease = deferred();
		const contexts: string[] = [];
		const observed = observe();
		const room = stopAtEnd(
			await startRoom({
				name: roomName('steering-summary-boundary'),
				summary: assistant.name,
				agents: [alpha, beta, assistant],
				seats: { [assistant.name]: 'none', [alpha.name]: 'broadcast', [beta.name]: 'named' },
				runtime: createRuntime({ storage: opened.storage, transport: observed.transport }),
				execution: piExecution({
					sessions: 'memory',
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
			}),
		);
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
			observed.steers.filter((steer) => steer.message.seq === summary?.seq).map((s) => s.seat),
		).toEqual(['beta']);
		betaRelease.resolve();
		await waitForRoom(room);
	});
});
