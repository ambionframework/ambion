/**
 * A seat over a room that holds two questions, for the tests that run the
 * Pi executor activation by activation: continuity, crash recovery, and the
 * harness setup. The record stands at `last`, and an activation reads
 * through its own message.
 */
import type { AgentDefinition, Message, Step } from '@ambionframework/ambion';
import type {
	ActivationSpec,
	ActivationView,
	CommitRequest,
	CommitResult,
	LeaseRequest,
	LeaseResponse,
	RoomProtocol,
	VendorSession,
	ViewResponse,
} from '@ambionframework/ambion/hosting';
import { quiet } from '@ambionframework/ambion/testing';
import type { Context } from '@earendil-works/pi-ai';
import { scriptedAgent } from '../../../ambion/test/support/room.ts';
import { createPiOpener } from '../../src/executor.ts';
import { stubModel } from '../../src/index.ts';
import type { PiSessions } from '../../src/sessions.ts';
import { contextText, type PiScript, scriptedStream } from '../../src/testing.ts';
import { stateOf } from './activation.ts';
import { noTrace } from './trace.ts';

export const said = (seq: number, text: string): Message => ({
	kind: 'said',
	seq,
	at: '2026-01-01T09:00:00.000Z',
	from: 'andrei',
	text,
});

export const RECORD = [said(1, 'Can we ship?'), said(2, 'And the pump?')];

/** A room with two questions. The record stands at `last`, and an activation reads through its own message. */
export class TwoQuestions implements RoomProtocol {
	readonly releases: Extract<LeaseRequest, { operation: 'release' }>[] = [];
	readonly commits: CommitRequest[] = [];
	readonly answers: string[] = [];

	private readonly last: number;

	constructor(last = 2) {
		this.last = last;
	}

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
					exchange: { person: 'andrei', from: 1 },
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
		return { ok: { expiresAt: Date.now() + 60_000, through: this.last } };
	}
}

/** The session that the activation `message:<seq>:product:1` began. */
export const began = (seq: number): VendorSession => ({
	kind: 'pi',
	id: `message:${seq}:product:1`,
});

/** What the model read of each message of a request, as text. */
export const texts = (context: Context) =>
	context.messages.map((message) => contextText({ ...context, messages: [message] }));

/** The view the room gives an activation. */
export async function viewOf(id: string, room = new TwoQuestions()) {
	const answer = await room.view(id);
	if (!('view' in answer)) throw new Error('The room answered stale.');
	return answer.view;
}

/**
 * One executor for the seat over `sessions`. `run` opens one activation,
 * runs its first pass over the view the room gives with the spec changes it
 * names, and closes it as the driver does.
 */
export function seatOn(
	room: TwoQuestions,
	sessions: PiSessions,
	script: PiScript = () => quiet(),
	definition: AgentDefinition = scriptedAgent('product'),
) {
	const seen: Context[] = [];
	const errors: string[] = [];
	const notices: Step[] = [];
	const opener = createPiOpener({
		definition,
		model: stubModel,
		stream: scriptedStream((context, agent, request) => {
			seen.push({ ...context, messages: [...context.messages] });
			return script(context, agent, request);
		}),
		now: () => 0,
		sessions,
	});
	const run = async (
		id: string,
		spec: Partial<ActivationSpec> = {},
		context: Partial<ActivationView['context']> = {},
	) => {
		const view = await viewOf(id, room);
		const session = stateOf(opener, definition, {
			id,
			room,
			trace: {
				...noTrace,
				record: (step) => {
					if (step.type === 'notice') notices.push(step);
				},
			},
			emit: (event) => {
				if (event.type === 'error') errors.push(event.error.message);
			},
		});
		const result = await session.pass({
			kind: 'view',
			view: {
				...view,
				spec: { ...view.spec, ...spec },
				context: { ...view.context, ...context },
			},
		});
		const recorded = { result, session: session.session, readThrough: session.readThrough };
		session.close?.();
		return recorded;
	};
	return { seen, errors, notices, run, opener, definition };
}
