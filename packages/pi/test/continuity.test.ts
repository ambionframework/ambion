/**
 * Exchange continuity. The executor reopens the Pi session the room names in
 * `spec.resume`, sends the delta as the input of the pass, and records the
 * session on every release. A view that names no session, or names one the
 * store cannot open, begins a fresh one. The session cases run on sessions in
 * memory and on sessions on the local disk.
 */
import { appendFile, chmod, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReminderSeat } from '@ambionframework/ambion';
import { defineAgent, defineTool } from '@ambionframework/ambion';
import { callTool, quiet, say } from '@ambionframework/ambion/testing';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { deferred, scriptedAgent } from '../../ambion/test/support/room.ts';
import { createExecutionServices, pi } from '../src/index.ts';
import {
	defaultSessionDir,
	diskSessions,
	memorySessions,
	type PiSessions,
	privateDirectory,
} from '../src/sessions.ts';
import { scriptedStream } from '../src/testing.ts';
import { stateOf } from './support/activation.ts';
import { failing, seed } from './support/storage.ts';
import { tempDir } from './support/temp.ts';
import { began, seatOn, TwoQuestions, texts, viewOf } from './support/two-questions.ts';

const scope = { room: 'memory', seat: 'product' };

const stores: [string, () => Promise<PiSessions>][] = [
	['memory', async () => memorySessions()],
	['disk', async () => diskSessions(await tempDir('ambion-continuity-'))],
];

const summary = {
	kind: 'summarize',
	exchange: 1,
	person: 'andrei',
	people: ['andrei'],
	through: 1,
} as const;

