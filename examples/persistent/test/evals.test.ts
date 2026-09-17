import { regradeEvals, runEvals } from '@ambionframework/evals';
import { expect, it } from 'vitest';
import { type RelayObservation, relayEval } from './support/evals.ts';

it('preserves an original Relay failure when retained HTTP evidence is regraded', async () => {
	const trace: RelayObservation[] = [
		{ path: '/rooms/triage/messages', method: 'GET', request: null, status: 200, response: [] },
	];
	const failed = relayEval('triage', trace, ['Writer never contributed.']);
	const original = await runEvals([
		{ ...failed, checks: failed.checks.filter((check) => check.id === 'original-assertions') },
	]);
	expect(original.passed).toBe(false);
	const reconstructed = relayEval('triage', trace, []);
	const regraded = await regradeEvals(original, [
		{
			...reconstructed,
			checks: reconstructed.checks.filter((check) => check.id === 'original-assertions'),
		},
	]);
	expect(regraded.passed).toBe(false);
	expect(regraded.samples[0]?.checks[0]?.error?.message).toContain('Writer never contributed');
});
