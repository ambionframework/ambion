/**
 * Exchange continuity. The executor reopens the Pi harness session the room
 * names in `spec.resume`, prompts it with the delta, and records the session
 * on every release. A view that names no session, or names one the store
 * cannot open, begins a fresh one. Every case runs on sessions in memory and
 * on sessions on the local disk.
 */
import { appendFile, chmod, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	AgentDefinition,
	AgentExecutor,
	Message,
	ReminderSeat,
} from '@ambionframework/ambion';
import type {
	ActivationSpec,
	ActivationView,
	CommitRequest,
	CommitResult,
	HarnessSession,
	LeaseRequest,
	LeaseResponse,
	RoomProtocol,
	ViewResponse,
} from '@ambionframework/ambion/hosting';
import {
	BACKGROUND_CONTEXT,
	type CompactionSettings,
	type Session,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { deferred, scriptedAgent } from '../../ambion/test/support/room.ts';
import { noTrace } from '../../ambion/test/support/trace.ts';
import { createExecutionServices, createPiExecutor, stubModel } from '../src/index.ts';
import {
	defaultSessionDir,
	diskSessions,
	memorySessions,
	type PiSessions,
	privateDirectory,
} from '../src/sessions.ts';
import { contextText, quiet, type Script, scripted, speak } from '../src/testing.ts';
import { tempDir } from './support/temp.ts';

const said = (seq: number, text: string): Message => ({
	kind: 'said',
	seq,
	at: '2026-01-01T09:00:00.000Z',
	from: 'andrei',
	text,
});

const RECORD = [said(1, 'Can we ship?'), said(2, 'And the pump?')];

/** A room with two questions. The record stands at `last`, and an activation reads through its own message. */
class TwoQuestions implements RoomProtocol {
	readonly releases: Extract<LeaseRequest, { operation: 'release' }>[] = [];
	readonly commits: CommitRequest[] = [];
	readonly answers: string[] = [];

	constructor(private readonly last = 2) {}

	async view(activation: string): Promise<ViewResponse> {
		const message = Number(activation.split(':')[1]);
		return {
			view: {
				spec: {
					id: activation,
					seat: 'product',
					attempt: 1,
					purpose: { kind: 'respond', message },
				},
				through: message,
				context: {
					name: 'memory',
					now: 0,
					participants: [],
					messages: RECORD.filter((entry) => entry.seq <= message),
					exchange: { owner: 'andrei', from: 1 },
					reserve: [],
				},
			},
		};
	}

	async commit(request: CommitRequest): Promise<CommitResult> {
		this.commits.push(request);
		if ((request.readThrough ?? 0) < this.last) {
			this.answers.push('missed');
			return { missed: RECORD.filter((entry) => entry.seq > (request.readThrough ?? 0)) };
		}
		this.answers.push('committed');
		return {
			committed: { kind: 'said', seq: this.last + 1, at: '', from: 'product', text: 'Yes.' },
		};
	}

	async lease(lease: LeaseRequest): Promise<LeaseResponse> {
		if (lease.operation === 'release') this.releases.push(lease);
		return { ok: { expiresAt: Date.now() + 60_000, lastSeq: this.last } };
	}
}

/** The seat on compaction settings that `pi()` refuses, as a host could build it by hand. */
const withCompaction = (compaction: CompactionSettings): AgentDefinition => {
	const definition = scriptedAgent('product');
	return { ...definition, executor: { ...definition.executor, compaction } as AgentExecutor };
};

/** The session that the activation `message:<seq>:product:1` began. */
const began = (seq: number): HarnessSession => ({ harness: 'pi', id: `message:${seq}:product:1` });

const texts = (context: Context) =>
	context.messages.map((message) => contextText({ ...context, messages: [message] }));

/**
 * One executor for the seat over `sessions`. `run` opens one activation,
 * runs its first pass over the view the room gives with the spec changes it
 * names, and closes it as the driver does.
 */
function seatOn(
	room: TwoQuestions,
	sessions: PiSessions,
	script: Script = () => quiet(),
	definition: AgentDefinition = scriptedAgent('product'),
) {
	const seen: Context[] = [];
	const errors: string[] = [];
	const executor = createPiExecutor({
		definition,
		model: stubModel,
		stream: scripted((context, agent, call) => {
			seen.push({ ...context, messages: [...context.messages] });
			return script(context, agent, call);
		}),
		now: () => 0,
		sessions,
	});
	const run = async (
		id: string,
		spec: Partial<ActivationSpec> = {},
		context: Partial<ActivationView['context']> = {},
	) => {
		const answer = await room.view(id);
		if (!('view' in answer)) throw new Error('The room answered stale.');
		const session = executor.open({
			id,
			room,
			emit: (event) => {
				if (event.type === 'error') errors.push(event.error.message);
			},
			trace: noTrace,
		});
		const view = {
			...answer.view,
			spec: { ...answer.view.spec, ...spec },
			context: { ...answer.view.context, ...context },
		};
		const result = await session.pass({ kind: 'view', view });
		const recorded = { result, session: session.session, readThrough: session.readThrough };
		session.close?.();
		return recorded;
	};
	return { seen, errors, run, executor };
}

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
	it('continues the session the room names, prompts the reminders, the pending says, and the delta, and records it', async () => {
		// A bundle reminder and the pending says reach the model on a continued session too, before the delta.
		const remind = (seat: ReminderSeat) => `Reminder for ${seat.activation}.`;
		const definition = scriptedAgent('product', 'Product.', { bundles: [{ tools: [], remind }] });
		const { seen, run } = seatOn(new TwoQuestions(), await store(), undefined, definition);
		const first = await run('message:1:product:1');
		const later = {
			seq: 1,
			seat: 'product',
			owner: 'andrei',
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
				'Your says that wait to return. The room gives each back to you at its due time. Call `dismiss` with the handle of one that no longer fits:\n' +
				'- 1, due soon: Check the pump.\n\n[new] [andrei] And the pump?',
		);
		// The position the session read never reaches the model.
		expect(prompts.join('\n')).not.toContain('through');
	});

	it('calls no reminder for a continued session that has nothing new, and starts no run', async () => {
		const reminded: string[] = [];
		const remind = (seat: ReminderSeat) => {
			reminded.push(seat.activation);
			return 'Reminder.';
		};
		const definition = scriptedAgent('product', 'Product.', { bundles: [{ tools: [], remind }] });
		const { seen, run } = seatOn(new TwoQuestions(1), await store(), undefined, definition);
		const first = await run('message:1:product:1');
		await run('message:1:product:2', { resume: first.session });
		expect(seen).toHaveLength(1);
		expect(reminded).toEqual(['message:1:product:1']);
	});

	it('begins a fresh session when the view names none, as in a new exchange', async () => {
		const { seen, run } = seatOn(new TwoQuestions(), await store());
		await run('message:1:product:1');
		const second = await run('message:2:product:1');
		expect(second.session).toEqual(began(2));
		const prompts = texts(seen.at(-1) as Context);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("The record of 'memory' so far:");
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
		const { run } = seatOn(room, await store(), (_context, _agent, call) =>
			call === 2 ? speak('Yes.') : quiet(),
		);
		const first = await run('message:1:product:1');
		await run('message:2:product:1', { resume: first.session });
		// The continued seat read through 2. The record stands at 3, so the room answers missed.
		expect(room.commits.at(-1)?.readThrough).toBe(2);
		expect(room.answers).toEqual(['missed']);
	});

	it('records no session for an activation that ran no pass', async () => {
		const { executor } = seatOn(new TwoQuestions(), await store());
		const cut = executor.open({
			id: 'message:2:product:1',
			room: new TwoQuestions(),
			emit: () => {},
			trace: noTrace,
		});
		cut.abort();
		expect(await cut.pass({ kind: 'view', view: await viewOf('message:2:product:1') })).toEqual({
			failed: false,
		});
		expect(cut.session).toBeUndefined();
		cut.close?.();
	});

	it('resolves a pass with no failure when it is cut during the model request', async () => {
		const requested = deferred();
		const { executor } = seatOn(new TwoQuestions(), await store(), async () => {
			requested.resolve();
			await new Promise(() => {});
			return quiet();
		});
		const session = executor.open({
			id: 'message:1:product:1',
			room: new TwoQuestions(),
			emit: () => {},
			trace: noTrace,
		});
		const running = session.pass({ kind: 'view', view: await viewOf('message:1:product:1') });
		await requested.promise;
		session.abort();
		expect(await running).toEqual({ failed: false });
		expect(session.cancelled).toBe(true);
		expect(session.shouldRefresh(Number.MAX_SAFE_INTEGER)).toBe(false);
		expect(session.session).toEqual(began(1));
		session.close?.();
	});

	it('fails on a provider refusal, and records the session it continued', async () => {
		const { run, errors } = seatOn(new TwoQuestions(), await store(), (_context, _agent, call) =>
			call === 1
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
		});
		expect(errors).toEqual(['Your credit balance is too low']);
		expect(failed.session).toEqual(began(1));
	});

	it('keeps the session of a closed exchange for its summary while the next exchange runs', async () => {
		const { seen, run } = seatOn(new TwoQuestions(), await store());
		await run('message:1:product:1');
		await run('message:2:product:1');
		const closing = await run('closed:1:product:1', { purpose: summary, resume: began(1) });
		expect(closing.session).toEqual(began(1));
		// The closing activation continued the first session, and it reads the whole view.
		const prompts = texts(seen.at(-1) as Context);
		expect(prompts.length).toBeGreaterThan(1);
		expect(prompts.at(-1)).toContain("The record of 'memory' so far:");
		const next = await run('message:2:product:2', { resume: began(2) });
		expect(next.session).toEqual(began(2));
	});

	it('starts no run for a continued session with nothing new, and reads through the view', async () => {
		const { seen, run } = seatOn(new TwoQuestions(1), await store());
		await run('message:1:product:1');
		const again = await run('message:1:product:2', { resume: began(1) });
		expect(again.result).toEqual({ failed: false });
		expect(seen).toHaveLength(1);
		expect(again.readThrough).toBe(1);
		expect(again.session).toEqual(began(1));
	});

	it.each([
		['holds no object', 'two'],
		['holds no position', { through: 'two' }],
	])('reads the whole view over a continued session whose read entry %s', async (_name, data) => {
		const sessions = await store();
		const written = await sessions.create(
			{ room: 'memory', seat: 'product' },
			'message:1:product:1',
			BACKGROUND_CONTEXT,
		);
		const branch = await written.createBranch('main', null, BACKGROUND_CONTEXT);
		await branch.appendCustomEntry('ambion.read', data, BACKGROUND_CONTEXT);
		await written.close(BACKGROUND_CONTEXT);
		const { seen, run } = seatOn(new TwoQuestions(), sessions);
		const second = await run('message:2:product:1', { resume: began(1) });
		expect(second.session).toEqual(began(1));
		expect(texts(seen.at(-1) as Context).at(-1)).toContain("The record of 'memory' so far:");
	});

	it('reads the whole view once when the room retries a failed activation on its session', async () => {
		const { seen, run } = seatOn(new TwoQuestions(), await store(), (_context, _agent, call) => {
			if (call === 1) throw new Error('overloaded 529');
			return quiet();
		});
		const failed = await run('message:2:product:1');
		expect(failed.result).toMatchObject({ failed: true, cause: 'transient' });
		expect(failed.session).toEqual(began(2));
		const retry = await run('message:2:product:2', { resume: failed.session });
		expect(retry.result).toEqual({ failed: false });
		expect(retry.session).toEqual(began(2));
		// The failed run left the provider input. The retry holds the view once.
		expect(texts(seen.at(-1) as Context)).toHaveLength(1);
		expect(texts(seen.at(-1) as Context)[0]).toContain("The record of 'memory' so far:");
	});

	it('prompts the delta once when the room retries a failed activation that continued a session', async () => {
		const { seen, run } = seatOn(new TwoQuestions(), await store(), (_context, _agent, call) => {
			if (call === 2) throw new Error('overloaded 529');
			return quiet();
		});
		const first = await run('message:1:product:1');
		const failed = await run('message:2:product:1', { resume: first.session });
		expect(failed.result).toMatchObject({ failed: true, cause: 'transient' });
		const retry = await run('message:2:product:2', { resume: failed.session });
		expect(retry.readThrough).toBe(2);
		const prompts = texts(seen.at(-1) as Context);
		expect(prompts.filter((text) => text === '[new] [andrei] And the pump?')).toHaveLength(1);
		expect(prompts.at(-1)).toBe('[new] [andrei] And the pump?');
	});

	it('closes the session, records none, and fails as transient when the harness refuses the settings', async () => {
		const sessions = await store();
		await seatOn(new TwoQuestions(), sessions).run('message:1:product:1');
		const executor = createPiExecutor({
			definition: withCompaction({ enabled: true, reserveTokens: -1, keepRecentTokens: 1 }),
			model: stubModel,
			stream: scripted(() => quiet()),
			now: () => 0,
			sessions,
		});
		const session = executor.open({
			id: 'message:2:product:1',
			room: new TwoQuestions(),
			emit: () => {},
			trace: noTrace,
		});
		const view = await viewOf('message:2:product:1');
		const result = await session.pass({
			kind: 'view',
			view: { ...view, spec: { ...view.spec, resume: began(1) } },
		});
		expect(result).toMatchObject({ failed: true, cause: 'transient' });
		expect(session.session).toBeUndefined();
		// The continued session and the fresh one both closed, so each opens again.
		for (const id of ['message:1:product:1', 'message:2:product:1']) {
			const reopened = await sessions.open(
				{ room: 'memory', seat: 'product' },
				id,
				BACKGROUND_CONTEXT,
			);
			expect(reopened?.metadata.id).toBe(id);
			await reopened?.close(BACKGROUND_CONTEXT);
		}
	});

	it('begins a fresh session when the one the room names opens but does not restore', async () => {
		const store0 = await store();
		const sessions: PiSessions = {
			create: (scope, id, context) => store0.create(scope, id, context),
			open: async (scope, id, context) => {
				const opened = await store0.open(scope, id, context);
				await opened?.close(context);
				return opened;
			},
		};
		const { run } = seatOn(new TwoQuestions(), sessions);
		const first = await run('message:1:product:1');
		const second = await run('message:2:product:1', { resume: first.session });
		expect(second.result).toEqual({ failed: false });
		expect(second.session).toEqual(began(2));
	});

	it('begins a fresh session when the one the room names fails as the lane goes back to its position', async () => {
		const inner = await store();
		const sessions: PiSessions = {
			create: (scope, id, context) => inner.create(scope, id, context),
			open: async (scope, id, context) => {
				const opened = await inner.open(scope, id, context);
				return opened && failing(opened, ['scanBranch'], () => true);
			},
		};
		const { seen, run } = seatOn(new TwoQuestions(), sessions);
		const first = await run('message:1:product:1');
		const second = await run('message:2:product:1', { resume: first.session });
		expect(second.result).toEqual({ failed: false });
		expect(second.session).toEqual(began(2));
		expect(texts(seen.at(-1) as Context)).toHaveLength(1);
	});

	it('records a fresh session when the session fails a write during the run, and the retry reads the whole view', async () => {
		const inner = await store();
		let broken = false;
		const sessions: PiSessions = {
			create: async (scope, id, context) =>
				failing(await inner.create(scope, id, context), WRITES, () => broken),
			open: (scope, id, context) => inner.open(scope, id, context),
		};
		const { seen, run } = seatOn(new TwoQuestions(), sessions, (_context, _agent, call) => {
			broken = call === 1;
			return quiet();
		});
		const failed = await run('message:2:product:1');
		expect(failed.result).toMatchObject({ failed: true, cause: 'transient' });
		expect(failed.session?.id).not.toBe('message:2:product:1');
		const retry = await run('message:2:product:2', { resume: failed.session });
		expect(retry.result).toEqual({ failed: false });
		expect(retry.session).toEqual(failed.session);
		expect(texts(seen.at(-1) as Context)).toHaveLength(1);
		expect(texts(seen.at(-1) as Context)[0]).toContain("The record of 'memory' so far:");
	});

	it('records no session when the session fails a write and the store creates no fresh one', async () => {
		const inner = await store();
		let broken = false;
		const sessions: PiSessions = {
			create: async (scope, id, context) => {
				if (broken) throw new Error('The store is full.');
				return failing(await inner.create(scope, id, context), WRITES, () => broken);
			},
			open: (scope, id, context) => inner.open(scope, id, context),
		};
		const { run } = seatOn(new TwoQuestions(), sessions, () => {
			broken = true;
			return quiet();
		});
		const failed = await run('message:2:product:1');
		expect(failed.result).toMatchObject({ failed: true, cause: 'transient' });
		expect(failed.session).toBeUndefined();
	});

	it('gives a session a fresh id when the store already holds the id', async () => {
		const sessions = await store();
		const scope = { room: 'memory', seat: 'product' };
		const one = await sessions.create(scope, 'same', BACKGROUND_CONTEXT);
		const two = await sessions.create(scope, 'same', BACKGROUND_CONTEXT);
		expect(one.metadata.id).toBe('same');
		expect(two.metadata.id).not.toBe('same');
		await one.close(BACKGROUND_CONTEXT);
		await two.close(BACKGROUND_CONTEXT);
	});
});

