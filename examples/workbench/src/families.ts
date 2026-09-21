/** The executor family of each seat, and the credential that family needs. */
export type Family = 'pi' | 'claude' | 'codex';

/** The environment variables a run reads. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The seats that run on a family. The assistant keeps the default executor, which is Pi. */
export const seatFamilies: Readonly<Record<string, Family>> = {
	assistant: 'pi',
	datasheets: 'pi',
	design: 'claude',
	experiments: 'codex',
};

/** The model of the Pi seats. `AMBION_MODEL` overrides it. */
export const piModel = (env: Environment = process.env): string =>
	env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';

/** The model of the Claude seat, as the Claude Agent SDK names it. */
export const CLAUDE_MODEL = 'claude-sonnet-5';

/** The model of the Codex seat. */
export const CODEX_MODEL = 'gpt-5.6-luna';

/** The environment variable that holds the key of a family. */
export function keyVariable(family: Family, env: Environment = process.env): string {
	if (family === 'claude') return 'ANTHROPIC_API_KEY';
	if (family === 'codex') return 'CODEX_API_KEY';
	const model = piModel(env);
	const provider = model.slice(0, Math.max(model.indexOf('/'), 0));
	return `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/** True when the environment holds the key of a family. */
export const hasKey = (family: Family, env: Environment = process.env): boolean =>
	Boolean(env[keyVariable(family, env)]);

/** The seats whose family has no key, each with the variable it needs. */
export function unavailableSeats(
	env: Environment = process.env,
): { seat: string; family: Family; variable: string }[] {
	return Object.entries(seatFamilies)
		.filter(([, family]) => !hasKey(family, env))
		.map(([seat, family]) => ({ seat, family, variable: keyVariable(family, env) }));
}

/** One line per seat that cannot run. An empty list means every seat can run. */
export const describeUnavailable = (env: Environment = process.env): string[] =>
	unavailableSeats(env).map(
		({ seat, family, variable }) =>
			`Seat '${seat}' cannot run: ${variable} is not set, and the ${family} family needs it.`,
	);
