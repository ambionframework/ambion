/** Independent execution checks for the Task contract in docs/tasks.md. */
import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { createRuntime, defineAgent, startRoom } from '../src/index.ts';
import { inProcessTransport, type Transport } from '../src/transport.ts';
import { andrei, deferred, roomName } from './support/room.ts';
import { callTool, contextText, quiet, type Script, scripted } from './support/scripted.ts';
import { storages } from './support/storage.ts';

interface TaskReference {
	task: string;
	room: string;
}

/** Read the public creation result that the model receives. */
function createdTask(context: Context): TaskReference | undefined {
	for (const message of [...context.messages].reverse()) {
		if (message.role !== 'toolResult' || message.toolName !== 'task' || message.isError) continue;
		const text = message.content
			.flatMap((part) => (part.type === 'text' ? [part.text] : []))
			.join('');
		const result: unknown = JSON.parse(text);
		if (typeof result !== 'object' || result === null) throw new Error('Invalid Task result.');
		const task: unknown = Reflect.get(result, 'task');
		const room: unknown = Reflect.get(result, 'room');
		if (typeof task !== 'string' || typeof room !== 'string')
			throw new Error('Missing Task reference.');
		return { task, room };
	}
	return undefined;
}

function definition(name: string) {
	return defineAgent({
		name,
		identity: name,
		instructions: 'Follow the assignment.',
		model: `scripted/${name}`,
	});
}

/** Give each actual room/seat execution its own deterministic model. */
function controlledTransport(scriptFor: (room: string, seat: string) => Script): Transport {
	const local = inProcessTransport();
	return {
		connect(calls, context) {
			return local.connect(calls, {
				...context,
				stream: scripted(scriptFor(context.room, context.seat)),
			});
		},
	};
}

function success(task: string, text: string) {
	return callTool('task_update', { task, status: 'succeeded', text });
}

function countUpdates(context: Context, seen: Set<string>): number {
	for (const message of context.messages) {
		if (message.role === 'toolResult' && message.toolName === 'task_update' && !message.isError) {
			seen.add(message.toolCallId);
		}
	}
	return seen.size;
}

function sameNameScenario(name: string) {
	const referenceReady = deferred();
	let reference: TaskReference | undefined;
	let requested = false;
	let notified = false;
	const successful = new Set<string>();
	const worker: Script = async (context) => {
		await referenceReady.promise;
		if (reference === undefined) throw new Error('Task reference was not returned.');
		return countUpdates(context, successful) === 0
			? success(reference.task, 'Same-name child completed its assignment.')
			: quiet();
	};
	const owner: Script = (context) => {
		if (!requested) {
			requested = true;
			return callTool('task', { text: 'Complete the delegated assignment.', agents: ['owner'] });
		}
		const created = createdTask(context);
		if (created !== undefined) {
			reference = created;
			referenceReady.resolve();
		}
		notified ||= contextText(context).includes('Same-name child completed its assignment.');
		return quiet();
	};
	return {
		transport: controlledTransport((room) => (room === name ? owner : worker)),
		referenceReady,
		get reference() {
			return reference;
		},
		get notified() {
			return notified;
		},
	};
}

function sharedScenario(name: string) {
	const assignmentsReady = deferred();
	const workingAfterSettlement = deferred();
	const finishWorking = deferred();
	const refs: TaskReference[] = [];
	const successful = new Set<string>();
	let requested = 0;
	const worker: Script = async (context) => {
		await assignmentsReady.promise;
		const completed = countUpdates(context, successful);
		const next = refs[completed];
		if (next !== undefined) return success(next.task, `Completed assignment ${completed + 1}.`);
		workingAfterSettlement.resolve();
		await finishWorking.promise;
		return quiet();
	};
	const owner: Script = (context) => {
		const created = createdTask(context);
		if (created !== undefined && !refs.some((ref) => ref.task === created.task)) refs.push(created);
		if (requested === 0) {
			requested += 1;
			return callTool('task', { text: 'Complete assignment one.', agents: ['worker'] });
		}
		if (requested === 1 && refs[0] !== undefined) {
			requested += 1;
			return callTool('task', { text: 'Complete assignment two.', room: refs[0].room });
		}
		if (refs.length === 2) assignmentsReady.resolve();
		return quiet();
	};
	return {
		transport: controlledTransport((room) => (room === name ? owner : worker)),
		assignmentsReady,
		workingAfterSettlement,
		finishWorking,
		refs,
	};
}

describe.each(storages)('Task architecture review on $name', (storage) => {
	it('delivers a working agent outcome to its same-name owner', async () => {
		const opened = await storage.open();
		const name = roomName('task-same-name');
		const scenario = sameNameScenario(name);
		const { transport, referenceReady } = scenario;
		const runtime = createRuntime({
			storage: opened.storage,
			transport,
			stream: scripted(() => quiet()),
		});
		const room = await startRoom({ name, agents: [definition('owner')], runtime });
		try {
			const exchange = await (await room.visit(andrei)).send({ text: 'Delegate this work.' });
			await exchange.waitForClose();
			expect(scenario.reference).toBeDefined();
			expect(scenario.notified).toBe(true);
			expect(await room.read({ messages: false })).toMatchObject({
				tasks: [{ status: 'succeeded' }],
			});
		} finally {
			referenceReady.resolve();
			await room.stop();
			await opened.dispose();
		}
	});

	it('keeps the exchange open after shared Tasks settle until working execution ends', async () => {
		const opened = await storage.open();
		const name = roomName('task-shared-live');
		const { transport, assignmentsReady, workingAfterSettlement, finishWorking, refs } =
			sharedScenario(name);
		const runtime = createRuntime({
			storage: opened.storage,
			transport,
			stream: scripted(() => quiet()),
		});
		const room = await startRoom({
			name,
			agents: [definition('owner'), definition('worker')],
			seats: { owner: 'broadcast' },
			runtime,
		});
		try {
			const exchange = await (
				await room.visit(andrei)
			).send({ text: 'Delegate both assignments.' });
			await workingAfterSettlement.promise;
			const snapshot = await room.read({ messages: false });
			expect(refs[0]?.room).toBe(refs[1]?.room);
			expect(snapshot).toMatchObject({ tasks: [{ status: 'succeeded' }, { status: 'succeeded' }] });
			expect(snapshot.exchange?.from).toBe(exchange.from);
			finishWorking.resolve();
			await exchange.waitForClose();
		} finally {
			assignmentsReady.resolve();
			finishWorking.resolve();
			await room.stop();
			await opened.dispose();
		}
	});
});