describe.each(stores)('exchange continuity on sessions in %s', (_name, store) => {
	it('continues the session the room names, sends reminders, scheduled says, and the delta only when the record moves', async () => {
		// A bundle reminder and the scheduled says reach the model on a continued session too, before the delta.
		const reminded: string[] = [];
		const remind = (seat: ReminderSeat) => {
			reminded.push(seat.activation);
			return `Reminder for ${seat.activation}.`;
		};
		const definition = scriptedAgent('product', 'Product.', { bundles: [{ tools: [], remind }] });
		const { seen, run } = seatOn(new TwoQuestions(), await store(), undefined, definition);
		const first = await run('message:1:product:1');
		const later = {
			seq: 1,
			seat: 'product',
			due: 'soon',
			text: 'Check the pump.',
		};
		const second = await run(
			'message:2:product:1',
			{ resume: first.session },
			{ scheduled: [later] },
		);
		expect(first.session).toEqual(began(1));
		expect(second.session).toEqual(began(1));
		expect(second.readThrough).toBe(2);
		const prompts = texts(seen.at(-1) as Context);
		// The first activation stays in the session. The second adds the delta alone.
		expect(prompts[0]).toContain("The record of 'memory' so far:");
		expect(prompts[0]).toContain('Reminder for message:1:product:1.');
		expect(prompts.at(-1)).toBe(
			'Reminder for message:2:product:1.\n\n' +
				'Your scheduled messages. The room wakes you with each one at its due time. Call `dismiss` with the seq of one that no longer fits:\n' +
				'- #1, due soon: Check the pump.\n\n[new] #2 [andrei] And the pump?',
		);
		// The position the session read never reaches the model.
		expect(prompts.join('\n')).not.toContain('through');

		const again = await run('message:2:product:2', { resume: second.session });
		expect(seen).toHaveLength(2);
		expect(reminded).toEqual(['message:1:product:1', 'message:2:product:1']);
		expect(again.result).toEqual({ failed: false });
		expect(again.readThrough).toBe(2);
		expect(again.session).toEqual(began(1));
	});

	it('begins a fresh session when the store does not hold the one the room names', async () => {
		const { seen, run } = seatOn(new TwoQuestions(), await store());
		const second = await run('message:2:product:1', { resume: began(1) });
		expect(second.result).toEqual({ failed: false });
		expect(second.session).toEqual(began(2));
		expect(texts(seen.at(-1) as Context)).toHaveLength(1);
	});

	it('refuses a say against a record that moved', async () => {
		const room = new TwoQuestions(3);
		const { run } = seatOn(room, await store(), (_context, _agent, request) =>
			request === 2 ? say('Yes.') : quiet(),
		);
		const first = await run('message:1:product:1');
		await run('message:2:product:1', { resume: first.session });
		// The continued seat read through 2. The record stands at 3, so the room answers missed.
		expect(room.commits.at(-1)?.readThrough).toBe(2);
		expect(room.answers).toEqual(['missed']);
	});

	it('records no session for an activation that ran no pass', async () => {
		const { opener, definition } = seatOn(new TwoQuestions(), await store());
		const cut = stateOf(opener, definition, {
			id: 'message:2:product:1',
			room: new TwoQuestions(),
		});
		cut.cut();
		expect(await cut.pass({ kind: 'view', view: await viewOf('message:2:product:1') })).toEqual({
			failed: false,
		});
		expect(cut.session).toBeUndefined();
		cut.close?.();
	});

	it('resolves a pass with no failure when it is cut and closed during the model request', async () => {
		const requested = deferred();
		const { opener, definition } = seatOn(new TwoQuestions(), await store(), async () => {
			requested.resolve();
			await new Promise(() => {});
			return quiet();
		});
		const session = stateOf(opener, definition, {
			id: 'message:1:product:1',
			room: new TwoQuestions(),
		});
		const running = session.pass({ kind: 'view', view: await viewOf('message:1:product:1') });
		await requested.promise;
		session.cut();
		// The driver closes the harness while the abort of the run is still active.
		session.close();
		expect(await running).toEqual({ failed: false });
		expect(session.isCut).toBe(true);
		expect(session.shouldRefresh(Number.MAX_SAFE_INTEGER)).toBe(false);
		expect(session.session).toEqual(began(1));
	});

	it('fails on a provider refusal, and records the session it continued', async () => {
		const { run, errors } = seatOn(
			new TwoQuestions(),
			await store(),
			(_context, _agent, request) =>
				request === 1
					? quiet()
					: ({
							...fauxAssistantMessage('', {
								stopReason: 'error',
								errorMessage: 'Your credit balance is too low',
							}),
						} as AssistantMessage),
		);
		const first = await run('message:1:product:1');
		const failed = await run('message:2:product:1', { resume: first.session });
		expect(failed.result).toEqual({
			failed: true,
			cause: 'permanent',
			message: 'Your credit balance is too low',
			error: new Error('Your credit balance is too low'),
		});
		expect(errors).toEqual(['Your credit balance is too low']);
		expect(failed.session).toEqual(began(1));
	});

	it('keeps the session of a closed exchange for its summary while the next exchange runs', async () => {
		const { seen, run } = seatOn(new TwoQuestions(), await store());
		await run('message:1:product:1');
		const second = await run('message:2:product:1');
		expect(second.session).toEqual(began(2));
		const fresh = texts(seen.at(-1) as Context);
		expect(fresh).toHaveLength(1);
		expect(fresh[0]).toContain("The record of 'memory' so far:");
		const closing = await run('closed:1:product:1', { purpose: summary, resume: began(1) });
		expect(closing.session).toEqual(began(1));
		// The summary activation continued the first session, and it reads the whole view.
		const prompts = texts(seen.at(-1) as Context);
		expect(prompts.length).toBeGreaterThan(1);
		expect(prompts.at(-1)).toContain("The record of 'memory' so far:");
		const next = await run('message:2:product:2', { resume: began(2) });
		expect(next.session).toEqual(began(2));
	});

	it.each([
		['holds no range entry', []],
		[
			'holds range entries with no positions',
			[
				{ kind: 'ambion.record', data: { after: -1, through: 'two' } },
				{ kind: 'ambion.record', data: 'two' },
			],
		],
	])('reads the whole view over a continued session that %s', async (_name, entries) => {
		const sessions = await store();
		await seed(sessions, scope, 'message:1:product:1', entries);
		const { seen, run } = seatOn(new TwoQuestions(), sessions);
		const second = await run('message:2:product:1', { resume: began(1) });
		expect(second.session).toEqual(began(1));
		expect(texts(seen.at(-1) as Context).at(-1)).toContain("The record of 'memory' so far:");
	});

	it('reads the whole view once when the room retries a failed activation on its session', async () => {
		const { seen, run } = seatOn(new TwoQuestions(), await store(), (_context, _agent, request) => {
			if (request === 1) throw new Error('overloaded 529');
			return quiet();
		});
		const failed = await run('message:2:product:1');
		expect(failed.result).toMatchObject({ failed: true, cause: 'transient' });
		expect(failed.session).toEqual(began(2));
		const retry = await run('message:2:product:2', { resume: failed.session });
		expect(retry.result).toEqual({ failed: false });
		expect(retry.session).toEqual(began(2));
		// The failed pass left the context. The retry holds the view once.
		expect(texts(seen.at(-1) as Context)).toHaveLength(1);
		expect(texts(seen.at(-1) as Context)[0]).toContain("The record of 'memory' so far:");
	});

	it('sends the delta once when the room retries a failed activation that continued a session', async () => {
		const { seen, run } = seatOn(new TwoQuestions(), await store(), (_context, _agent, request) => {
			if (request === 2) throw new Error('overloaded 529');
			return quiet();
		});
		const first = await run('message:1:product:1');
		const failed = await run('message:2:product:1', { resume: first.session });
		expect(failed.result).toMatchObject({ failed: true, cause: 'transient' });
		const retry = await run('message:2:product:2', { resume: failed.session });
		expect(retry.readThrough).toBe(2);
		const prompts = texts(seen.at(-1) as Context);
		expect(prompts.filter((text) => text === '[new] #2 [andrei] And the pump?')).toHaveLength(1);
		expect(prompts.at(-1)).toBe('[new] #2 [andrei] And the pump?');
	});

	it('begins a fresh session when the one the room names does not open', async () => {
		const inner = await store();
		const sessions: PiSessions = {
			create: (where, id) => inner.create(where, id),
			open: async (where, id) => {
				const opened = await inner.open(where, id);
				return opened && failing(opened, ['*'], () => true);
			},
		};
		const { seen, run } = seatOn(new TwoQuestions(), sessions);
		const first = await run('message:1:product:1');
		const second = await run('message:2:product:1', { resume: first.session });
		expect(second.result).toEqual({ failed: false });
		expect(second.session).toEqual(began(2));
		expect(texts(seen.at(-1) as Context)).toHaveLength(1);
	});

	it('begins a fresh session when the one the room names fails as the executor reads its position', async () => {
		const inner = await store();
		let reading = false;
		const sessions: PiSessions = {
			create: (where, id) => inner.create(where, id),
			open: async (where, id) => {
				const opened = await inner.open(where, id);
				reading = true;
				return opened && failing(opened, ['scanSubmissions'], () => reading);
			},
		};
		const { seen, run } = seatOn(new TwoQuestions(), sessions);
		const first = await run('message:1:product:1');
		const second = await run('message:2:product:1', { resume: first.session });
		expect(second.result).toEqual({ failed: false });
		expect(second.session).toEqual(began(2));
		expect(texts(seen.at(-1) as Context)).toHaveLength(1);
	});

	it('records no session when the session fails a write during the run, and the retry reads the whole view', async () => {
		const inner = await store();
		let broken = false;
		const sessions: PiSessions = {
			create: async (where, id) => {
				const created = await inner.create(where, id);
				return { ...created, storage: failing(created.storage, ['commit'], () => broken) };
			},
			open: (where, id) => inner.open(where, id),
		};
		const { seen, run } = seatOn(new TwoQuestions(), sessions, (_context, _agent, request) => {
			broken = request === 1;
			return quiet();
		});
		const failed = await run('message:2:product:1');
		expect(failed.result).toMatchObject({ failed: true, cause: 'transient' });
		expect(failed.session).toBeUndefined();
		// The disk comes back. The retry starts a session of its own.
		broken = false;
		const retry = await run('message:2:product:2');
		expect(retry.result).toEqual({ failed: false });
		expect(retry.session).toEqual({ kind: 'pi', id: 'message:2:product:2' });
		expect(texts(seen.at(-1) as Context)).toHaveLength(1);
		expect(texts(seen.at(-1) as Context)[0]).toContain("The record of 'memory' so far:");
	});

	it('aborts the run when the harness reports a fault it goes on from', async () => {
		const executions: string[] = [];
		const book = defineTool({
			name: 'book',
			description: 'Book a day.',
			parameters: Type.Object({}),
			execute: () => {
				executions.push('book');
				return 'booked';
			},
		});
		const definition = defineAgent({
			name: 'product',
			identity: 'Product.',
			executor: pi({ instructions: 'Work.', model: 'scripted/product', tools: [book] }),
		});
		// The hook before the second request throws once. The harness reports it and sends the request.
		let thrown = false;
		const room = new TwoQuestions();
		const { seen, opener } = seatOn(
			room,
			await store(),
			(_context, _agent, request) => (request < 4 ? callTool('book', {}) : quiet()),
			definition,
		);
		const id = 'message:2:product:1';
		const activation = stateOf(
			(input) =>
				opener({
					...input,
					get readThrough() {
						return input.readThrough;
					},
					delivered(call) {
						if (thrown) return input.delivered(call);
						thrown = true;
						throw new Error('The hook failed.');
					},
				}),
			definition,
			{ id, room },
		);
		// The activation stays open, as it does while the room retries the pass.
		onTestFinished(() => activation.close?.());
		const failed = await activation.pass({ kind: 'view', view: await viewOf(id, room) });
		expect(thrown).toBe(true);
		expect(failed).toMatchObject({ failed: true, cause: 'transient' });
		expect(activation.session).toBeUndefined();
		// No tool and no request follows a pass that the executor reported failed.
		const after = { requests: seen.length, executions: executions.length };
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect({ requests: seen.length, executions: executions.length }).toEqual(after);
	});

	it('gives a session a fresh id when the store already holds the id', async () => {
		const sessions = await store();
		const one = await sessions.create(scope, 'same');
		const two = await sessions.create(scope, 'same');
		expect(one.id).toBe('same');
		expect(two.id).not.toBe('same');
		expect(await sessions.open(scope, 'same')).toBeDefined();
		expect(await sessions.open(scope, two.id)).toBeDefined();
	});
});

