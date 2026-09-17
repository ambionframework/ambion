export type AssistantEvalProfile = 'development' | 'baseline' | 'acceptance';

/** Five room simulations: one, three, or five first attempts per scenario. */
export const assistantEvalProfiles: Readonly<Record<AssistantEvalProfile, number>> = {
	development: 5,
	baseline: 15,
	acceptance: 25,
};

export function profileFromEnvironment(value: string | undefined): AssistantEvalProfile {
	if (value === undefined || value === 'development') return 'development';
	if (value === 'baseline' || value === 'acceptance') return value;
	throw new Error(`Unknown assistant eval profile: ${value}`);
}

export function sampleCountForProfile(profile: AssistantEvalProfile): number {
	if (profile === 'acceptance') return 5;
	return profile === 'baseline' ? 3 : 1;
}

export function expectedSamplesForProfile(profile: AssistantEvalProfile): number {
	return assistantEvalProfiles[profile];
}

export function providerCredential(model: string): string | undefined {
	const [provider, ...name] = model.split('/');
	if (!provider || name.join('/').length === 0) throw new Error('Expected provider/model-id.');
	return `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}
