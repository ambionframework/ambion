/** The executor kind of each seat, and the credential that kind needs. */
export type ExecutorKind = 'pi' | 'claude' | 'codex';

/** The environment variables a run reads. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The seats that run on an executor kind, the assistant included. */
export const seatKinds: Readonly<Record<string, ExecutorKind>> = {
	assistant: 'pi',
	datasheets: 'pi',
	design: 'claude',
	experiments: 'codex',
	scout: 'pi',
	maker: 'pi',
};

/** The model of the Pi seats. `AMBION_MODEL` overrides it. */
export const piModel = (env: Environment = process.env): string =>
	env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';

/** The model of the Claude seat, as the Claude Agent SDK names it. */
export const CLAUDE_MODEL = 'claude-sonnet-5';

/** The model of the Codex seat. */
export const CODEX_MODEL = 'gpt-5.6-luna';

/** The environment variable that holds the key of an executor kind. */
export function keyVariable(kind: ExecutorKind, env: Environment = process.env): string {
	if (kind === 'claude') return 'ANTHROPIC_API_KEY';
	if (kind === 'codex') return 'CODEX_API_KEY';
	const model = piModel(env);
	const provider = model.slice(0, Math.max(model.indexOf('/'), 0));
	return `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/** True when the environment holds the key of an executor kind. */
export const hasKey = (kind: ExecutorKind, env: Environment = process.env): boolean =>
	Boolean(env[keyVariable(kind, env)]);

/** The seats whose executor kind has no key, each with the variable it needs. */
export function unavailableSeats(
	env: Environment = process.env,
): { seat: string; kind: ExecutorKind; variable: string }[] {
	return Object.entries(seatKinds)
		.filter(([, kind]) => !hasKey(kind, env))
		.map(([seat, kind]) => ({ seat, kind, variable: keyVariable(kind, env) }));
}

/** One line per seat that cannot run. An empty list means every seat can run. */
export const describeUnavailable = (env: Environment = process.env): string[] =>
	unavailableSeats(env).map(
		({ seat, kind, variable }) =>
			`Seat '${seat}' cannot run: ${variable} is not set, and the ${kind} executor needs it.`,
	);
