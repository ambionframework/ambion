/**
 * A scheduled say, end to end: an agent says to itself with `after`, the
 * exchange closes while the say waits, and the room gives the say back when
 * it is due. The returned entry opens an exchange for the person who owned
 * the first one, and the agent answers them. A room that stops or crashes
 * before the say is due, or while it is overdue, returns it once when it
 * resumes.
 */
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	createRuntime,
	defineHuman,
	type Message,
	type Room,
	type Runtime,
	readRoom,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { crash, roomName, scriptedAgent, stateOf, waitForRoom } from './support/room.ts';
import {
	callTool,
	contextText,
	quiet,
	type Script,
	scripted,
	speak,
	toolResultTexts,
} from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { storages } from './support/storage.ts';

const worker = scriptedAgent('worker');
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });
const AFTER = 600;

/**
 * The worker starts a check on a question, and answers when the check comes
 * back. A delivered say or a scheduled one ends the activation.
 */
const results: string[] = [];
const checksLater: Script = (context) => {
	const last = toolResultTexts(context).at(-1);
	if (last !== undefined) results.push(last);
	if (last === 'delivered' || last?.startsWith('scheduled')) return quiet();
	if (contextText(context).includes('[returned → worker'))
		return speak('The build passed.', 'priya');
	return callTool('say', {
		to: 'worker',
		text: 'Check the build.',
		refs: ['file:///builds/out.log'],
		after: AFTER,
	});
};

const kinds = (messages: readonly Message[]) =>
	messages.flatMap((message) => (message.kind === 'arrived' ? [] : [message.kind]));

describe.each(storages)('a scheduled say on $name', (storage) => {
	const setup = async () => {
		const opened = await openFor(storage);
		const clock = fakeClock();
		const runtime = () => createRuntime({ clock, storage: opened.storage });
		return { clock, runtime };
	};
	const start = async (runtime: Runtime) =>
		stopAtEnd(
			await startRoom({
				name: roomName('scheduled'),
				runtime,
				agents: [worker],
				seats: { worker: 'broadcast' },
				execution: piExecution({ sessions: 'memory', stream: scripted(checksLater) }),
			}),
		);
	const resume = async (room: Room, runtime: Runtime) =>
		stopAtEnd(
			await resumeRoom(room.name, {
				runtime,
				agents: [worker],
				execution: piExecution({ sessions: 'memory', stream: scripted(checksLater) }),
			}),
		);

	it('closes the exchange while the say waits, and returns it for the owner when it is due', async () => {
		const { clock, runtime } = await setup();
		const room = await start(runtime());
		const first = await (await room.visit(priya)).send({ text: 'Is the build green?' });
		await first.waitForClose();
		const [say] = stateOf(room).scheduled;
		expect(say).toMatchObject({ seat: 'worker', owner: 'priya', text: 'Check the build.' });
		const due = new Date(clock.now() + AFTER * 1000).toISOString();
		expect(results).toContain(
			`scheduled ${say?.seq}: the room gives this say back to you at ${due}`,
		);
		expect((await room.read({ messages: false })).scheduled).toEqual([
			{
				seq: say?.seq,
				seat: 'worker',
				owner: 'priya',
				due: new Date(clock.now() + AFTER * 1000).toISOString(),
				text: 'Check the build.',
				refs: ['file:///builds/out.log'],
			},
		]);

		// The room's own alarm returns the say: nothing here calls reconcile.
		const opened = new Promise<number>((resolve) => {
			const off = room.subscribe((event) => {
				if (event.type !== 'exchange_opened') return;
				off();
				resolve(event.exchange.from);
			});
		});
		await clock.advance(AFTER * 1000 - 1);
		expect(stateOf(room).scheduled).toHaveLength(1);
		await clock.advance(1);
		const from = await opened;
		await room.exchange(from)?.waitForClose();
		const { messages } = await room.read({ messages: {} });
		expect(kinds(messages)).toEqual(['said', 'said', 'returned', 'said']);
		const returned = messages.find((message) => message.kind === 'returned');
		expect(returned).toMatchObject({
			to: 'worker',
			message: say?.seq,
			owner: 'priya',
			text: 'Check the build.',
			refs: ['file:///builds/out.log'],
			wakes: ['worker'],
		});
		const second = room.exchange(returned?.seq ?? 0);
		expect(second).toMatchObject({ owner: 'priya', from: returned?.seq });
		await expect(second?.waitForClose()).resolves.toMatchObject([
			{ kind: 'returned' },
			{ kind: 'said', from: 'worker', to: 'priya', text: 'The build passed.' },
		]);
		expect((await room.read({ messages: false })).scheduled).toEqual([]);
	});

	it.each([
		['a stop before the say is due', 'stop', AFTER * 500],
		['a stop while the say is overdue', 'stop', AFTER * 2000],
		['a crash before the say is due', 'crash', AFTER * 500],
		['a crash while the say is overdue', 'crash', AFTER * 2000],
	] as const)('returns the say once after %s', async (_case, end, stopped) => {
		const { clock, runtime } = await setup();
		const first = runtime();
		const room = await start(first);
		await (await (await room.visit(priya)).send({ text: 'Is the build green?' })).waitForClose();
		if (end === 'stop') await room.stop();
		else crash(first, room);
		const read = await readRoom(room.name, { runtime: runtime() });
		expect(read.scheduled).toMatchObject([{ seat: 'worker', owner: 'priya' }]);
		await clock.advance(stopped);
		const resumed = await resume(room, runtime());
		await clock.advance(AFTER * 1000);
		await waitForRoom(resumed);
		const { messages } = await resumed.read({ messages: {} });
		expect(kinds(messages).filter((kind) => kind === 'returned')).toHaveLength(1);
		expect(messages.at(-1)).toMatchObject({ from: 'worker', text: 'The build passed.' });
	});
});
