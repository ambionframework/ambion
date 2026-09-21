/**
 * Memory modes on the real SDK. Under `seat` a second activation resumes the
 * SDK session and answers from what the first read. Under `activation` it
 * starts fresh. A resume the SDK cannot honor falls back to a fresh session
 * and the seat still speaks.
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { CommitRequest, RoomProtocol, TraceSink } from '../../../ambion/src/hosting.ts';
import { isSpoken, type Step } from '../../../ambion/src/index.ts';
import { enter, messagesOf } from '../../../ambion/test/support/room.ts';
import { traceOf } from '../../../ambion/test/support/trace.ts';
import { createClaudeExecutor } from '../../src/index.ts';
import { viewOf } from '../support.ts';
import { live, open, person, seat, stepsOfType, untilQuiet, within } from './support.ts';

const CODE = 'TANGO-7731';

async function directory(): Promise<string> {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ambion-live-memory-')));
	await writeFile(join(cwd, 'code.txt'), `${CODE}\n`);
	return cwd;
}

const definition = (memory: 'activation' | 'seat', cwd: string) =>
	seat('keeper', 'Reads the code file when asked.', {
		instructions: `
			When somebody asks you to read code.txt, read it with the Read tool and
			answer with one say that says only "Read." and does not quote the file.
			When somebody asks for the code and you already know it, answer with
			one say that quotes it, and read nothing. When you do not know it, read
			code.txt first.
		`,
		allowedTools: ['Read'],
		cwd,
		memory,
	});

/** Two exchanges with one seat. Returns the steps of each activation and the said texts. */
async function twoQuestions(memory: 'activation' | 'seat') {
	const cwd = await directory();
	const { session, runtime, name } = await open(`memory-${memory}`, [definition(memory, cwd)]);
	try {
		const visit = await enter(session, person);
		const ids: string[] = [];
		session.subscribe((e) => {
			if (e.type === 'activation_start' && e.agent === 'keeper') ids.push(e.activation);
		});
		await visit.send({ text: 'Please read code.txt.' });
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
			firstSteps: await traceOf(runtime, name, first ?? ''),
			secondSteps: await traceOf(runtime, name, second ?? ''),
			said,
			sessions: exchanges.flatMap((x) => x.activations.map((a) => a.session)),
		};
	} finally {
		await session.stop();
		await rm(cwd, { recursive: true, force: true });
	}
}

const reads = (steps: Parameters<typeof stepsOfType>[0]) =>
	stepsOfType(steps, 'tool_call').filter((s) => s.name === 'Read');

live('memory', () => {
	it("'seat' memory resumes the session, and the second activation answers from what it read", async () => {
		const run = await twoQuestions('seat');
		expect(reads(run.firstSteps).length).toBeGreaterThanOrEqual(1);
		expect(reads(run.secondSteps)).toEqual([]);
		expect(run.said.at(-1)).toContain(CODE);
		expect(run.said[0] ?? '').not.toContain(CODE);
		// Each activation recorded the SDK session it ended in.
		expect(run.sessions.filter((s) => s?.harness === 'claude').length).toBeGreaterThanOrEqual(2);
	});

	it("'activation' memory starts each activation fresh, so the second reads the file again", async () => {
		const run = await twoQuestions('activation');
		expect(reads(run.secondSteps).length).toBeGreaterThanOrEqual(1);
		expect(run.sessions.filter((s) => s !== undefined)).toEqual([]);
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
		const trace: TraceSink = {
			startPass: () => {},
			record: (step) => void steps.push(step),
			usage: () => undefined,
			close: async () => {},
		};
		const executor = createClaudeExecutor({
			definition: seat('sonnet', 'Answers what is asked.', {
				instructions: 'Answer the question with one say, in one sentence. Guess if you must.',
				memory: 'seat',
			}),
		});
		const view = viewOf();
		const session = executor.open({
			id: view.spec.id,
			room,
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
