/**
 * The scripted runs that write the golden journals. Each one drives a real
 * room on memory storage under a fake clock, so the journal holds only what
 * the runtime writes. `GOLDEN=write` runs them and saves the result.
 */

import type { JournalEntry } from '@ambionframework/journal';
import { pi, piExecution } from '../../../pi/src/index.ts';
import { hostingOf } from '../../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	type Room,
	resumeRoom,
	startRoom,
} from '../../src/index.ts';
import { type FakeClock, fakeClock } from '../../src/testing.ts';
import { roomName, storedOf, tick, waitForRoom } from './room.ts';
import {
	byAgent,
	callTool,
	contextText,
	isClosing,
	quiet,
	type Script,
	says,
	scripted,
	speak,
	summarise,
	toolResultTexts,
} from './scripted.ts';
import { memory } from './storage.ts';

const worker = defineAgent({
	name: 'worker',
	identity: 'Answers the question.',
	executor: pi({ instructions: 'answer the question', model: 'scripted/worker' }),
});
const checker = defineAgent({
	name: 'checker',
	identity: 'Checks the crew.',
	executor: pi({ instructions: 'check the crew', model: 'scripted/checker' }),
});
const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes a closing summary.',
	executor: pi({ instructions: 'summarise the discussion', model: 'scripted/assistant' }),
});
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });
const sam = defineHuman({ name: 'sam', identity: 'Site foreman.' });

/** What a scenario hands the driver: the room, and the clock that the room runs on. */
type Drive = (room: Room, clock: FakeClock) => Promise<void>;

interface Setup {
	readonly agents: (typeof worker)[];
	readonly summary?: string;
	readonly seats: Record<string, 'broadcast' | 'named' | 'none'>;
	readonly stream: Parameters<typeof scripted>[0];
	readonly attempts?: number;
	readonly drive: Drive;
}

async function record(setup: Setup): Promise<readonly JournalEntry[]> {
	const opened = await memory.open();
	const clock = fakeClock();
	const runtime = createRuntime({
		storage: opened.storage,
		clock,
		limits: { activation: { attempts: setup.attempts ?? 3, backoff: () => 0 } },
	});
	const room = await startRoom({
		name: roomName('golden'),
		runtime,
		agents: setup.agents,
		...(setup.summary === undefined ? {} : { summary: setup.summary }),
		seats: setup.seats,
		execution: piExecution({ sessions: 'memory', stream: scripted(setup.stream) }),
	});
	try {
		await setup.drive(room, clock);
		await room.stop();
		return await storedOf(hostingOf(runtime).journals, room.name);
	} finally {
		await room.stop();
		await opened.dispose();
	}
}

const complete = (): Promise<readonly JournalEntry[]> =>
	record({
		agents: [worker, assistant],
		summary: assistant.name,
		seats: { worker: 'broadcast', assistant: 'none' },
		stream: byAgent({
			worker: says(['Thursday works.']),
			assistant: (context) => (isClosing(context) ? summarise('Thursday works.') : quiet()),
		}),
		async drive(room) {
			await (await room.visit(priya)).send({ text: 'Can I tell the client Thursday?' });
			await waitForRoom(room);
		},
	});

/**
 * The worker asks the checker, and answers when the checker replies. A
 * delivered say ends the pass.
 */
const asksTheChecker: Script = (context) => {
	if (context.messages.at(-1)?.role === 'toolResult') return quiet();
	if (contextText(context).includes('[checker → worker]')) return speak('Thursday works.');
	return speak('Is the crew free on Thursday?', 'checker');
};

/**
 * Two exchanges. In the first, the checker replies after the worker's first
 * activation ends. The reply wakes the worker again, and the second activation
 * continues the worker's session. The second exchange begins a fresh one.
 * Each ended activation records its session.
 */
function session(): Promise<readonly JournalEntry[]> {
	let ended = () => {};
	const workerEnded = new Promise<void>((resolve) => {
		ended = resolve;
	});
	const reply = says(['The crew is free on Thursday.'], 'worker');
	return record({
		agents: [worker, checker],
		seats: { worker: 'named', checker: 'named' },
		stream: byAgent({
			worker: asksTheChecker,
			checker: async (context, name, call) => {
				await workerEnded;
				await tick();
				return reply(context, name, call);
			},
		}),
		async drive(room) {
			room.subscribe((event) => {
				if (event.type === 'activation_end' && event.agent === worker.name) ended();
			});
			const person = await room.visit(priya);
			await person.send({ to: worker.name, text: 'Can I tell the client Thursday?' });
			await waitForRoom(room);
			await person.send({ to: worker.name, text: 'And Friday?' });
			await waitForRoom(room);
		},
	});
}

const awaiting = (): Promise<readonly JournalEntry[]> =>
	record({
		agents: [worker],
		seats: { worker: 'broadcast' },
		stream: byAgent({ worker: says(['Sam, can you confirm the slab?'], 'sam') }),
		async drive(room) {
			await room.visit(sam);
			await (await room.visit(priya)).send({ text: 'Is the slab poured?' });
			await waitForRoom(room);
		},
	});