describe('exchange continuity on the local disk', () => {
	it('continues a session after a restart, from the position the session read', async () => {
		const dir = await tempDir('ambion-restart-');
		const before = seatOn(new TwoQuestions(), diskSessions(dir));
		const first = await before.run('message:1:product:1');
		// A new executor on the same directory: the process restarted.
		const after = seatOn(new TwoQuestions(), diskSessions(dir));
		const second = await after.run('message:2:product:1', { resume: first.session });
		expect(second.session).toEqual(began(1));
		expect(second.readThrough).toBe(2);
		const prompts = texts(after.seen.at(-1) as Context);
		expect(prompts[0]).toContain("The record of 'memory' so far:");
		expect(prompts.at(-1)).toBe('[new] #2 [andrei] And the pump?');
	});

	it('keeps a storage folder for each session of a room and seat, and begins fresh over a corrupt one', async () => {
		const dir = await tempDir('ambion-corrupt-');
		const { run, seen } = seatOn(new TwoQuestions(), diskSessions(dir));
		const first = await run('message:1:product:1');
		const [room] = await readdir(dir);
		expect(room).toBe('memory');
		expect(await readdir(join(dir, 'memory'))).toEqual(['product']);
		const folder = join(dir, 'memory', 'product', encodeURIComponent('message:1:product:1'));
		const files = await readdir(folder);
		expect(files).toContain('main.jsonl');
		await appendFile(join(folder, 'main.jsonl'), '{not json\n');
		const second = await run('message:2:product:1', { resume: first.session });
		expect(second.result).toEqual({ failed: false });
		expect(second.session).toEqual(began(2));
		expect(texts(seen.at(-1) as Context)).toHaveLength(1);
	});

	it('opens a session that the disk does not hold as nothing, and creates no folder for it', async () => {
		const dir = await tempDir('ambion-missing-');
		const sessions = diskSessions(dir);
		expect(await sessions.open(scope, 'absent')).toBeUndefined();
		expect(await readdir(dir)).toEqual([]);
	});

	it('names a directory in the OS temporary directory for this user, and tries again after a refusal', async () => {
		const temporary = await tempDir('ambion-tmpdir-');
		await writeFile(join(temporary, 'file'), '');
		// The OS temporary directory is a file: the disk refuses the directory.
		vi.stubEnv('TMPDIR', join(temporary, 'file'));
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});
		await expect(defaultSessionDir()).rejects.toThrow();
		vi.stubEnv('TMPDIR', temporary);
		const dir = await defaultSessionDir();
		expect(dir).toBe(join(temporary, `ambion-pi-sessions-${process.getuid?.()}`));
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
		// With no option, every stream keeps its sessions there.
		const services = createExecutionServices({ stream: scriptedStream(() => quiet()) });
		const created = await services.sessions.create({ room: 'room', seat: 'seat' }, 'kept');
		await created.storage.close(BACKGROUND_CONTEXT);
		expect(await readdir(dir)).toEqual([expect.stringContaining('room')]);
	});

	it('takes access from other users on a directory it owns, and refuses a link', async () => {
		const dir = await tempDir('ambion-private-');
		await chmod(dir, 0o755);
		expect(await privateDirectory(dir)).toBe(dir);
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
		// A link can point another user's writes at the directory.
		const link = join(dir, 'link');
		await symlink(dir, link);
		await expect(privateDirectory(link)).rejects.toThrow('is not a directory this user owns');
	});

	it('keeps a session in memory when the disk refuses it, and the activation runs on', async () => {
		const dir = await tempDir('ambion-refused-');
		await writeFile(join(dir, 'file'), '');
		// A directory under a file: the disk refuses every session.
		const { run } = seatOn(new TwoQuestions(), diskSessions(join(dir, 'file', 'sessions')));
		const first = await run('message:1:product:1');
		expect(first.result).toEqual({ failed: false });
		const second = await run('message:2:product:1', { resume: first.session });
		expect(second.session).toEqual(began(1));
		expect(second.readThrough).toBe(2);
	});

	it.each([
		['memory keeps sessions for as long as the services live', false, false],
		['a directory keeps sessions on the local disk', true, true],
	])('%s', async (_name, named, kept) => {
		const dir = await tempDir('ambion-services-');
		const services = () =>
			createExecutionServices({
				stream: scriptedStream(() => quiet()),
				...(named ? { sessionDir: dir } : { sessions: 'memory' }),
			});
		const where = { room: 'room', seat: 'seat' };
		const created = await services().sessions.create(where, 'kept');
		await created.storage.close(BACKGROUND_CONTEXT);
		const opened = await services().sessions.open(where, 'kept');
		expect(opened !== undefined).toBe(kept);
		await opened?.close(BACKGROUND_CONTEXT);
	});
});

describe('exchange continuity on sessions in memory', () => {
	it('keeps the two newest sessions of a seat, and drops an older one', async () => {
		const sessions = memorySessions();
		const ids = ['one', 'two', 'three', 'four'];
		for (const id of ids) await sessions.create(scope, id);
		const kept = [];
		for (const id of ids) if ((await sessions.open(scope, id)) !== undefined) kept.push(id);
		expect(kept).toEqual(['three', 'four']);
		// The seat of another room keeps its own.
		expect(await sessions.open({ room: 'other', seat: 'product' }, 'four')).toBeUndefined();
	});
});
