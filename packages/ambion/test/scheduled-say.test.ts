/**
 * A scheduled say, end to end: an agent calls `schedule` with `after`, the
 * exchange closes while the say waits, and the room gives the say back when
 * it is due. The returned entry opens an exchange with no person, and the
 * agent answers the person who asked. A room that stops or crashes
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
	later,
	type PiScript,
	quiet,
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
const checksLater: PiScript = (context) => {
	const last = toolResultTexts(context).at(-1);
	if (last !== undefined) results.push(last);
	if (last?.startsWith('said #') || last?.startsWith('scheduled')) return quiet();
	if (contextText(context).includes('[posted → worker, returns'))
		return speak('The build passed.', 'priya');
	return callTool('schedule', {
		text: 'Check the build.',
		refs: ['file:///builds/out.log'],
		after: AFTER,
	});
};

/**
 * The worker schedules a check, then dismisses the say by the handle that
 * the say result names. It tells the person in the same activation, so the
 * dismissal must not leave its say behind the record.
 */
const changesItsMind: PiScript = (context) => {
	const last = toolResultTexts(context).at(-1);
	if (last !== undefined) results.push(last);
	const seq = /^scheduled #(\d+):/.exec(last ?? '')?.[1];
	if (seq !== undefined) return callTool('dismiss', { message: Number(seq) });
	if (last?.startsWith('dismissed')) return speak('I dropped the check.', 'priya');
	if (last !== undefined) return quiet();
	return later('Check the build.', AFTER);
};

const kinds = (messages: readonly Message[]) =>
	messages.flatMap((message) => (message.kind === 'arrived' ? [] : [message.kind]));

describe.each(storages)('a scheduled say on $name', (storage) => {
	const setup = async () => {
		results.length = 0;
		const opened = await openFor(storage);
		const clock = fakeClock();
		const runtime = () => createRuntime({ clock, storage: opened.storage });
		return { clock, runtime };
	};
	const start = async (runtime: Runtime, script: PiScript = checksLater) =>
		stopAtEnd(
			await startRoom({
				name: roomName('scheduled'),
				runtime,
				agents: [worker],
				seats: { worker: 'broadcast' },
				execution: piExecution({ sessions: 'memory', stream: scripted(script) }),
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

	it('closes the exchange while the say waits, and returns it into an exchange with no person', async () => {
		const { clock, runtime } = await setup();
		const room = await start(runtime());
		const first = await (await room.visit(priya)).send({ text: 'Is the build green?' });
		await first.waitForClose();
		const [say] = stateOf(room).scheduled;
		expect(say).toMatchObject({ seat: 'worker', text: 'Check the build.' });
		const due = new Date(clock.now() + AFTER * 1000).toISOString();
		expect(results).toContain(
			`scheduled #${say?.seq}: the room wakes you with this message at ${due}`,
		);
		expect((await room.read({ messages: false })).scheduled).toEqual([
			{
				seq: say?.seq,
				seat: 'worker',
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
		expect(kinds(messages)).toEqual(['said', 'said', 'posted', 'said']);
		const returned = messages.find((message) => message.kind === 'posted');
		expect(returned).toMatchObject({
			to: 'worker',
			returns: say?.seq,
			text: 'Check the build.',
			refs: ['file:///builds/out.log'],
			wakes: ['worker'],
		});
		const second = room.exchange(returned?.seq ?? 0);
		expect(second).toMatchObject({ from: returned?.seq });
		expect(second).not.toHaveProperty('person');
		await expect(second?.waitForClose()).resolves.toMatchObject([
			{ kind: 'posted', returns: say?.seq },
			{ kind: 'said', from: 'worker', to: 'priya', text: 'The build passed.' },
		]);
		const after = await room.read({ messages: false });
		expect(after.scheduled).toEqual([]);
		// The answer to priya in an exchange that no person opened waits on her.
		const closed = after.exchanges.find((exchange) => exchange.from === returned?.seq);
		expect(closed).toMatchObject({ outcome: { kind: 'awaiting', person: 'priya' } });
		expect(closed).not.toHaveProperty('person');
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
		expect(read.scheduled).toMatchObject([{ seat: 'worker' }]);
		await clock.advance(stopped);
		const resumed = await resume(room, runtime());
		await clock.advance(AFTER * 1000);
		await waitForRoom(resumed);
		const { messages } = await resumed.read({ messages: {} });
		expect(kinds(messages).filter((kind) => kind === 'posted')).toHaveLength(1);
		expect(messages.at(-1)).toMatchObject({ from: 'worker', text: 'The build passed.' });
	});

	it.each([
		['the seat, with the dismiss tool', 'seat'],
		['the host, with room.dismiss', 'host'],
	] as const)('never returns a say that %s dismisses', async (_case, by) => {
		const { clock, runtime } = await setup();
		const room = await start(runtime(), by === 'seat' ? changesItsMind : checksLater);
		await (await (await room.visit(priya)).send({ text: 'Is the build green?' })).waitForClose();
		if (by === 'host') {
			const [say] = (await room.read({ messages: false })).scheduled;
			expect(say).toMatchObject({ seat: 'worker' });
			expect(await room.dismiss(say?.seq ?? 0)).toBe(true);
			expect(await room.dismiss(say?.seq ?? 0)).toBe(false);
		}
		expect((await room.read({ messages: false })).scheduled).toEqual([]);
		await clock.advance(AFTER * 1000);
		await waitForRoom(room);
		const { messages } = await room.read({ messages: {} });
		const dismissed = messages.find((message) => message.kind === 'dismissed');
		if (by === 'seat') {
			expect(kinds(messages)).toEqual(['said', 'said', 'dismissed', 'said']);
			expect(dismissed).toMatchObject({ from: 'worker' });
			// The result names the say it dismissed, the seq that its schedule result gave.
			const scheduled = dismissed?.kind === 'dismissed' ? dismissed.message : 0;
			expect(results).toContain(`dismissed #${scheduled}`);
			expect(results.at(-1)).toMatch(/^said #\d+ to priya$/);
		} else {
			expect(kinds(messages)).toEqual(['said', 'said', 'dismissed']);
			expect(dismissed).not.toHaveProperty('from');
		}
	});
});
