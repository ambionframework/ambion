/**
 * Memory modes. `activation` builds a fresh Pi agent for each activation.
 * `seat` builds the next agent over the transcript the seat kept, prompts
 * it with the delta, and records the seat session on every release.
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
import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { scriptedAgent, tick } from '../../ambion/test/support/room.ts';
import { contextText, quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { pi, seatSessionId } from '../src/index.ts';
import { seatHost } from './support/runner.ts';

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

	constructor(
		private readonly last = 2,
		private readonly resume?: HarnessSession,
	) {}

	async view(activation: string): Promise<ViewResponse> {
		const message = Number(activation.split(':')[1]);
		return {
			view: {
				spec: {
					id: activation,
					seat: 'product',
					attempt: 1,
					purpose: { kind: 'respond', message },
					...(this.resume === undefined ? {} : { resume: this.resume }),
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
		if (lease.operation === 'release') this.releases.push(lease);
		// The record an activation sees stands at its own message.
		const seen = Number(lease.activation.split(':')[1]);
		return { ok: { expiresAt: Date.now() + 60_000, lastSeq: seen } };
	}
}

/** One storage for the run. Each `start` builds a fresh executor, a restart of the seat, over it. */
function harness(
	memory: 'activation' | 'seat' | undefined,
	script: (context: Context, call: number) => ReturnType<typeof quiet>,
) {
	const seen: Context[] = [];
	const host = seatHost({
		name: 'memory',
		definition: scriptedAgent('product', undefined, memory === undefined ? {} : { memory }),
		stream: scripted((context, _agent, call) => {
			seen.push({ ...context, messages: [...context.messages] });
			return script(context, call);
		}),
	});
	return { seen, ...host };
}

const texts = (context: Context) =>
	context.messages.map((message) => contextText({ ...context, messages: [message] }));

const SESSION = { harness: 'pi', id: seatSessionId('memory', 'product') };

/** Run both questions on one seat. Return the prompts of the last model request. */
async function askBoth(
	memory: 'activation' | 'seat' | undefined,
	room = new TwoQuestions(),
	script: Parameters<typeof harness>[1] = () => quiet(),
) {
	const { seen, services, start } = harness(memory, script);
	const actor = start(room);
	for (const activation of ['message:1:product:1', 'message:2:product:1']) {
		await actor.run(activation);
		await tick();
	}
	return { prompts: texts(seen.at(-1) as Context).filter((text) => text.length > 0), services };
}

describe('seat memory', () => {
	it('keeps the transcript, prompts the delta, and records the seat session', async () => {
		const room = new TwoQuestions();
		const { prompts, services } = await askBoth('seat', room);
		// The first activation stays in the transcript. The second adds the delta alone.
		expect(prompts[0]).toContain("The record of 'memory' so far:");
		const last = prompts.at(-1) ?? '';
		expect(last).toContain('[new]');
		expect(last).toContain('And the pump?');
		expect(last).not.toContain('The record of');
		expect(room.releases.map((release) => release.session)).toEqual([SESSION, SESSION]);
		expect(room.releases.at(-1)?.readThrough).toBe(2);

		const audit = await services.transcripts.open(SESSION.id);
		const turns = (await audit.findEntries({ order: 'oldestFirst' })).filter(
			(entry) => entry.type === 'message',
		);
		// Two prompts and two answers, and nothing written twice.
		expect(turns).toHaveLength(4);
	});

	it('reads the whole view again after a restart, and records the same session', async () => {
		const { seen, start } = harness('seat', () => quiet());
		await start(new TwoQuestions()).run('message:1:product:1');
		await tick();
		const after = new TwoQuestions(2, SESSION);
		await start(after).run('message:2:product:1');
		await tick();

		const prompts = texts(seen.at(-1) as Context).filter((text) => text.length > 0);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("The record of 'memory' so far:");
		expect(after.releases.at(-1)?.session).toEqual(SESSION);
	});

	it('refuses a say against a record that moved, as activation memory does', async () => {
		const room = new TwoQuestions(3);
		await askBoth('seat', room, (_context, call) => (call === 2 ? speak('Yes.') : quiet()));
		// The resumed seat read through 2. The record stands at 3, so the room answers missed.
		expect(room.commits.at(-1)?.readThrough).toBe(2);
		expect(room.answers.at(-1)).toBe('missed');
	});
});

describe('activation memory', () => {
	it.each([undefined, 'activation'] as const)(
		'builds a fresh agent per activation and records no session (%s)',
		async (memory) => {
			const room = new TwoQuestions();
			const { prompts } = await askBoth(memory, room);
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("The record of 'memory' so far:");
			expect(room.releases.map((release) => release.session)).toEqual([undefined, undefined]);
		},
	);

	it('mirrors the option onto the executor', () => {
		expect(pi({ instructions: '', model: 'm' }).memory).toBeUndefined();
		expect(pi({ instructions: '', model: 'm', memory: 'seat' }).memory).toBe('seat');
	});
});
