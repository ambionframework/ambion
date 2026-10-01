/**
 * Exchange continuity on the real SDK. Each activation records its session.
 * The first activation in a new exchange starts fresh, so it reads the file
 * again. A resume the SDK cannot honor falls back to a fresh session and the
 * seat still speaks. The fake executable proves the resume inside one
 * exchange (`../memory.test.ts`).
 */
import { Type } from 'typebox';
import { expect, it } from 'vitest';
import { ActivationState } from '../../../ambion/src/execution/activation.ts';
import type { CommitRequest, RoomProtocol, StepSink } from '../../../ambion/src/hosting.ts';
import { defineTool, isSpoken, type Step } from '../../../ambion/src/index.ts';
import { enter, messagesOf } from '../../../ambion/test/support/room.ts';
import { createClaudeExecutor } from '../../src/executor.ts';
import { viewOf } from '../support.ts';
import { live, open, person, seat, stepsOfType, untilQuiet, within } from './support.ts';

const CODE = 'TANGO-7731';

/** The tool that holds the code. The model has no other way to know it. */
const readCode = defineTool({
	name: 'read_code',
	description: 'Read the gate code from the site register.',
	parameters: Type.Object({}),
	execute: () => `The gate code is ${CODE}.`,
});

const definition = () =>
	seat('keeper', 'Reads the code when asked.', {
		instructions: `
			When somebody asks you to read the code, call read_code and answer with
			one say that says only "Read." and does not quote the code. When
			somebody asks for the code and you already know it, answer with one
			say that quotes it, and call nothing. When you do not know it, call
			read_code first.
		`,
		tools: [readCode],
	});

/** Two exchanges with one seat. Returns the steps of each activation and the said texts. */
async function twoQuestions() {
	const { session, steps: stepsOf } = await open('memory', [definition()]);
	try {
		const visit = await enter(session, person);
		const ids: string[] = [];
		session.subscribe((e) => {
			if (e.type === 'activation_start' && e.agent === 'keeper') ids.push(e.activation);
		});
		await visit.send({ text: 'Please read the code.' });
		await untilQuiet(session);
		const first = ids[0];
		await visit.send({ text: 'What is the code? Answer from memory if you can.' });
		await untilQuiet(session);
		const second = ids.at(-1);
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		const said = (await messagesOf(session))
			.filter(isSpoken)
			.filter((m) => m.from === 'keeper')
			.map((m) => m.text);
		const exchanges = (await session.read()).exchanges;
		return {
			firstSteps: stepsOf(first ?? ''),
			secondSteps: stepsOf(second ?? ''),
			said,
			sessions: exchanges.flatMap((x) => x.activations.map((a) => a.session)),
		};
	} finally {
		await session.stop();
	}
}

const reads = (steps: Parameters<typeof stepsOfType>[0]) =>
	stepsOfType(steps, 'tool_call').filter((s) => s.name === 'read_code');

live('memory', () => {
	it('records a session for each activation, and starts fresh in a new exchange', async () => {
		const run = await twoQuestions();
		expect(reads(run.firstSteps).length).toBeGreaterThanOrEqual(1);
		expect(reads(run.secondSteps).length).toBeGreaterThanOrEqual(1);
		expect(run.said.at(-1)).toContain(CODE);
		const ids = run.sessions.flatMap((s) => (s?.harness === 'claude' ? [s.id] : []));
		expect(ids.length).toBeGreaterThanOrEqual(2);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('a resume the SDK cannot honor falls back to a fresh session, and the seat still speaks', async () => {
		const bogus = crypto.randomUUID();
		const commits: CommitRequest[] = [];
		const steps: Step[] = [];
		let seq = 1;
		const room: RoomProtocol = {
			view: async () => ({ stale: 'unused' }),
			lease: async () => ({ stale: 'unused' }),
			commit: async (request) => {
				commits.push(request);
				if (request.intent.kind !== 'said') return { refused: 'unused' };
				seq += 1;
				return {
					committed: {
						kind: 'said',
						seq,
						at: new Date().toISOString(),
						from: 'sonnet',
						text: request.intent.text,
					},
				};
			},
		};
		const trace: StepSink = {
			record: (step) => void steps.push(step),
		};
		const definition = seat('sonnet', 'Answers what is asked.', {
			instructions: 'Answer the question with one say, in one sentence. Guess if you must.',
		});
		const executor = createClaudeExecutor({ definition });
		const view = viewOf();
		const session = new ActivationState(executor, {
			id: view.spec.id,
			room,
			definition,
			emit: () => {},
			trace,
		});
		try {
			const result = await within(
				session.pass({
					kind: 'view',
					view: { ...view, spec: { ...view.spec, resume: { harness: 'claude', id: bogus } } },
				}),
				150_000,
				'the pass',
			);
			expect(result).toEqual({ failed: false });
			expect(commits.some((c) => c.intent.kind === 'said')).toBe(true);
			// The fresh session has its own id, and the release records it.
			expect(session.session?.harness).toBe('claude');
			expect(session.session?.id).not.toBe(bogus);
		} finally {
			session.close?.();
		}
	});
});