const cancelled = (): Promise<readonly JournalEntry[]> =>
	record({
		agents: [worker],
		seats: { worker: 'broadcast' },
		stream: () => new Promise<never>(() => {}),
		async drive(room) {
			await (await room.visit(priya)).send({ text: 'Is the slab poured?' });
			await tick();
			await tick();
			await room.abort();
		},
	});

const exhausted = (): Promise<readonly JournalEntry[]> =>
	record({
		agents: [worker],
		seats: { worker: 'named' },
		attempts: 1,
		stream: () => {
			throw new Error('400 Your credit balance is too low to make this request');
		},
		async drive(room) {
			await (await room.visit(priya)).send({ to: worker.name, text: 'Answer me.' });
			await waitForRoom(room);
		},
	});

/**
 * The worker schedules a check, and answers when the check comes back. A
 * delivered say or a scheduled one ends the pass.
 */
const checksLater: Script = (context) => {
	if (context.messages.at(-1)?.role === 'toolResult') return quiet();
	if (contextText(context).includes('[returned → worker')) return speak('The slab is poured.');
	return callTool('say', { to: worker.name, text: 'Check the pour log.', after: 600 });
};

/**
 * A scheduled say. The first exchange closes while the say waits. The room
 * returns it when it is due, and the returned entry opens a second exchange
 * for the same owner. The assistant summarises each exchange for her.
 */
const scheduled = (): Promise<readonly JournalEntry[]> =>
	record({
		agents: [worker, assistant],
		summary: assistant.name,
		seats: { worker: 'broadcast', assistant: 'none' },
		stream: byAgent({
			worker: checksLater,
			assistant: (context) =>
				isClosing(context) ? summarise('The worker checks the pour later.') : quiet(),
		}),
		async drive(room, clock) {
			await (await room.visit(priya)).send({ text: 'Is the slab poured?' });
			await waitForRoom(room);
			await clock.advance(600_000);
			await waitForRoom(room);
		},
	});

/**
 * The worker schedules two checks, then dismisses the first by the handle
 * that its say result names.
 */
const changesItsMind: Script = (context) => {
	const results = toolResultTexts(context);
	const [first] = results.flatMap((text) => /^scheduled (\d+):/.exec(text)?.[1] ?? []);
	if (results.length === 0)
		return callTool('say', { to: worker.name, text: 'Check the pour log.', after: 600 });
	if (results.length === 1)
		return callTool('say', { to: worker.name, text: 'Check the crane log.', after: 1200 });
	if (results.length === 2) return callTool('dismiss', { handle: Number(first) });
	return quiet();
};

/**
 * Two scheduled says and two dismissals. The worker dismisses its first say
 * with the dismiss tool, and the host dismisses the second with
 * `room.dismiss`. The room returns neither.
 */
const dismissed = (): Promise<readonly JournalEntry[]> =>
	record({
		agents: [worker],
		seats: { worker: 'broadcast' },
		stream: byAgent({ worker: changesItsMind }),
		async drive(room, clock) {
			await (await room.visit(priya)).send({ text: 'Is the slab poured?' });
			await waitForRoom(room);
			for (const say of await room.scheduled()) await room.dismiss(say.seq);
			await clock.advance(1_200_000);
			await waitForRoom(room);
		},
	});

/** A room that stops and resumes: two runs, and the second fences the first. */
async function resumed(): Promise<readonly JournalEntry[]> {
	const opened = await memory.open();
	const clock = fakeClock();
	const runtime = () =>
		createRuntime({
			storage: opened.storage,
			clock,
			limits: { activation: { attempts: 3, backoff: () => 0 } },
		});
	const execution = piExecution({
		sessions: 'memory',
		stream: scripted(byAgent({ worker: says(['Thursday works.']) })),
	});
	const first = runtime();
	const room = await startRoom({
		name: roomName('golden'),
		runtime: first,
		agents: [worker],
		seats: { worker: 'broadcast' },
		execution,
	});
	let again: Room | undefined;
	try {
		await (await room.visit(priya)).send({ text: 'Can I tell the client Thursday?' });
		await waitForRoom(room);
		await room.stop();
		again = await resumeRoom(room.name, { runtime: runtime(), agents: [worker], execution });
		await waitForRoom(again);
		await again.stop();
		return await storedOf(hostingOf(first).journals, room.name);
	} finally {
		await again?.stop();
		await room.stop();
		await opened.dispose();
	}
}

/** Every golden scenario, by fixture name. */
export const goldenScenarios: Readonly<Record<string, () => Promise<readonly JournalEntry[]>>> = {
	complete,
	awaiting,
	scheduled,
	dismissed,
	cancelled,
	exhausted,
	resumed,
	session,
};
