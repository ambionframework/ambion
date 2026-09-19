import { describe, expect, it } from 'vitest';
import { createRuntime, defineAgent, startRoom } from '../src/index.ts';
import { inProcessTransport, type Transport } from '../src/transport.ts';
import { andrei, roomName } from './support/room.ts';
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

function routed(owner: Script, worker: Script): Transport {
	const local = inProcessTransport();
	return {
		connect(calls, context) {
			return local.connect(calls, {
				...context,
				stream: scripted(context.seat === 'owner' ? owner : worker),
			});
		},
	};
}

function taskId(context: Parameters<Script>[0]): string | undefined {
	return contextText(context).match(/Task (task-[a-z0-9-]+) \(/)?.[1];
}

async function openScenario(storage: (typeof storages)[number], owner: Script, worker: Script) {
	const opened = await storage.open();
	const room = await startRoom({
		name: roomName('task-idle-e2e'),
		agents: [agent('owner'), agent('worker')],
		seats: { owner: 'broadcast' },
		runtime: createRuntime({
			storage: opened.storage,
			transport: routed(owner, worker),
			stream: scripted(() => quiet()),
		}),
	});
	const exchange = await (await room.visit(andrei)).send({ text: 'Delegate this.' });
	return { opened, room, exchange };
}

describe.each(storages)('Task idle intervention ($name)', (storage) => {
	it('fails an open Task after the owner consumes an idle request and stays quiet', async () => {
		let created = false;
		const owner: Script = () => {
			if (!created) {
				created = true;
				return callTool('task', {
					text: 'Complete the delegated work.',
					agents: ['worker'],
				});
			}
			return quiet();
		};
		const { opened, room, exchange } = await openScenario(storage, owner, () => quiet());
		try {
			await expect
				.poll(async () => (await room.read({ messages: false })).tasks[0]?.status)
				.toBe('failed');
			const snapshot = await room.read({ messages: false });
			expect(snapshot.tasks[0]?.outcome).toBe('Owner did not resolve the intervention request.');
			await exchange.waitForClose();
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('fails when the owner reports progress without sending instructions or settling', async () => {
		let created = false;
		let progressed = false;
		const owner: Script = (context) => {
			if (!created) {
				created = true;
				return callTool('task', { text: 'Complete the delegated work.', agents: ['worker'] });
			}
			const task = taskId(context);
			if (
				!progressed &&
				task !== undefined &&
				contextText(context).includes('working room is idle')
			) {
				progressed = true;
				return callTool('task_update', { task, text: 'Still checking.' });
			}
			return quiet();
		};
		const { opened, room } = await openScenario(storage, owner, () => quiet());
		try {
			await expect
				.poll(async () => (await room.read({ messages: false })).tasks[0]?.status)
				.toBe('failed');
			expect((await room.read({ messages: false })).tasks[0]?.outcome).toBe(
				'Owner did not resolve the intervention request.',
			);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('starts new work when the owner steers an idle Task', async () => {
		let created = false;
		let steered = false;
		let idleResolve!: () => void;
		const idleSeen = new Promise<void>((resolve) => {
			idleResolve = resolve;
		});
		let continueResolve!: () => void;
		const continueOwner = new Promise<void>((resolve) => {
			continueResolve = resolve;
		});
		const owner: Script = async (context) => {
			if (!created) {
				created = true;
				return callTool('task', { text: 'Complete the delegated work.', agents: ['worker'] });
			}
			const task = taskId(context);
			if (!steered && task !== undefined && contextText(context).includes('working room is idle')) {
				steered = true;
				idleResolve();
				await continueOwner;
				return callTool('say', { task, text: 'Continue now.' });
			}
			return quiet();
		};
		let workerUpdated = false;
		const worker: Script = (context) => {
			if (workerUpdated) return quiet();
			const task = taskId(context);
			if (task === undefined || !contextText(context).includes('Continue now.')) return quiet();
			workerUpdated = true;
			return callTool('task_update', { task, status: 'succeeded', text: 'Continued.' });
		};
		const { opened, room } = await openScenario(storage, owner, worker);
		try {
			await idleSeen;
			continueResolve();
			await expect
				.poll(async () => (await room.read({ messages: false })).tasks[0]?.status)
				.toBe('succeeded');
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('fails when the owner leaves after an idle request', async () => {
		let created = false;
		let idleResolve!: () => void;
		const idleSeen = new Promise<void>((resolve) => {
			idleResolve = resolve;
		});
		let releaseResolve!: () => void;
		const releaseOwner = new Promise<void>((resolve) => {
			releaseResolve = resolve;
		});
		const owner: Script = async (context) => {
			if (!created) {
				created = true;
				return callTool('task', { text: 'Complete the delegated work.', agents: ['worker'] });
			}
			if (contextText(context).includes('working room is idle')) {
				idleResolve();
				await releaseOwner;
			}
			return quiet();
		};
		const { opened, room } = await openScenario(storage, owner, () => quiet());
		try {
			await idleSeen;
			await room.unseat('owner');
			releaseResolve();
			await expect
				.poll(async () => (await room.read({ messages: false })).tasks[0]?.status)
				.toBe('failed');
			expect((await room.read({ messages: false })).tasks[0]?.outcome).toBe(
				'Task owner is no longer available.',
			);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});
});
