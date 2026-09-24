import { describe, expect, expectTypeOf, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import {
	type AgentExecutionContext,
	hostingOf,
	inProcessTransport,
	type RoomProtocol,
	runningRoom,
	type Transport,
} from '../src/hosting.ts';
import { createRuntime, defineAgent, readRoom, resumeRoom, startRoom } from '../src/index.ts';
import { andrei, collect, deferred, roomName, tick, waitForRoom } from './support/room.ts';
import { isClosing, quiet, scripted, seat, speak } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { storages } from './support/storage.ts';
import { serializing } from './support/transport.ts';

const writer = defineAgent({
	name: 'writer',
	identity: 'Answers and summarizes.',
	executor: pi({ instructions: 'Keep the answer concise.', model: 'scripted/writer' }),
});

function assertRoomCalls(room: RoomProtocol): void {
	expectTypeOf<keyof RoomProtocol>().toEqualTypeOf<'view' | 'commit' | 'lease'>();
	expect(Object.keys(room).sort()).toEqual(['commit', 'lease', 'view']);
	expect(Object.getPrototypeOf(room)).toBe(Object.prototype);
}

const reply = (text: string, exerciseTool = false) =>
	scripted((context, _agent, call) => {
		if (isClosing(context)) return speak(`Summary: ${text}`);
		if (exerciseTool && call === 1) return seat(writer.name);
		return call === (exerciseTool ? 2 : 1) ? speak(text) : quiet();
	});

describe.each(['direct', 'json'] as const)('executor boundary over %s calls', (mode) => {
	it('passes only room calls and preserves room-local execution and notifications', async () => {
		const connections: Array<{ room: RoomProtocol; context: AgentExecutionContext }> = [];
		const local = inProcessTransport();
		const observed: Transport = {
			connect(room, context) {
				connections.push({ room, context });
				return local.connect(room, context);
			},
		};
		let defaultCalls = 0;
		const runtime = createRuntime({
			transport: mode === 'json' ? serializing(observed) : observed,
			execution: piExecution({
				sessions: 'memory',
				stream: scripted(() => {
					defaultCalls += 1;
					return quiet();
				}),
			}),
		});
		const room = stopAtEnd(
			await startRoom({
				name: roomName('executor-boundary'),
				agents: [writer],
				summary: writer.name,
				runtime,
				execution: piExecution({ sessions: 'memory', stream: reply('Room override.', true) }),
			}),
		);
		const events = collect(room);
		const exchange = await (await room.visit(andrei)).send({ text: 'Answer this.' });
		await expect(exchange.waitForSummary()).resolves.toMatchObject({
			text: 'Summary: Room override.',
		});
		await waitForRoom(room, 'quiet', 2_000);
		expect(defaultCalls).toBe(0);
		expect(connections).toHaveLength(1);
		const connection = connections[0];
		if (connection === undefined) throw new Error('No executor connected.');
		assertRoomCalls(connection.room);
		expect(connection.room).not.toBe(room);
		expect(connection.context).toMatchObject({ room: room.name, seat: writer.name });
		expect(connection.context.definition).toEqual(writer);
		expect(connection.context.executor).toBeDefined();
		expect(connection.context).not.toHaveProperty('runtime');
		expect(connection.context).not.toHaveProperty('evict');
		const { view } = connection.room;
		await expect(view('unknown')).resolves.toHaveProperty('stale');
		expect(events.filter((event) => event.type === 'tool_execution_start')).toEqual([
			expect.objectContaining({ agent: writer.name, toolName: 'seat' }),
		]);
		expect(events.filter((event) => event.type === 'error')).toEqual([]);
	});
});

describe.each(storages)('executor lifecycle on $name', (storage) => {
	it('keeps live snapshot reads ordered after a pending room write', async () => {
		const opened = await storage.open();
		const blocked = deferred();
		const release = deferred();
		let hold = false;
		const runtime = createRuntime({
			storage: {
				async open(name) {
					const journal = await opened.storage.open(name);
					return {
						read: journal.read.bind(journal),
						async append(entry, position) {
							if (hold) {
								hold = false;
								blocked.resolve();
								await release.promise;
							}
							return journal.append(entry, position);
						},
					};
				},
			},
		});
		const room = await startRoom({ name: roomName('executor-snapshot'), runtime });
		try {
			const visit = await room.visit(andrei);
			hold = true;
			const sending = visit.send({ text: 'Queued question.' });
			await blocked.promise;
			let readFinished = false;
			const reading = readRoom(room.name, { runtime }).then((snapshot) => {
				readFinished = true;
				return snapshot;
			});
			await tick();
			expect(readFinished).toBe(false);
			release.resolve();
			await sending;
			expect((await reading).messages).toContainEqual(
				expect.objectContaining({ text: 'Queued question.' }),
			);
		} finally {
			release.resolve();
			await room.stop();
			await opened.dispose();
		}
	});

	it('keeps a retired facade stale when the same runtime resumes the room', async () => {
		const opened = await storage.open();
		const runtime = createRuntime({ storage: opened.storage });
		const name = roomName('executor-resume');
		const first = await startRoom({
			name,
			agents: [writer],
			runtime,
			execution: piExecution({ sessions: 'memory', stream: reply('First run.') }),
		});
		let resumed: Awaited<ReturnType<typeof resumeRoom>> | undefined;
		try {
			const old = runningRoom(runtime, name);
			if (old === undefined) throw new Error('No running room.');
			assertRoomCalls(old);
			const firstExchange = await (await first.visit(andrei)).send({ text: 'First?' });
			await firstExchange.waitForClose();
			hostingOf(runtime).evict(name);
			expect(runningRoom(runtime, name)).toBeUndefined();
			resumed = await resumeRoom(name, {
				agents: [writer],
				runtime,
				execution: piExecution({ sessions: 'memory', stream: reply('New run.') }),
			});
			const current = runningRoom(runtime, name);
			expect(current).not.toBe(old);
			await expect(old.view('unknown')).resolves.toEqual({ stale: 'the room is gone' });
			const next = await (await resumed.visit(andrei)).send({ text: 'Next?' });
			expect(await next.waitForClose()).toContainEqual(
				expect.objectContaining({ text: 'New run.' }),
			);
		} finally {
			await resumed?.stop();
			await first.stop();
			await opened.dispose();
		}
	});
});
