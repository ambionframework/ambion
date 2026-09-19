/** Adversarial lifecycle checks for durable Task ownership and recovery. */
import { describe, expect, it } from 'vitest';
import { createRuntime, defineAgent, readRoom, startRoom } from '../src/index.ts';
import { inProcessTransport, runningRoom } from '../src/transport.ts';
import { andrei, deferred, roomName } from './support/room.ts';
import { callTool, contextText, quiet, type Script, scripted } from './support/scripted.ts';
import { storages } from './support/storage.ts';

function agent(name: string) {
	return defineAgent({
		name,
		identity: name,
		instructions: 'Follow the Task assignment.',
		model: `scripted/${name}`,
	});
}

function taskId(context: Parameters<Script>[0]): string | undefined {
	return contextText(context).match(/Task (task-[a-z0-9-]+) \(/)?.[1];
}

describe.each(storages)('Adversarial Task lifecycle on $name storage', (storage) => {
	it('releases completed working rooms when the origin stops after exchange closure', async () => {
		const opened = await storage.open();
		const originName = roomName('task-adversarial-stop');
		let created = false;
		let completed = false;
		const owner: Script = () => {
			if (!created) {
				created = true;
				return callTool('task', {
					text: 'Complete and settle the delegated work.',
					agents: ['worker'],
				});
			}
			return quiet();
		};
		const worker: Script = (context) => {
			if (completed) return quiet();
			const task = taskId(context);
			if (task === undefined) return quiet();
			completed = true;
			return callTool('task_update', {
				task,
				status: 'succeeded',
				text: 'The delegated work is complete.',
			});
		};
		const local = inProcessTransport();
		const runtime = createRuntime({
			storage: opened.storage,
			stream: scripted(() => quiet()),
			transport: {
				connect(calls, context) {
					return local.connect(calls, {
						...context,
						stream: scripted(context.room === originName ? owner : worker),
					});
				},
			},
		});
		const room = await startRoom({
			name: originName,
			agents: [agent('owner'), agent('worker')],
			seats: { owner: 'broadcast' },
			runtime,
		});
		try {
			const exchange = await (await room.visit(andrei)).send({ text: 'Delegate this work.' });
			await exchange.waitForClose();
			const task = (await room.read({ messages: false })).tasks[0];
			if (task === undefined) throw new Error('The Task was not recorded.');
			expect(runningRoom(runtime, task.workingRoom)).toBeUndefined();

			await room.stop();
			expect(runningRoom(runtime, task.workingRoom)).toBeUndefined();
			expect((await readRoom(task.workingRoom, { runtime })).initialized).toBe(true);
		} finally {
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('releases a working room that is active when the origin stops', async () => {
		const opened = await storage.open();
		const originName = roomName('task-adversarial-stop-active');
		const workerStarted = deferred();
		const releaseWorker = deferred();
		let created = false;
		const owner: Script = () => {
			if (!created) {
				created = true;
				return callTool('task', {
					text: 'Keep this delegated work running until shutdown.',
					agents: ['worker'],
				});
			}
			return quiet();
		};
		const worker: Script = async (context) => {
			if (taskId(context) === undefined) return quiet();
			workerStarted.resolve();
			await releaseWorker.promise;
			return quiet();
		};
		const local = inProcessTransport();
		const runtime = createRuntime({
			storage: opened.storage,
			stream: scripted(() => quiet()),
			transport: {
				connect(calls, context) {
					return local.connect(calls, {
						...context,
						stream: scripted(context.room === originName ? owner : worker),
					});
				},
			},
		});
		const room = await startRoom({
			name: originName,
			agents: [agent('owner'), agent('worker')],
			seats: { owner: 'broadcast' },
			runtime,
		});
		try {
			await (await room.visit(andrei)).send({ text: 'Start and then stop this work.' });
			await workerStarted.promise;
			const task = (await room.read({ messages: false })).tasks[0];
			if (task === undefined) throw new Error('The Task was not recorded.');
			expect(runningRoom(runtime, task.workingRoom)).toBeDefined();

			const stopping = room.stop();
			await stopping;
			expect(runningRoom(runtime, task.workingRoom)).toBeUndefined();
		} finally {
			releaseWorker.resolve();
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});
});
