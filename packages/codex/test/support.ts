/**
 * What the unit tests share: a view of a small room, and one activation
 * opened over a fake app-server and a room that records what the seat
 * commits.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineAgent, type Step } from '@ambionframework/ambion';
import type {
	ActivationEvent,
	ActivationView,
	AgentDefinition,
	CommitRequest,
	CommitResult,
	RoomProtocol,
	StepSink,
} from '@ambionframework/ambion/hosting';
import { ActivationState } from '../../ambion/src/execution/activation.ts';
import type { CatalogEntry, CatalogSource } from '../src/catalog.ts';
import { createCodexOpener } from '../src/executor.ts';
import { type CodexOptions, codex } from '../src/index.ts';
import type { DynamicToolCallResponse } from '../src/protocol.ts';
import { type FakeOptions, type FakeTurn, fakeServer } from './fake.ts';

/** The catalog entries that a real `codex` 0.159.2 printed, for `gpt-5.6-luna` and `gpt-5.5`. */
export const catalogFixture = JSON.parse(
	readFileSync(new URL('./fixtures/catalog-0.159.2.json', import.meta.url), 'utf8'),
) as { models: CatalogEntry[] };

/** A catalog source that reads the recorded entries. */
export const recordedCatalog: CatalogSource = async (model) =>
	catalogFixture.models.find((entry) => entry.slug === model);

export const seat = (options: Partial<CodexOptions> = {}): AgentDefinition =>
	defineAgent({
		name: 'gpt',
		identity: 'Answers what is asked.',
		executor: codex({ instructions: 'Answer once.', model: 'gpt-5.6-luna', ...options }),
	});

/** The view a seat reads when the person asked one question at position 1. */
export function viewOf(
	purpose: ActivationView['spec']['purpose'] = { kind: 'respond', message: 1 },
) {
	const view: ActivationView = {
		spec: { id: 'message:1:gpt:1', seat: 'gpt', attempt: 1, purpose },
		through: 1,
		context: {
			name: 'lab',
			now: 0,
			participants: [
				{
					kind: 'person',
					name: 'priya',
					identity: 'Project manager.',
					presence: 'present',
					messagesSinceDeparture: 0,
				},
				{
					kind: 'agent',
					name: 'gpt',
					identity: 'Answers what is asked.',
					status: 'active',
					attention: 'broadcast',
				},
			],
			messages: [
				{
					kind: 'said',
					seq: 1,
					at: new Date(0).toISOString(),
					from: 'priya',
					text: 'When is the pour?',
				},
			],
			exchange: { person: 'priya', from: 1 },
			reserve: [],
		},
	};
	return view;
}

/** A room that answers every commit with `answer`, and records what it was asked. */
export function roomOf(answer: (request: CommitRequest) => CommitResult) {
	const commits: CommitRequest[] = [];
	const room: RoomProtocol = {
		view: async () => ({ stale: 'unused' }),
		lease: async () => ({ stale: 'unused' }),
		commit: async (request) => {
			commits.push(request);
			return answer(request);
		},
	};
	return { room, commits };
}

/** The answer of a room that lands every said at the next position. */
export function lands(request: CommitRequest): CommitResult {
	if (request.intent.kind !== 'said') return { refused: 'unused' };
	return {
		committed: {
			kind: 'said',
			seq: 2,
			at: new Date(0).toISOString(),
			from: 'gpt',
			text: request.intent.text,
		},
	};
}

/** The Codex home of the executors in this file. The fake never reads it, and it never holds a login. */
const SEAT_HOME = mkdtempSync(join(tmpdir(), 'ambion-codex-seat-'));
process.once('exit', () => rmSync(SEAT_HOME, { recursive: true, force: true }));

/** A turn that says `text` through the room tool, and then answers in its own words. */
export function sayingTurn(text: string): FakeTurn {
	return async (turn) => {
		await turn.call('say', { text });
		turn.usage();
		turn.reply('done');
		turn.usage();
		return undefined;
	};
}

/** A turn that answers in its own words and calls no tool. */
export const plainTurn: FakeTurn = (turn) => {
	turn.reply('2 plus 2 equals 4.');
	turn.usage();
	return undefined;
};

/** The text of a tool result. */
export function textOf(result: DynamicToolCallResponse): string {
	return result.contentItems.map((part) => (part.type === 'inputText' ? part.text : '')).join('');
}

/** An executor of `definition` over a fake app-server, and a way to open its activations. */
export function open(
	turns: readonly FakeTurn[],
	definition: AgentDefinition = seat(),
	answer: (request: CommitRequest) => CommitResult = lands,
	catalog: CatalogSource = recordedCatalog,
	options: FakeOptions = {},
) {
	const steps: Step[] = [];
	const events: ActivationEvent[] = [];
	const { room, commits } = roomOf(answer);
	const fake = fakeServer(turns, options);
	const trace: StepSink = {
		record: (step) => void steps.push(step),
	};
	const opener = createCodexOpener({
		definition,
		connect: fake.connect,
		catalog,
		codexPath: '/fake/codex',
		home: SEAT_HOME,
		login: false,
	});
	/** The core state of one activation, as the driver opens it. */
	const activate = (id = 'message:1:gpt:1') =>
		new ActivationState(opener, {
			id,
			room,
			definition,
			emit: (event) => void events.push(event),
			trace,
		});
	return { opener, steps, commits, events, activate, fake };
}

/** Wait until `read` holds, for at most `ms` milliseconds. */
export async function until(read: () => boolean, what: string, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!read()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
