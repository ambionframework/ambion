import { expect, it } from 'vitest';
import {
	assistantEvalProfiles,
	expectedSamplesForProfile,
	profileFromEnvironment,
	sampleCountForProfile,
} from './support/evals/profile.ts';

it('keeps the fixed assistant profile budgets', () => {
	expect(assistantEvalProfiles).toEqual({ development: 5, baseline: 15, acceptance: 25 });
	for (const [profile, count] of Object.entries(assistantEvalProfiles))
		expect(expectedSamplesForProfile(profile as keyof typeof assistantEvalProfiles)).toBe(count);
});

it('uses fixed first-attempt counts for each simulation', () => {
	expect(sampleCountForProfile('development')).toBe(1);
	expect(sampleCountForProfile('baseline')).toBe(3);
	expect(sampleCountForProfile('acceptance')).toBe(5);
});

it('defaults absent profiles and rejects misspelled profiles', () => {
	expect(profileFromEnvironment(undefined)).toBe('development');
	expect(() => profileFromEnvironment('unknown')).toThrow('Unknown assistant eval profile');
	expect(profileFromEnvironment('baseline')).toBe('baseline');
});
