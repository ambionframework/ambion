/**
 * Exchange continuity. The executor reopens the Pi harness session the room
 * names in `spec.resume`, prompts it with the delta, and records the session
 * on every release. A view that names no session, or names one the store
 * cannot open, begins a fresh one. Every case runs on sessions in memory and
 * on sessions on the local disk.
 */
import { appendFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@ambionframework/ambion';
import type {
	ActivationSpec,
	CommitRequest,
	CommitResult,
	HarnessSession,
	LeaseRequest,
	LeaseResponse,
	RoomProtocol,
	ViewResponse,
} from '@ambionframework/ambion/hosting';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { deferred, scriptedAgent } from '../../ambion/test/support/room.ts';
import { noTrace } from '../../ambion/test/support/trace.ts';
import { createExecutionServices, createPiExecutor, stubModel } from '../src/index.ts';
import {
	defaultSessionDir,
	diskSessions,
	memorySessions,
	type PiSessions,
} from '../src/sessions.ts';
import { contextText, quiet, type Script, scripted, speak } from '../src/testing.ts';

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

/** The session that the activation `message:<seq>:product:1` began. */
const began = (seq: number): HarnessSession => ({ harness: 'pi', id: `message:${seq}:product:1` });

const texts = (context: Context) =>
	context.messages.map((message) => contextText({ ...context, messages: [message] }));

/**
 * One executor for the seat over `sessions`. `run` opens one activation,
 * runs its first pass over the view the room gives with the spec changes it
 * names, and closes it as the driver does.
 */
function seatOn(room: TwoQuestions, sessions: PiSessions, script: Script = () => quiet()) {
	const seen: Context[] = [];
	const errors: string[] = [];
	const executor = createPiExecutor({
		definition: scriptedAgent('product'),
		model: stubModel,
		stream: scripted((context, agent, call) => {
			seen.push({ ...context, messages: [...context.messages] });
			return script(context, agent, call);
		}),
		now: () => 0,
		sessions,
	});
	const run = async (id: string, spec: Partial<ActivationSpec> = {}) => {
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
		const view = { ...answer.view, spec: { ...answer.view.spec, ...spec } };
		const result = await session.pass({ kind: 'view', view });
		const recorded = { result, session: session.session, readThrough: session.readThrough };
		session.close?.();
		return recorded;
	};
	return { seen, errors, run, executor };
}

const stores: [string, () => Promise<PiSessions>][] = [
	['memory', async () => memorySessions()],
	['disk', async () => diskSessions(await mkdtemp(join(tmpdir(), 'ambion-continuity-')))],
];

const summary = {
	kind: 'summarize',
	exchange: 1,
	person: 'andrei',
	people: ['andrei'],
	through: 1,
} as const;

describe.each(stores)('exchange continuity on sessions in %s', (_name, store) => {
	it('continues the session the room names, prompts the delta, and records it', async () => {
		const { seen, run } = seatOn(new TwoQuestions(), await store());
		const first = await run('message:1:product:1');
		const second = await run('message:2:product:1', { resume: first.session });
		expect(first.session).toEqual(began(1));
		expect(second.session).toEqual(began(1));
		expect(second.readThrough).toBe(2);
		const prompts = texts(seen.at(-1) as Context);
		// The first activation stays in the session. The second adds the delta alone.
		expect(prompts[0]).toContain("The record of 'memory' so far:");
		expect(prompts.at(-1)).toBe('[new] [andrei] And the pump?');
		// The position the session read never reaches the model.
		expect(prompts.join('\n')).not.toContain('through');
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

/** The view the room gives an activation. */
async function viewOf(id: string) {
	const answer = await new TwoQuestions().view(id);
	if (!('view' in answer)) throw new Error('The room answered stale.');
	return answer.view;
}

describe('exchange continuity on the local disk', () => {
	it('continues a session after a restart, from the position the session read', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ambion-restart-'));
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
		const dir = await mkdtemp(join(tmpdir(), 'ambion-corrupt-'));
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

	it('names a directory in the OS temporary directory when the host names none', async () => {
		expect(await defaultSessionDir()).toBe(join(tmpdir(), 'ambion-pi-sessions'));
	});

	it.each([
		['a custom stream keeps sessions in memory', false, false],
		['a directory keeps sessions on the local disk', true, true],
	])('%s', async (_name, named, kept) => {
		const dir = await mkdtemp(join(tmpdir(), 'ambion-services-'));
		const services = () =>
			createExecutionServices({
				stream: scripted(() => quiet()),
				...(named ? { sessionDir: dir } : {}),
			});
		const scope = { room: 'room', seat: 'seat' };
		const created = await services().sessions.create(scope, 'kept', BACKGROUND_CONTEXT);
		await created.close(BACKGROUND_CONTEXT);
		const opened = await services().sessions.open(scope, 'kept', BACKGROUND_CONTEXT);
		expect(opened !== undefined).toBe(kept);
		await opened?.close(BACKGROUND_CONTEXT);
	});
});
