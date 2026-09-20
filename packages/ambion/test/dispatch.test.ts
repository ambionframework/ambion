import { describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import { inProcessTransport, type Transport, type Wake } from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	type Room,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import { assistant, crash, deferred, roomName, stateOf, waitForRoom } from './support/room.ts';
import { byAgent, quiet, scripted } from './support/scripted.ts';
import { storages } from './support/storage.ts';

const alpha = defineAgent({
	name: 'alpha',
	identity: 'Answers.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/alpha' }),
});
const beta = defineAgent({
	name: 'beta',
	identity: 'Available expert.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/beta' }),
});
const priya = defineHuman({ name: 'priya', identity: 'Asks questions.' });

/** Record transport requests, optionally losing them before an executor claims work. */
function observed(deliver = true): { transport: Transport; sent: Wake[] } {
	const sent: Wake[] = [];
	const base = inProcessTransport();
	return {
		sent,
		transport: {
			connect(room, context) {
				const port = base.connect(room, context);
				return {
					cut: (activation) => port.cut(activation),
					steer: (steer) => port.steer(steer),
					wake: async (wake) => {
						sent.push(wake);
						if (deliver) await port.wake(wake);
					},
				};
			},
		},
	};
}

const activations = (sent: readonly Wake[]): string[] => sent.map((wake) => wake.activation).sort();

describe.each(storages)('activation dispatch on $name', (storage) => {
	it('starts ordinary work promptly with only their recorded causes', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const before = clock.now();
		const alphaStarted = deferred();
		const assistantStarted = deferred();
		const transport = observed();
		const room = await startRoom({
			name: roomName('dispatch-causes'),

			agents: [alpha, beta, assistant],
			seats: { [assistant.name]: 'broadcast', ...{ [alpha.name]: 'broadcast' } },
			runtime: createRuntime({ storage: opened.storage, clock, transport: transport.transport }),
			execution: piExecution({
				stream: scripted(
					byAgent({
						alpha: () => {
							alphaStarted.resolve();
							return quiet();
						},
						assistant: () => {
							assistantStarted.resolve();
							return quiet();
						},
					}),
				),
			}),
		});
		try {
			const exchange = await (await room.visit(priya)).send({ text: 'Who can answer?' });
			// No caller-driven reconciliation or clock advance starts these activations.
			await Promise.all([alphaStarted.promise, assistantStarted.promise]);
			await waitForRoom(room);
			expect(clock.now()).toBe(before);
			expect(activations(transport.sent)).toEqual([
				`message:${exchange.from}:alpha:1`,
				`message:${exchange.from}:assistant:1`,
			]);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('recovers lost initial sends with the same activation identities and no resend delay', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const lost = observed(false);
		const firstRuntime = createRuntime({
			storage: opened.storage,
			clock,
			transport: lost.transport,
		});
		const room = await startRoom({
			name: roomName('dispatch-recovery'),

			agents: [alpha, beta, assistant],
			seats: { [assistant.name]: 'broadcast', ...{ [alpha.name]: 'broadcast' } },
			runtime: firstRuntime,
			execution: piExecution({ stream: scripted(() => quiet()) }),
		});
		let resumed: Room | undefined;
		try {
			await (await room.visit(priya)).send({ text: 'Recover this work.' });
			await room.reconcile();
			const expected = stateOf(room)
				.due.map((work) => work.id)
				.sort();
			expect(expected).toHaveLength(2);
			expect(stateOf(room).leases.size).toBe(0);
			crash(firstRuntime, room);
			const recovered = observed();
			const before = clock.now();
			resumed = await resumeRoom(room.name, {
				runtime: createRuntime({ storage: opened.storage, clock, transport: recovered.transport }),
				agents: [alpha, beta, assistant],
				execution: piExecution({ stream: scripted(() => quiet()) }),
			});
			await waitForRoom(resumed);
			expect(clock.now()).toBe(before);
			expect(activations(lost.sent)).toEqual(expected);
			expect(activations(recovered.sent)).toEqual(expected);
			expect(stateOf(resumed).due).toEqual([]);
		} finally {
			await resumed?.stop();
			await room.stop();
			await opened.dispose();
		}
	});
});
