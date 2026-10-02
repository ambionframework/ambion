/**
 * What the unit tests share: the fake executable, a view of a small room,
 * and the activations of one executor over a room that records what the
 * seat commits.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineAgent, type Step } from '@ambionframework/ambion';
import type {
	ActivationEvent,
	ActivationOpener,
	ActivationView,
	AgentDefinition,
	CommitRequest,
	RoomProtocol,
	RunningActivation,
	StepSink,
} from '@ambionframework/ambion/hosting';
import { ActivationState } from '../../ambion/src/execution/activation.ts';
import { type ClaudeOpenerOptions, createClaudeOpener } from '../src/executor.ts';
import { type ClaudeOptions, claude } from '../src/index.ts';
import type { FakeScenario } from '../src/testing.ts';

export const executable = fileURLToPath(new URL('./fake/claude-executable.mjs', import.meta.url));

export const seat = (options: Partial<ClaudeOptions> = {}): AgentDefinition =>
	defineAgent({
		name: 'sonnet',
		identity: 'Answers what is asked.',
		executor: claude({ instructions: 'Answer once.', model: 'claude-fake', ...options }),
	});

/** The view a seat reads when the person asked one question at position 1. */
export function viewOf(through = 1): ActivationView {
	return {
		spec: {
			id: 'message:1:sonnet:1',
			seat: 'sonnet',
			attempt: 1,
			purpose: { kind: 'respond', message: 1 },
		},
		through,
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
					name: 'sonnet',
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
}

/** A scenario of the fake, with the fields that only the tests set. */
export type Scenario = FakeScenario & {
	session?: string;
	apiKeySource?: string;
	claudeVersion?: string;
	initTools?: string[];
	rejectResume?: boolean;
	rejectResumeResult?: boolean;
	echoOnTurn?: boolean;
};

/** An executor of `definition` over the fake, and a room that records what the seat commits. */
export function fakeRoom(
	scenario: Scenario,
	definition: AgentDefinition = seat(),
	env: Readonly<Record<string, string>> = {},
	extra: Pick<ClaudeOpenerOptions, 'configRoot' | 'room' | 'seat'> = {},
) {
	const file = join(mkdtempSync(join(tmpdir(), 'ambion-claude-')), 'fake.log');
	const steps: Step[] = [];
	const commits: CommitRequest[] = [];
	const answers: ('committed' | 'missed')[] = [];
	const events: ActivationEvent[] = [];
	let lastSeq = 1;
	const room: RoomProtocol = {
		view: async () => ({ stale: 'unused' }),
		lease: async () => ({ stale: 'unused' }),
		commit: async (request) => {
			commits.push(request);
			// The room refuses a say against a record that moved.
			if ((request.readThrough ?? 0) < lastSeq) {
				answers.push('missed');
				return { missed: [] };
			}
			answers.push('committed');
			lastSeq += 1;
			if (request.intent.kind !== 'said') return { refused: 'unused' };
			return {
				committed: {
					kind: 'said',
					seq: lastSeq,
					at: new Date(0).toISOString(),
					from: 'sonnet',
					text: request.intent.text,
				},
			};
		},
	};
	const trace: StepSink = {
		record: (step) => void steps.push(step),
	};
	const opener = createClaudeOpener({
		definition,
		pathToClaudeCodeExecutable: executable,
		env: { ...env, AMBION_FAKE: JSON.stringify({ ...scenario, log: file }) },
		...extra,
	});
	const sessions: RunningActivation[] = [];
	const recording: ActivationOpener = (activation) => {
		const session = opener(activation);
		sessions.push(session);
		return session;
	};
	/** The lines the fake wrote to its log. */
	const log = (): Record<string, unknown>[] => {
		try {
			return readFileSync(file, 'utf8')
				.split('\n')
				.filter((line) => line !== '')
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		} catch {
			return [];
		}
	};
	return {
		steps,
		commits,
		answers,
		events,
		log,
		/** The environment facts of each start of the fake, in order: names, and the values it logs. */
		envs: () =>
			log().flatMap((line) =>
				'env' in line ? [line.env as { names: string[]; values: Record<string, string> }] : [],
			),
		/** The argument list of each start of the fake, in order. */
		argvs: () => log().flatMap((line) => ('argv' in line ? [line.argv as string[]] : [])),
		moveRecordTo: (seq: number) => {
			lastSeq = seq;
		},
		/** The executor sessions that the core opened, with no core state around them. */
		sessions,
		/** The core state of one activation, as the driver opens it. */
		activate: (id: string): ActivationState =>
			new ActivationState(recording, {
				id,
				room,
				definition,
				emit: (event) => void events.push(event),
				trace,
			}),
	};
}

/** Open one activation of `definition` over the fake, with a scenario. */
export function open(
	scenario: Scenario,
	definition: AgentDefinition = seat(),
	env: Readonly<Record<string, string>> = {},
	extra: Pick<ClaudeOpenerOptions, 'configRoot' | 'room' | 'seat'> = {},
) {
	const room = fakeRoom(scenario, definition, env, extra);
	return { ...room, session: room.activate('message:1:sonnet:1') };
}

/** Wait until `read` holds, for at most `ms` milliseconds. */
export async function until(read: () => boolean, what: string, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!read()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
