/**
 * Exchange continuity. The executor builds the next agent over the transcript
 * the seat kept when the room names it in `spec.resume`, prompts it with the
 * delta, and records the transcript on every release. A view that names no
 * transcript, or names one the process lost, begins a fresh one.
 */
import type { Message } from '@ambionframework/ambion';
import type {
	CommitRequest,
	CommitResult,
	HarnessSession,
	LeaseRequest,
	LeaseResponse,
	RoomProtocol,
	ViewResponse,
} from '@ambionframework/ambion/hosting';
import { type AssistantMessage, type Context, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { deferred, scriptedAgent, tick } from '../../ambion/test/support/room.ts';
import { contextText, quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { noTrace } from '../../ambion/test/support/trace.ts';
import { createPiExecutor, stubModel } from '../src/index.ts';
import { seatHost } from './support/runner.ts';

const said = (seq: number, text: string): Message => ({
	kind: 'said',
	seq,
	at: '2026-01-01T09:00:00.000Z',
	from: 'andrei',
	text,
});

const RECORD = [said(1, 'Can we ship?'), said(2, 'And the pump?')];

/**
 * What the room names in `spec.resume`: the session the last release recorded,
 * as inside one exchange, or nothing, as in a new exchange.
 */
type Resume = 'recorded' | 'none';

/** A room with two questions. The record stands at `last`, and an activation reads through its own message. */
class TwoQuestions implements RoomProtocol {
	readonly releases: Extract<LeaseRequest, { operation: 'release' }>[] = [];
	readonly commits: CommitRequest[] = [];
	readonly answers: string[] = [];

	constructor(
		private readonly last = 2,
		private readonly resume: Resume = 'recorded',
		public recorded?: HarnessSession,
	) {}

	async view(activation: string): Promise<ViewResponse> {
		const message = Number(activation.split(':')[1]);
		const resume = this.resume === 'recorded' ? this.recorded : undefined;
		return {
			view: {
				spec: {
					id: activation,
					seat: 'product',
					attempt: 1,
					purpose: { kind: 'respond', message },
					...(resume === undefined ? {} : { resume }),
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
		return { refused: 'nothing lands here' };
	}

	async lease(lease: LeaseRequest): Promise<LeaseResponse> {
		if (lease.operation === 'release') {
			this.releases.push(lease);
			this.recorded = lease.session;
		}
		// The record an activation sees stands at its own message.
		const seen = Number(lease.activation.split(':')[1]);
		return { ok: { expiresAt: Date.now() + 60_000, lastSeq: seen } };
	}
}

/** One storage for the run. Each `start` builds a fresh executor, a restart of the seat, over it. */
function harness(script: (context: Context, call: number) => ReturnType<typeof quiet>) {
	const seen: Context[] = [];
	const host = seatHost({
		name: 'memory',
		definition: scriptedAgent('product'),
		stream: scripted((context, _agent, call) => {
			seen.push({ ...context, messages: [...context.messages] });
			return script(context, call);
		}),
	});
	return { seen, ...host };
}

const texts = (context: Context) =>
	context.messages.map((message) => contextText({ ...context, messages: [message] }));

/** The transcript that the activation `message:<seq>:product:1` began. */
const began = (seq: number): HarnessSession => ({ harness: 'pi', id: `message:${seq}:product:1` });

/** Run both questions on one seat. Return the prompts of the last model request. */
async function askBoth(
	room = new TwoQuestions(),
	script: Parameters<typeof harness>[0] = () => quiet(),
) {
	const { seen, start } = harness(script);
	const actor = start(room);
	for (const activation of ['message:1:product:1', 'message:2:product:1']) {
		await actor.run(activation);
		await tick();
	}
	return { prompts: texts(seen.at(-1) as Context).filter((text) => text.length > 0) };
}

describe('exchange continuity', () => {
	it('continues the transcript the room names, prompts the delta, and records it', async () => {
		const room = new TwoQuestions();
		const { prompts } = await askBoth(room);
		// The first activation stays in the transcript. The second adds the delta alone.
		expect(prompts[0]).toContain("The record of 'memory' so far:");
		const last = prompts.at(-1) ?? '';
		expect(last).toContain('[new]');
		expect(last).toContain('And the pump?');
		expect(last).not.toContain('The record of');
		expect(room.releases.map((release) => release.session)).toEqual([began(1), began(1)]);
		expect(room.releases.at(-1)?.readThrough).toBe(2);
	});

	it('begins a fresh transcript when the view names none, as in a new exchange', async () => {
		const room = new TwoQuestions(2, 'none');
		const { prompts } = await askBoth(room);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("The record of 'memory' so far:");
		expect(room.releases.map((release) => release.session)).toEqual([began(1), began(2)]);
	});

	it('reads the whole view after a restart, and records the fresh transcript', async () => {
		const { seen, start } = harness(() => quiet());
		await start(new TwoQuestions()).run('message:1:product:1');
		await tick();
		const after = new TwoQuestions(2, 'recorded', began(1));
		await start(after).run('message:2:product:1');
		await tick();

		const prompts = texts(seen.at(-1) as Context).filter((text) => text.length > 0);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("The record of 'memory' so far:");
		expect(after.releases.at(-1)?.session).toEqual(began(2));
	});

	it('refuses a say against a record that moved', async () => {
		const room = new TwoQuestions(3);
		await askBoth(room, (_context, call) => (call === 2 ? speak('Yes.') : quiet()));
		// The continued seat read through 2. The record stands at 3, so the room answers missed.
		expect(room.commits.at(-1)?.readThrough).toBe(2);
		expect(room.answers.at(-1)).toBe('missed');
	});

	it('records no session for an activation that ran no pass', async () => {
		const room = new TwoQuestions();
		const executor = createPiExecutor({
			definition: scriptedAgent('product'),
			model: stubModel,
			stream: scripted(() => quiet()),
			now: () => 0,
		});
		const open = (id: string) => executor.open({ id, room, emit: () => {}, trace: noTrace });
		const first = open('message:1:product:1');
		const view = await room.view('message:1:product:1');
		if (!('view' in view)) throw new Error('The room answered stale.');
		await first.pass({ kind: 'view', view: view.view });
		expect(first.session).toEqual(began(1));
		// A cut before the first pass must not hand the kept transcript to a later exchange.
		const cut = open('message:2:product:1');
		cut.abort();
		expect(cut.session).toBeUndefined();
	});

	it.each([
		['a credit refusal in the text', 'Your credit balance is too low', {}, 'permanent'],
		[
			'a 401 in a diagnostic',
			'Refused.',
			{ diagnostics: [{ details: { status: '401' } }] },
			'permanent',
		],
		[
			'a 403 in a diagnostic code',
			'Refused.',
			{ diagnostics: [{ error: { code: 403 } }] },
			'permanent',
		],
		[
			'a 503 in a diagnostic',
			'Unavailable.',
			{ diagnostics: [{ details: { statusCode: 503 } }] },
			'transient',
		],
		['an overload with no status', 'Overloaded.', {}, 'transient'],
	] as const)(
		'fails on %s, and keeps the transcript it continued',
		async (_, text, extra, cause) => {
			const room = new TwoQuestions();
			const errors: string[] = [];
			const executor = createPiExecutor({
				definition: scriptedAgent('product'),
				model: stubModel,
				stream: scripted((_context, _agent, call) =>
					call === 1
						? quiet()
						: ({
								...fauxAssistantMessage('', { stopReason: 'error', errorMessage: text }),
								...extra,
							} as AssistantMessage),
				),
				now: () => 0,
			});
			const run = async (id: string) => {
				const session = executor.open({
					id,
					room,
					emit: (event) => {
						if (event.type === 'error') errors.push(event.error.message);
					},
					trace: noTrace,
				});
				const view = await room.view(id);
				if (!('view' in view)) throw new Error('The room answered stale.');
				const result = await session.pass({ kind: 'view', view: view.view });
				room.recorded = session.session;
				return { result, session: session.session };
			};
			await run('message:1:product:1');
			const failed = await run('message:2:product:1');
			expect(failed.result).toMatchObject({ failed: true, cause, message: text });
			expect(errors).toEqual([text]);
			expect(failed.session).toEqual(began(1));
		},
	);

	it('resolves a pass with no failure when it is cut during the model request', async () => {
		const room = new TwoQuestions();
		const requested = deferred();
		const executor = createPiExecutor({
			definition: scriptedAgent('product'),
			model: stubModel,
			stream: scripted(async () => {
				requested.resolve();
				await new Promise(() => {});
				return quiet();
			}),
			now: () => 0,
		});
		const session = executor.open({
			id: 'message:1:product:1',
			room,
			emit: () => {},
			trace: noTrace,
		});
		const view = await room.view('message:1:product:1');
		if (!('view' in view)) throw new Error('The room answered stale.');
		const running = session.pass({ kind: 'view', view: view.view });
		await requested.promise;
		session.abort();
		expect(await running).toEqual({ failed: false });
		expect(session.cancelled).toBe(true);
		expect(session.shouldRefresh?.(Number.MAX_SAFE_INTEGER)).toBe(false);
		// A cut activation keeps nothing, so it records no transcript.
		expect(session.session).toBeUndefined();
	});
});
