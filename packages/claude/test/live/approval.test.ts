/**
 * A permission request reaches `canUseTool`, and each answer becomes one
 * approval step. The executor lists only the built-in tools that
 * `allowedTools` names, so a request needs a pattern: `Bash(echo:*)` shows
 * the shell to the model and runs only `echo` with no request.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { enter } from '../../../ambion/test/support/room.ts';
import { traceOf } from '../../../ambion/test/support/trace.ts';
import { live, open, person, seat, stepsOfType, untilQuiet, within } from './support.ts';

live('approval', () => {
	it('answers each request once, runs the allowed tool, and leaves the denied one unrun', async () => {
		const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ambion-live-approval-')));
		const asked: string[] = [];
		const runner = seat('runner', 'Runs shell commands when asked.', {
			instructions: `
				When somebody asks for shell commands, run each one with the Bash
				tool, in the order given, one command per call. Then answer with one
				say, in one sentence, that says which commands ran and which were
				refused.
			`,
			allowedTools: ['Bash(echo:*)'],
			cwd,
			canUseTool: async (name, input) => {
				const command = String((input as { command?: unknown }).command ?? '');
				asked.push(`${name}:${command}`);
				return /\bpwd\b/.test(command)
					? { behavior: 'allow', updatedInput: input }
					: { behavior: 'deny', message: 'The room allows pwd and nothing else.' };
			},
		});
		const { session, runtime, name, events } = await open('approval', [runner]);
		try {
			const visit = await enter(session, person);
			const started = new Promise<string>((resolve) => {
				session.subscribe((e) => {
					if (e.type === 'activation_start' && e.agent === 'runner') resolve(e.activation);
				});
			});
			await visit.send({
				text: 'Run the shell command `pwd`, then run the shell command `uname -s`.',
			});
			const activation = await within(started, 60_000, 'the activation starting');
			await untilQuiet(session);

			const steps = await traceOf(runtime, name, activation);
			const approvals = stepsOfType(steps, 'approval');
			// One approval step for each request the application answered.
			expect(approvals).toHaveLength(asked.length);
			const allowed = approvals.filter((a) => a.decision === 'allow');
			const denied = approvals.filter((a) => a.decision === 'deny');
			expect(allowed.length).toBeGreaterThanOrEqual(1);
			expect(denied.length).toBeGreaterThanOrEqual(1);
			expect(approvals.every((a) => a.name === 'Bash')).toBe(true);
			const results = stepsOfType(steps, 'tool_result');
			const resultOf = (call: string) => results.find((r) => r.call === call);
			for (const a of allowed) expect(resultOf(a.call)?.error).toBeUndefined();
			for (const a of denied) expect(resultOf(a.call)?.error).toBeDefined();
			expect(events.filter((e) => e.type === 'error')).toEqual([]);
		} finally {
			await session.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
