import { describe, expect, it } from 'vitest';
import { createRuntime, defineAgent, defineHuman, startRoom } from '../src/index.ts';
import {
	inProcessTransport,
	type LeaseRequest,
	type Steer,
	type Transport,
	type Wake,
} from '../src/transport.ts';
import { fakeClock } from './support/clock.ts';
import { assistant, deferred, roomName, stateOf, waitForRoom } from './support/room.ts';
import { byAgent, contextText, quiet, scripted } from './support/scripted.ts';
import { storages } from './support/storage.ts';

const alpha = defineAgent({
	name: 'alpha',
	identity: 'Answers questions.',
	instructions: 'Answer.',
	model: 'scripted/alpha',
});
const priya = defineHuman({ name: 'priya', identity: 'Asks questions.' });

/** Hold the first release after the executor has finished reading context. */
function heldReleaseTransport(holdRelease = true) {
	const ending = deferred();
	const release = deferred();
	const wakes: Wake[] = [];
	const steers: Steer[] = [];
	const deliver: (() => Promise<void>)[] = [];
	const base = inProcessTransport();
	let held = false;
	const transport: Transport = {
		connect(room, seat, runtime) {
			const port = base.connect(
				{
					name: room.name,
					stream: room.stream,
					model: room.model,
					transcripts: room.transcripts,
					definition: (name) => room.definition(name),
					emit: (event) => room.emit(event),
					evict: () => room.evict(),
					view: (id) => room.view(id),
					commit: (request) => room.commit(request),
					lease: async (request: LeaseRequest) => {
						if (holdRelease && seat === alpha.name && request.operation === 'release' && !held) {
							held = true;
							ending.resolve();
							await release.promise;
						}
						return room.lease(request);
					},
				},
				seat,
				runtime,
			);
			return {
				cut: (activation) => port.cut(activation),
				wake: (wake) => {
					wakes.push(wake);
					return port.wake(wake);
				},
				steer: async (steer) => {
					steers.push(steer);
					deliver.push(() => port.steer(steer));
				},
			};
		},
	};
	return { transport, ending, release, wakes, steers, deliver };
}

describe.each(storages)('messages across activation completion on $name', (storage) => {
	it.each(['lost', 'late'] as const)(
		'recovers a message through reconciliation when steering is %s',
		async (delivery) => {
			const opened = await storage.open();
			const clock = fakeClock();
			const before = clock.now();
			const observed = heldReleaseTransport();
			const nextStarted = deferred();
			const nextRelease = deferred();
			const contexts: string[] = [];
			const room = await startRoom({
				name: roomName('steering-release'),
				assistant,
				agents: [alpha],
				seats: { [alpha.name]: 'named' },
				runtime: createRuntime({ storage: opened.storage, clock, transport: observed.transport }),
				streamFn: scripted(
					byAgent({
						alpha: async (context, _agent, call) => {
							contexts.push(contextText(context));
							if (call === 2) {
								nextStarted.resolve();
								await nextRelease.promise;
							}
							return quiet();
						},
					}),
				),
			});
			try {
				const visit = await room.visit(priya);
				await visit.send({ to: alpha.name, text: 'Start analysis.' });
				await observed.ending.promise;
				// The caller sends an ordinary message while the executor releases.
				// Its active recipient is recorded even though idle attention excludes it.
				await visit.send({ to: priya.name, text: 'Keep this final correction.' });
				const update = (await room.messages()).at(-1);
				expect(update?.wakes ?? []).toEqual([]);
				expect(observed.steers).toHaveLength(1);
				expect(observed.steers[0]?.message).toEqual(update);
				expect(observed.wakes).toHaveLength(1);
				observed.release.resolve();
				await nextStarted.promise;
				expect(observed.wakes.map((wake) => wake.activation)).toEqual([
					observed.steers[0]?.activation,
					`message:${update?.seq}:alpha:1`,
				]);
				// A delayed transport operation must not enter the later activation.
				if (delivery === 'late') await observed.deliver[0]?.();
				nextRelease.resolve();
				await waitForRoom(room);
				if (delivery === 'late') await observed.deliver[0]?.();
				await waitForRoom(room);
				expect(contexts).toHaveLength(2);
				expect(contexts[0]).not.toContain('Keep this final correction.');
				expect(contexts[1]?.split('Keep this final correction.')).toHaveLength(2);
				expect(observed.wakes).toHaveLength(2);
				expect(stateOf(room).pending).toEqual([]);
				expect(clock.now()).toBe(before);
			} finally {
				observed.release.resolve();
				nextRelease.resolve();
				await room.stop();
				await opened.dispose();
			}
		},
	);

	it('consumes reordered and repeated steering without starting another activation', async () => {
		const opened = await storage.open();
		const observed = heldReleaseTransport(false);
		const started = deferred();
		const release = deferred();
		const contexts: string[] = [];
		const room = await startRoom({
			name: roomName('steering-order'),
			assistant,
			agents: [alpha],
			seats: { [alpha.name]: 'named' },
			runtime: createRuntime({ storage: opened.storage, transport: observed.transport }),
			streamFn: scripted(
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
		});
		try {
			const visit = await room.visit(priya);
			await visit.send({ to: alpha.name, text: 'Start analysis.' });
			await started.promise;
			await visit.send({ to: priya.name, text: 'First correction.' });
			await visit.send({ to: priya.name, text: 'Second correction.' });
			expect(observed.steers).toHaveLength(2);
			await observed.deliver[1]?.();
			await observed.deliver[1]?.();
			await observed.deliver[0]?.();
			release.resolve();
			await waitForRoom(room);
			expect(contexts.at(-1)).toContain('First correction.');
			expect(contexts.at(-1)).toContain('Second correction.');
			expect(observed.wakes).toHaveLength(1);
			expect(stateOf(room).pending).toEqual([]);
			const last = observed.steers.at(-1);
			expect(stateOf(room).leases.get(last?.activation ?? '')?.readThrough).toBe(last?.message.seq);
		} finally {
			release.resolve();
			await room.stop();
			await opened.dispose();
		}
	});
});