/** The methods of a session that write to its store. */
const WRITES = ['mutate', 'beginMutation', 'setValue', 'appendList'];

/** The session, with each method in `methods` failing while `broken` answers true. */
function failing(session: Session, methods: readonly string[], broken: () => boolean): Session {
	return new Proxy(session, {
		get(target, property, receiver) {
			const value: unknown = Reflect.get(target, property, receiver);
			if (typeof value !== 'function') return value;
			if (typeof property === 'string' && methods.includes(property)) {
				return (...args: unknown[]) =>
					broken()
						? Promise.reject(new Error('The disk failed.'))
						: Reflect.apply(value, target, args);
			}
			return value.bind(target);
		},
	});
}

/** The view the room gives an activation. */
async function viewOf(id: string) {
	const answer = await new TwoQuestions().view(id);
	if (!('view' in answer)) throw new Error('The room answered stale.');
	return answer.view;
}

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
		expect(prompts.at(-1)).toBe('[new] [andrei] And the pump?');
	});

	it('keeps a session file for each room and seat, and begins fresh over a corrupt one', async () => {
		const dir = await tempDir('ambion-corrupt-');
		const { run, seen } = seatOn(new TwoQuestions(), diskSessions(dir));
		const first = await run('message:1:product:1');
		const [folder] = await readdir(dir);
		expect(folder).toMatch(/^--.*memory.*product--$/);
		const [file] = await readdir(join(dir, folder as string));
		expect(file).toMatch(/\.jsonl$/);
		await appendFile(join(dir, folder as string, file as string), '{not json\n');
		const second = await run('message:2:product:1', { resume: first.session });
		expect(second.result).toEqual({ failed: false });
		expect(second.session).toEqual(began(2));
		expect(texts(seen.at(-1) as Context)).toHaveLength(1);
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
		const services = createExecutionServices({ stream: scripted(() => quiet()) });
		const scope = { room: 'room', seat: 'seat' };
		await (
			await services.sessions.create(scope, 'kept', BACKGROUND_CONTEXT)
		).close(BACKGROUND_CONTEXT);
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
				stream: scripted(() => quiet()),
				...(named ? { sessionDir: dir } : { sessions: 'memory' }),
			});
		const scope = { room: 'room', seat: 'seat' };
		const created = await services().sessions.create(scope, 'kept', BACKGROUND_CONTEXT);
		await created.close(BACKGROUND_CONTEXT);
		const opened = await services().sessions.open(scope, 'kept', BACKGROUND_CONTEXT);
		expect(opened !== undefined).toBe(kept);
		await opened?.close(BACKGROUND_CONTEXT);
	});
});

describe('exchange continuity on sessions in memory', () => {
	it('keeps the two newest sessions of a seat, and deletes an older one once it closes', async () => {
		const sessions = memorySessions();
		const scope = { room: 'memory', seat: 'product' };
		const ids = ['one', 'two', 'three', 'four'];
		const held = await sessions.create(scope, 'one', BACKGROUND_CONTEXT);
		for (const id of ids.slice(1, 3)) {
			await (await sessions.create(scope, id, BACKGROUND_CONTEXT)).close(BACKGROUND_CONTEXT);
		}
		// An open session stays until it closes.
		await held.close(BACKGROUND_CONTEXT);
		await (await sessions.create(scope, 'four', BACKGROUND_CONTEXT)).close(BACKGROUND_CONTEXT);
		const kept = [];
		for (const id of ids) {
			const opened = await sessions.open(scope, id, BACKGROUND_CONTEXT);
			if (opened !== undefined) kept.push(opened.metadata.id);
			await opened?.close(BACKGROUND_CONTEXT);
		}
		expect(kept).toEqual(['three', 'four']);
	});
});
