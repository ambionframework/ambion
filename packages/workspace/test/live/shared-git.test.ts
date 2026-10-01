/**
 * Two model-driven seats start from the same clone of `shared/notes`. The
 * first pushes a change; the second must read its rejected push, rebase, and
 * retry. The host stages only the common starting point so the live test can
 * prove the model's recovery from a real non-fast-forward response.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { TracedStep } from '@ambionframework/ambion';
import { expect, it, onTestFailed } from 'vitest';
import {
	agent,
	HARNESS,
	invariants,
	live,
	MODEL,
	open,
	person,
	report,
	spent,
	untilQuiet,
} from '../../../ambion/test/live/support.ts';
import { enter, roomName } from '../../../ambion/test/support/room.ts';
import { justGitBackend, sqliteGitStorage } from '../../../just-bash/src/git/index.ts';
import { memoryBackend } from '../../../just-bash/src/index.ts';
import { BACKGROUND_CONTEXT, openWorkspace, runScript } from '../../src/index.ts';

const FIRST = 'scribe-a';
const SECOND = 'scribe-b';
const REMOTE = 'http://git.ambion.invalid/shared/notes';

interface BashCall {
	readonly command: string;
	readonly output: string;
	readonly error: string | undefined;
}

function bashCalls(records: readonly TracedStep[], seat: string): BashCall[] {
	const steps = records.filter((record) => record.seat === seat).map((record) => record.step);
	return steps.flatMap((step) => {
		if (step.type !== 'tool_call' || step.name !== 'bash') return [];
		const result = steps.find((other) => other.type === 'tool_result' && other.call === step.call);
		const command = (step.input as { command?: unknown }).command;
		const output = result?.type === 'tool_result' ? JSON.stringify(result.output) : '';
		return [
			{
				command: typeof command === 'string' ? command : '',
				output,
				error: result?.type === 'tool_result' ? result.error : 'The call has no result.',
			},
		];
	});
}

function keepEvidence(evidence: () => unknown): void {
	onTestFailed(() => saveEvidence(evidence()));
}

function saveEvidence(evidence: unknown): void {
	const dir = new URL('./runs/', import.meta.url);
	mkdirSync(dir, { recursive: true });
	const path = new URL('shared-git-rebase.json', dir);
	writeFileSync(path, JSON.stringify(evidence, null, 2));
	process.stdout.write(`workspace live · shared git rebase: evidence in ${path.pathname}\n`);
}

async function runScriptOrThrow(
	workspace: ReturnType<typeof openWorkspace>,
	seat: string,
	command: string,
): Promise<string> {
	const result = await workspace.use({ name: seat }, (env) =>
		runScript(env, command, undefined, BACKGROUND_CONTEXT),
	);
	if (!result.ok) throw result.error;
	if (result.value.exitCode !== 0)
		throw new Error(`Host staging failed (${result.value.exitCode}): ${result.value.output}`);
	return result.value.output;
}

live('shared git rebase', () => {
	it('a seat recovers from a rejected push by rebasing and retrying', async () => {
		const workspace = openWorkspace({
			name: roomName('shared-git'),
			backend: {
				bash: memoryBackend({
					git: justGitBackend({
						storage: sqliteGitStorage(':memory:'),
						secret: 'live-test-secret',
						shared: {
							notes: {
								description: 'Working notes shared by the writing seats.',
								source: {
									'scribe-a.md': 'scribe-a: pending\n',
									'scribe-b.md': 'scribe-b: pending\n',
								},
							},
						},
					}),
				}),
			},
		});
		const evidence: {
			baseline?: string[];
			first?: BashCall[];
			second?: BashCall[];
			finalNotes?: string;
			model?: string;
			harness?: string;
			thinking?: string;
			usage?: Awaited<ReturnType<typeof spent>>;
		} = {};
		let records: readonly TracedStep[] = [];
		keepEvidence(() => ({
			...evidence,
			first: bashCalls(records, FIRST),
			second: bashCalls(records, SECOND),
		}));
		const stop: (() => Promise<void>)[] = [];
		try {
			// Both independent home directories get the same baseline before either
			// model activation begins, guaranteeing the second push must be stale.
			for (const seat of [FIRST, SECOND]) {
				await runScriptOrThrow(
					workspace,
					seat,
					`git clone ${REMOTE} ~/notes && cd ~/notes && git rev-parse HEAD`,
				);
			}
			evidence.baseline = await Promise.all(
				[FIRST, SECOND].map((seat) =>
					runScriptOrThrow(workspace, seat, 'cd ~/notes && git rev-parse HEAD'),
				),
			);
			expect(evidence.baseline[0]).toBe(evidence.baseline[1]);

			const firstWriter = agent(FIRST, {
				identity: 'Keeps the first line of the shared team notes.',
				instructions: `
					For this assignment, change only ~/notes/scribe-a.md from
					"scribe-a: pending" to "scribe-a: reviewed". Commit the
					change and push main to origin once. Do not fetch or rebase before
					that first push. Do not call say; finish after the push succeeds.
				`,
				bundles: [workspace.tools()],
			});
			const secondWriter = agent(SECOND, {
				identity: 'Keeps the second line of the shared team notes.',
				instructions: `
					For this assignment, change only ~/notes/scribe-b.md from
					"scribe-b: pending" to "scribe-b: checked". Commit the
					change and push main to origin once. Your checkout started at the
					original shared commit, so the push may be rejected. Do not fetch
					before attempting the initial push; use its result to decide whether
					to fetch. If it is rejected because main advanced, run
					"git fetch origin", rebase with "git rebase origin/main", and retry
					"git push origin main". Preserve both notes. Do not call say; finish
					after the push succeeds.
				`,
				bundles: [workspace.tools()],
			});
			const room = await open('shared-git', {
				agents: [firstWriter, secondWriter],
				seats: { [FIRST]: 'broadcast' },
			});
			stop.push(() => room.session.stop());
			records = room.records;
			const visit = await enter(room.session, person);
			await visit.send({
				text: 'Update your assigned note in the shared repository, commit it, and push main to origin.',
			});
			await untilQuiet(room.session);
			evidence.first = bashCalls(records, FIRST);
			const firstPush = evidence.first.find((call) =>
				/git push\s+origin\s+main/.test(call.command),
			);
			expect(firstPush, JSON.stringify(evidence.first)).toBeDefined();
			expect(firstPush?.output).not.toMatch(/rejected|non-fast-forward/i);

			// Both definitions belong to the same room. Only the first hears the
			// opening request; swap seats after its exchange is quiet so the second
			// starts with its pre-staged clone of the original shared commit.
			await room.session.unseat(FIRST);
			await room.session.seat(SECOND);
			await visit.send({
				text: 'Update your assigned note in the shared repository, commit it, and push main to origin. If it is rejected, rebase and retry.',
			});
			await untilQuiet(room.session);
			evidence.second = bashCalls(records, SECOND);
			await invariants(room.session, room.events);

			const rejectedAt = evidence.second.findIndex(
				(call) =>
					/git push\s+origin\s+main/.test(call.command) &&
					/rejected|non-fast-forward|fetch first/i.test(`${call.output} ${call.error ?? ''}`),
			);
			const recovery = evidence.second.flatMap((call, index) => {
				if (index <= rejectedAt) return [];
				return [
					{ kind: 'fetch', at: call.command.search(/\bgit fetch\s+origin\b/), call: index },
					{ kind: 'rebase', at: call.command.search(/\bgit rebase\s+origin\/main\b/), call: index },
					{ kind: 'push', at: call.command.search(/\bgit push\s+origin\s+main\b/), call: index },
				]
					.filter((operation) => operation.at >= 0)
					.sort((left, right) => left.at - right.at);
			});
			const fetchAt = recovery.findIndex((operation) => operation.kind === 'fetch');
			const rebaseAt = recovery.findIndex(
				(operation, index) => index > fetchAt && operation.kind === 'rebase',
			);
			const retryAt = recovery.findIndex(
				(operation, index) => index > rebaseAt && operation.kind === 'push',
			);
			expect(rejectedAt, JSON.stringify(evidence.second)).toBeGreaterThanOrEqual(0);
			expect(fetchAt, JSON.stringify(evidence.second)).toBeGreaterThanOrEqual(0);
			expect(rebaseAt, JSON.stringify(evidence.second)).toBeGreaterThan(fetchAt);
			expect(retryAt, JSON.stringify(evidence.second)).toBeGreaterThan(rebaseAt);
			const retryCall = recovery[retryAt]?.call;
			expect(evidence.second[retryCall ?? -1]?.output).not.toMatch(/rejected|non-fast-forward/i);

			const verified = await runScriptOrThrow(
				workspace,
				'reviewer',
				`git clone ${REMOTE} ~/notes && cat ~/notes/scribe-a.md && cat ~/notes/scribe-b.md`,
			);
			evidence.finalNotes = verified;
			expect(verified).toContain('scribe-a: reviewed');
			expect(verified).toContain('scribe-b: checked');

			evidence.model = MODEL;
			evidence.harness = HARNESS;
			if (process.env.AMBION_THINKING !== undefined)
				evidence.thinking = process.env.AMBION_THINKING;
			evidence.usage = await spent(room.session);
			report('shared git rebase', evidence.usage);
			saveEvidence(evidence);
		} finally {
			for (const close of stop.reverse()) await close();
			await workspace.dispose();
		}
	});
});
