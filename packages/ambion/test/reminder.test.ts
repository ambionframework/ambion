import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type AgentSeat,
	defineAgent,
	defineHuman,
	defineTool,
	defineWorkspace,
	destroyWorkspace,
	directoryBackend,
	InMemorySessionRepo,
	isReminder,
	type Message,
	passive,
	type Reminder,
	type ReminderMessage,
	type Session,
	type SessionEvent,
	startSession,
	stopSession,
	visitSession,
	type WorkspaceHandle,
} from '../src/index.ts';
import { REMINDER_DIR } from '../src/just-bash.ts';
import { nextDue } from '../src/reminder.ts';

// -- scripted model ----------------------------------------------------------

type Script = (
	context: Context,
	agent: string,
	call: number,
) => AssistantMessage | Promise<AssistantMessage>;

/** A deterministic streamFn: routes on the agent's name, counts calls per agent. */
function scripted(script: Script): StreamFn {
	const calls = new Map<string, number>();
	return (_model, context) => {
		const stream = createAssistantMessageEventStream();
		const agent = /You are '([a-z0-9-]+)'/.exec(context.systemPrompt ?? '')?.[1] ?? 'unknown';
		const call = (calls.get(agent) ?? 0) + 1;
		calls.set(agent, call);
		const finish = (message: AssistantMessage) => {
			if (message.stopReason === 'error') {
				stream.push({ type: 'error', reason: message.stopReason, error: message });
			} else {
				stream.push({ type: 'start', partial: message });
				stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
			}
		};
		void (async () => {
			try {
				finish(await script(context, agent, call));
			} catch (error) {
				finish(fauxAssistantMessage('', { stopReason: 'error', errorMessage: String(error) }));
			}
		})();
		return stream;
	};
}

const byAgent = (seats: Record<string, Script>): Script => {
	const table = new Map(Object.entries(seats));
	return (context, agent, call) => (table.get(agent) ?? (() => quiet()))(context, agent, call);
};

const callTool = (tool: string, args: Record<string, unknown>) =>
	fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: 'toolUse' });

const quiet = (thought = 'nothing to add') => fauxAssistantMessage(thought, { stopReason: 'stop' });

/** Every tool result the model has been shown so far, oldest first. */
function toolResults(context: Context): { tool: string; text: string; failed: boolean }[] {
	return context.messages.flatMap((message) => {
		if (message.role !== 'toolResult') return [];
		const text = message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
		return [{ tool: message.toolName, text, failed: message.isError }];
	});
}

/** The user message the activation was opened with: the room as the seat read it. */
function contextOf(context: Context): string {
	const first = context.messages[0];
	return first?.role === 'user' && typeof first.content === 'string' ? first.content : '';
}

let unique = 0;
const name = (prefix: string) => `${prefix}-${++unique}`;

const assistant = defineAgent({
	name: 'andrei-assistant',
	identity: "andrei's assistant.",
	instructions: 'stay quiet',
	model: 'scripted/assistant',
});

const human = defineHuman({ name: 'andrei', identity: 'Founder.', assistant });

function agent(agentName: string, options: Partial<Parameters<typeof defineAgent>[0]> = {}) {
	return defineAgent({
		name: agentName,
		identity: 'Works in a workspace.',
		instructions: 'work',
		model: `scripted/${agentName}`,
		...options,
	});
}

/** A room that records who woke and what landed. */
interface Room {
	session: Session;
	woke: string[];
	events: SessionEvent[];
	landed: Message[];
}

function open(
	roomName: string,
	agents: AgentSeat[],
	seats: Record<string, Script>,
	repo?: InMemorySessionRepo,
): Room {
	const session = startSession({
		name: roomName,
		agents,
		streamFn: scripted(byAgent(seats)),
		...(repo === undefined ? {} : { repo }),
	});
	const room: Room = { session, woke: [], events: [], landed: [] };
	session.subscribe((event) => {
		room.events.push(event);
		if (event.type === 'activation_start') room.woke.push(event.agent);
		if (event.type === 'message') room.landed.push(event.message);
	});
	return room;
}

/** The next reminder to land on the record. Subscribe before advancing the clock. */
function nextReminder(session: Session): Promise<ReminderMessage> {
	return new Promise((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== 'message' || !isReminder(event.message)) return;
			off();
			resolve(event.message);
		});
	});
}

/** One person asks, and the room settles: the way every reminder here gets set. */
async function ask(room: Room, text = 'go'): Promise<void> {
	const visit = await visitSession(room.session, human);
	await visit.deliver({ text });
	await room.session.settled();
}

const remind = (args: Record<string, unknown>) => callTool('remind', args);

/** A seat that sets one reminder on its first activation and stays quiet after. */
const setter =
	(args: Record<string, unknown>, then: Script = () => quiet()): Script =>
	(context, who, call) =>
		call === 1 ? remind(args) : then(context, who, call);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const sites: WorkspaceHandle[] = [];
const site = (label = 'site') => {
	const handle = defineWorkspace({ name: name(label) });
	sites.push(handle);
	return handle;
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(async () => {
	vi.useRealTimers();
	for (const handle of sites.splice(0)) await destroyWorkspace(handle);
});

// -- setting and delivery ----------------------------------------------------

describe('a reminder', () => {
	it('lands when due as a message from the agent that set it, and wakes that agent alone', async () => {
		const drive = site();
		const room = open(
			name('room'),
			[
				agent('watcher', { workspace: drive }),
				agent('other', { workspace: drive }),
				agent('plain'),
			],
			{ watcher: setter({ text: 'Check that D-4471 landed.', after: '2h' }) },
		);
		await ask(room);
		expect(room.woke).toEqual(['watcher', 'other', 'plain']);

		const landing = nextReminder(room.session);
		await vi.advanceTimersByTimeAsync(HOUR);
		expect(room.landed.some(isReminder)).toBe(false);
		await vi.advanceTimersByTimeAsync(HOUR);
		const message = await landing;
		await room.session.settled();

		expect(message).toMatchObject({
			kind: 'reminder',
			from: 'watcher',
			text: 'Check that D-4471 landed.',
		});
		expect(Date.parse(message.at) - Date.parse(message.setAt)).toBe(2 * HOUR);
		// The owner woke for it, and nobody else did.
		expect(room.woke.slice(3)).toEqual(['watcher']);
		await stopSession(room.session);
	});

	it('tells the seat what it set, and what it read is the record line when it comes due', async () => {
		const drive = site();
		const reads: string[] = [];
		const results: string[] = [];
		const room = open(name('room'), [agent('watcher', { workspace: drive })], {
			watcher: (context, _who, call) => {
				reads.push(contextOf(context));
				results.push(...toolResults(context).map((r) => r.text));
				return call === 1 ? remind({ text: 'Ring the supplier.', after: '30m' }) : quiet();
			},
		});
		await ask(room);
		expect(results.at(-1)).toMatch(
			/^Set r-[0-9a-f]{8}: due .* \(in 30 minutes\)\. It reaches you alone/,
		);
		// What the seat reads once it is set: the pending list, and the paragraph.
		const landing = nextReminder(room.session);
		await vi.advanceTimersByTimeAsync(30 * MINUTE);
		await landing;
		await room.session.settled();
		const last = reads.at(-1) ?? '';
		expect(last).toContain('· reminder for watcher: Ring the supplier.');
		expect(last).toContain(
			'Your reminders (each reaches you alone, on the record, when it is due):\n(none set)',
		);
		await stopSession(room.session);
	});

	it("is listed in its owner's context while pending, and the paragraph reaches a seat that can set one", async () => {
		const drive = site();
		const reads = new Map<string, { prompt: string; context: string }>();
		const room = open(name('room'), [agent('watcher', { workspace: drive }), agent('plain')], {
			watcher: (context, who, call) => {
				reads.set(who, { prompt: context.systemPrompt ?? '', context: contextOf(context) });
				return call === 1 ? remind({ text: 'Look again.', after: '1h', every: '1d' }) : quiet();
			},
			plain: (context, who) => {
				reads.set(who, { prompt: context.systemPrompt ?? '', context: contextOf(context) });
				return quiet();
			},
		});
		await ask(room);
		await ask(room, 'again');
		const watcher = reads.get('watcher');
		expect(watcher?.prompt).toContain('Waiting is the remind tool.');
		expect(watcher?.context).toMatch(
			/Your reminders \(each reaches you alone, on the record, when it is due\):\n- r-[0-9a-f]{8}, due in 1 hour \(.*\), then every 1 day, set just now: Look again\./,
		);
		const plain = reads.get('plain');
		expect(plain?.prompt).not.toContain('remind tool');
		expect(plain?.context).not.toContain('Your reminders');
		await stopSession(room.session);
	});

	it('wakes an owner seated named, steers a colleague at work, and opens no exchange', async () => {
		const drive = site();
		const steered: string[] = [];
		const gate = Promise.withResolvers<void>();
		const room = open(
			name('room'),
			[passive(agent('corner', { workspace: drive })), agent('worker')],
			{
				corner: setter({ text: 'Now.', after: '10m' }),
				worker: async (context, _who, call) => {
					steered.push(
						...context.messages.flatMap((m) =>
							m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[new]')
								? [m.content]
								: [],
						),
					);
					// The first activation holds until the reminder lands; the steer
					// reaches the model on the turn after the held one.
					if (call === 1) await gate.promise;
					return quiet();
				},
			},
		);
		const visit = await visitSession(room.session, human);
		await visit.deliver({ to: agent('corner'), text: 'set one' });
		await room.session.settled();
		expect(room.woke).toEqual(['corner']);

		await visit.deliver({ text: 'keep working' }); // wakes the worker, which waits
		const landing = nextReminder(room.session);
		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		const message = await landing;
		gate.resolve();
		await room.session.settled();
		expect(room.woke.slice(1)).toEqual(['worker', 'corner']);
		expect(room.woke).toHaveLength(3);
		expect(steered).toEqual([`[new] · reminder for corner: ${message.text}`]);
		// The worker's exchange was andrei's; the reminder opened none of its own.
		const opened = room.events.filter((e) => e.type === 'exchange_opened');
		expect(opened.map((e) => (e.type === 'exchange_opened' ? e.exchange.owner : ''))).toEqual([
			'andrei',
			'andrei',
		]);
		expect(room.session.exchange()).toBeUndefined();
		await stopSession(room.session);
	});

	it('waits out a due time further away than one timer can hold', async () => {
		const drive = site();
		const at = new Date(Date.now() + 40 * 24 * HOUR).toISOString();
		const room = open(name('room'), [agent('watcher', { workspace: drive })], {
			watcher: setter({ text: 'Six weeks on.', at }),
		});
		await ask(room);
		const landing = nextReminder(room.session);
		await vi.advanceTimersByTimeAsync(39 * 24 * HOUR);
		expect(room.landed.some(isReminder)).toBe(false);
		await vi.advanceTimersByTimeAsync(24 * HOUR);
		expect((await landing).at).toBe(at);
		await stopSession(room.session);
	});
});

// -- refusals ----------------------------------------------------------------

describe('remind refuses', () => {
	const cases: [string, Record<string, unknown>, RegExp][] = [
		['an empty text', { text: ' ', after: '1h' }, /The reminder is empty/],
		['both at and after', { text: 'x', at: '2099-01-01T00:00:00Z', after: '1h' }, /exactly one/],
		['neither at nor after', { text: 'x' }, /exactly one/],
		['a time in the past', { text: 'x', at: '2000-01-01T00:00:00Z' }, /in the past/],
		['a time that is not ISO', { text: 'x', at: 'tomorrow' }, /not an ISO 8601 time/],
		['a duration with no unit', { text: 'x', after: '90' }, /'after' takes a count and a unit/],
		['a repeat under a minute', { text: 'x', after: '1h', every: '30s' }, /at least one minute/],
	];
	for (const [label, args, expected] of cases) {
		it(label, async () => {
			const drive = site();
			let result: { text: string; failed: boolean } | undefined;
			const room = open(name('room'), [agent('watcher', { workspace: drive })], {
				watcher: (context, _who, call) => {
					result = toolResults(context).at(-1);
					return call === 1 ? remind(args) : quiet();
				},
			});
			await ask(room);
			expect(result?.failed).toBe(true);
			expect(result?.text).toMatch(expected);
			await vi.advanceTimersByTimeAsync(2 * HOUR);
			expect(room.landed.some(isReminder)).toBe(false);
			await stopSession(room.session);
		});
	}
});

// -- cancelling and repeating ------------------------------------------------

describe('cancel_reminder', () => {
	it("removes one of the owner's reminders, and refuses an id that is not theirs", async () => {
		const drive = site();
		const results: { tool: string; text: string; failed: boolean }[] = [];
		const room = open(
			name('room'),
			[agent('watcher', { workspace: drive }), agent('other', { workspace: drive })],
			{
				watcher: (context, _who, call) => {
					results.push(...toolResults(context).slice(results.length));
					if (call === 1) return remind({ text: 'Soon.', after: '5m' });
					if (call === 2) {
						const id = /Set (r-[0-9a-f]{8})/.exec(results[0]?.text ?? '')?.[1] ?? '';
						return callTool('cancel_reminder', { id });
					}
					return quiet();
				},
				other: (_context, _who, call) =>
					call === 1 ? callTool('cancel_reminder', { id: 'r-00000000' }) : quiet(),
			},
		);
		await ask(room);
		expect(results.map((r) => [r.tool, r.failed])).toEqual([
			['remind', false],
			['cancel_reminder', false],
		]);
		expect(results[1]?.text).toBe('cancelled');
		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		expect(room.landed.some(isReminder)).toBe(false);
		await stopSession(room.session);
	});
});

describe('a repeating reminder', () => {
	it('is delivered at each interval, and stays in the store with its next due', async () => {
		const drive = site();
		let listed: Reminder[] = [];
		const list = defineTool({
			name: 'list_mine',
			description: 'List my reminders.',
			parameters: Type.Object({}),
			execute: async (_params, ctx) => {
				listed = (await (await ctx.workspace())?.reminders.list()) ?? [];
				return String(listed.length);
			},
		});
		const room = open(name('room'), [agent('watcher', { workspace: drive, tools: [list] })], {
			// Sets it once; every later activation lists once, then ends.
			watcher: (context, _who, call) => {
				if (call === 1) return remind({ text: 'Every minute.', after: '1m', every: '1m' });
				return toolResults(context).at(-1)?.tool === 'list_mine'
					? quiet()
					: callTool('list_mine', {});
			},
		});
		await ask(room);
		for (let n = 1; n <= 3; n += 1) {
			const landing = nextReminder(room.session);
			await vi.advanceTimersByTimeAsync(MINUTE);
			await landing;
			await room.session.settled();
			expect(room.landed.filter(isReminder)).toHaveLength(n);
			expect(listed).toHaveLength(1);
			expect(Date.parse(listed[0]?.due ?? '')).toBe(Date.now() + MINUTE);
		}
		await stopSession(room.session);
	});

	it('takes the first due after now on its own grid, however many it missed', () => {
		const due = Date.parse('2026-09-02T10:00:00Z');
		const reminder: Reminder = {
			id: 'r-1',
			owner: 'a',
			session: 's',
			text: 't',
			due: new Date(due).toISOString(),
			every: HOUR,
			setAt: new Date(due - HOUR).toISOString(),
		};
		expect(nextDue(reminder, due)).toBe('2026-09-02T11:00:00.000Z');
		expect(nextDue(reminder, due + 30 * MINUTE)).toBe('2026-09-02T11:00:00.000Z');
		expect(nextDue(reminder, due + 5 * HOUR)).toBe('2026-09-02T16:00:00.000Z');
		expect(nextDue(reminder, due - 5 * HOUR)).toBe('2026-09-02T10:00:00.000Z');
	});
});

// -- across runs -------------------------------------------------------------

describe('across runs', () => {
	it('survives a stop, is delivered at once when the next run finds it due, and waits for a run that seats its owner', async () => {
		const drive = site();
		const repo = new InMemorySessionRepo();
		const roomName = name('room');
		const watcher = agent('watcher', { workspace: drive });
		const first = open(
			roomName,
			[watcher],
			{ watcher: setter({ text: 'Later.', after: '1h' }) },
			repo,
		);
		await ask(first);
		await stopSession(first.session);

		await vi.advanceTimersByTimeAsync(2 * HOUR);
		// A run that does not seat the owner leaves the reminder in its store.
		const without = open(roomName, [agent('other', { workspace: drive })], {}, repo);
		await without.session.settled();
		await vi.advanceTimersByTimeAsync(HOUR);
		expect(without.landed).toEqual([]);
		await stopSession(without.session);

		// A run that seats it delivers the overdue reminder before `settled()` resolves.
		const second = open(roomName, [watcher], {}, repo);
		await second.session.settled();
		expect(second.landed.filter(isReminder)).toMatchObject([{ from: 'watcher', text: 'Later.' }]);
		expect(second.woke).toEqual(['watcher']);
		// Delivered once: a third run finds nothing.
		await stopSession(second.session);
		const third = open(roomName, [watcher], {}, repo);
		await third.session.settled();
		await vi.advanceTimersByTimeAsync(HOUR);
		expect(third.landed).toEqual([]);
		await stopSession(third.session);
	});

	it('is delivered nowhere once its workspace is destroyed', async () => {
		const drive = defineWorkspace({ name: name('gone') });
		const room = open(name('room'), [agent('watcher', { workspace: drive })], {
			watcher: setter({ text: 'Nobody home.', after: '1h' }),
		});
		await ask(room);
		await destroyWorkspace(drive);
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(room.landed.some(isReminder)).toBe(false);
		expect(room.events.some((e) => e.type === 'error')).toBe(false);
		await stopSession(room.session);
	});

	it('is a file under the directory backend, and a new handle over the same root finds it', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-reminders-'));
		const drive = defineWorkspace({ name: name('disk'), backend: directoryBackend(root) });
		const room = open(name('room'), [agent('watcher', { workspace: drive })], {
			watcher: setter({ text: 'On disk.', after: '1h' }),
		});
		await ask(room);
		await stopSession(room.session);
		const dir = join(root, REMINDER_DIR);
		const files = await readdir(dir);
		expect(files).toHaveLength(1);
		const stored = JSON.parse(await readFile(join(dir, files[0] ?? ''), 'utf8')) as Reminder;
		expect(stored).toMatchObject({
			owner: 'watcher',
			session: room.session.name,
			text: 'On disk.',
		});
		// The name is not the durable identity here; the root is. Destroy leaves the root and empties it.
		await destroyWorkspace(drive);
		expect(await readdir(root)).toEqual([]);
	});
});

// -- from a custom tool ------------------------------------------------------

describe('Workspace.reminders', () => {
	it("lets a custom tool set, list and cancel the calling agent's reminders, armed in this run", async () => {
		const drive = site();
		const seen: string[] = [];
		const schedule = defineTool({
			name: 'schedule',
			description: 'Set a reminder from inside a domain tool.',
			parameters: Type.Object({ text: Type.String() }),
			execute: async ({ text }, ctx) => {
				const workspace = await ctx.workspace();
				if (!workspace) return 'no workspace';
				const set = await workspace.reminders.set({ text, after: '15m' });
				const mine = await workspace.reminders.list();
				seen.push(`${set.owner} ${set.session} ${mine.length}`);
				return set.id;
			},
		});
		const room = open(name('room'), [agent('watcher', { workspace: drive, tools: [schedule] })], {
			watcher: (_context, _who, call) =>
				call === 1 ? callTool('schedule', { text: 'Booked.' }) : quiet(),
		});
		await ask(room);
		expect(seen).toEqual([`watcher ${room.session.name} 1`]);
		const landing = nextReminder(room.session);
		await vi.advanceTimersByTimeAsync(15 * MINUTE);
		expect((await landing).text).toBe('Booked.');
		await stopSession(room.session);
	});
});
