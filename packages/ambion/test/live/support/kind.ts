/**
 * The executor kind of a live run and the executors it builds. The restart child
 * imports this file, so it names no test runner.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { claude, claudeExecution } from '../../../../claude/src/index.ts';
import { seatHome } from '../../../../codex/src/home.ts';
import { type CodexOptions, codex, codexExecution } from '../../../../codex/src/index.ts';
import { fileCredentials, type PiOptions, pi, piExecution } from '../../../../pi/src/index.ts';

/** The executor kinds a live seat can run on. */
export type LiveKind = 'pi' | 'claude' | 'codex';

/** The executor kind of a value: `pi`, `claude` or `codex`. Absent means `pi`. */
export function liveKindOf(value: string | undefined): LiveKind {
	if (value === undefined || value === '') return 'pi';
	if (value === 'pi' || value === 'claude' || value === 'codex') return value;
	throw new Error(`AMBION_EXECUTOR is '${value}'. Use 'pi', 'claude' or 'codex'.`);
}

export const LIVE_KIND: LiveKind = liveKindOf(process.env.AMBION_EXECUTOR);

/** The model of every Codex seat. `AMBION_MODEL` names a Pi or Claude model. */
export const CODEX_MODEL = 'gpt-5.6-luna';

/** The model every live seat runs on. The example reads the same variable. */
export const MODEL =
	LIVE_KIND === 'codex' ? CODEX_MODEL : (process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5');

/** Codex reports tokens and no cost. A case that reads the cost skips under it. */
export const REPORTS_COST = LIVE_KIND !== 'codex';

/**
 * The model id of a Claude seat: `MODEL` without its provider prefix. The
 * Claude executor runs Anthropic models only.
 */
function claudeModel(model: string): string {
	const slash = model.indexOf('/');
	if (slash === -1) return model;
	if (model.slice(0, slash) !== 'anthropic') {
		throw new Error(
			`The Claude executor runs Anthropic models. '${model}' names another provider.`,
		);
	}
	return model.slice(slash + 1);
}

/**
 * The key's variable. Pi derives it from the provider, the way
 * `registryStream` does. The Claude executor reads `ANTHROPIC_API_KEY`, and
 * the Codex executor reads `CODEX_API_KEY`.
 */
export const KEY_VAR =
	LIVE_KIND === 'claude'
		? 'ANTHROPIC_API_KEY'
		: LIVE_KIND === 'codex'
			? 'CODEX_API_KEY'
			: `${MODEL.slice(0, MODEL.indexOf('/')).toUpperCase().replace(/-/g, '_')}_API_KEY`;

/** The subscription sign-ins of a Pi seat: one JSON file keyed by provider id. */
export const PI_CREDENTIALS = join(homedir(), '.ambion', 'pi', 'credentials.json');

/** Whether the Pi credential file holds a sign-in for the provider of `MODEL`. */
function piSignedIn(): boolean {
	if (!existsSync(PI_CREDENTIALS)) return false;
	try {
		const stored = JSON.parse(readFileSync(PI_CREDENTIALS, 'utf8')) as Record<string, unknown>;
		return MODEL.slice(0, MODEL.indexOf('/')) in stored;
	} catch {
		return false;
	}
}

/** Whether the host has a login for the kind: the Codex `auth.json`, or a stored Pi sign-in. */
function hostSignedIn(): boolean {
	if (LIVE_KIND === 'codex') {
		const login = seatHome({}).login;
		return login !== undefined && existsSync(login);
	}
	return LIVE_KIND === 'pi' && piSignedIn();
}

/**
 * How the seats sign in. `key` when the key variable holds a value: the key
 * path wins. `login` when the host has a login for the kind. Absent when it has
 * neither. The host login is read only when no key is set.
 */
export function signInOf(
	key: string | undefined,
	hasLogin: () => boolean,
): 'key' | 'login' | undefined {
	if (key) return 'key';
	return hasLogin() ? 'login' : undefined;
}

export const SIGN_IN = signInOf(process.env[KEY_VAR], hostSignedIn);

/** The reasoning level that `AMBION_THINKING` sets for every executor kind. */
const THINKING = process.env.AMBION_THINKING || undefined;

/** The reasoning level of a live run for a report: the variable, or the default of the kind. */
export const LIVE_THINKING: string =
	THINKING ?? (LIVE_KIND === 'codex' ? 'medium' : LIVE_KIND === 'pi' ? 'off' : 'default');

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/** The Claude effort of the variable. A value that is no effort level gives nothing. */
function claudeEffort(): { effort?: ClaudeEffort } {
	const effort = CLAUDE_EFFORTS.find((level) => level === THINKING);
	return effort === undefined ? {} : { effort };
}

const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The Codex effort of the variable. A value that Codex does not take gives `medium`. */
function codexEffort(): { modelReasoningEffort: CodexOptions['modelReasoningEffort'] } {
	return { modelReasoningEffort: CODEX_EFFORTS.find((level) => level === THINKING) ?? 'medium' };
}

function piThinking(): Pick<PiOptions, 'thinking'> {
	return THINKING === undefined ? {} : { thinking: THINKING as PiOptions['thinking'] };
}

/** The executor of one live seat on the executor kind of the run. */
export function executorFor(options: Omit<PiOptions, 'model'> & { model?: string }) {
	const { model, ...rest } = options;
	if (LIVE_KIND === 'claude') {
		return claude({ model: claudeModel(model ?? MODEL), ...claudeEffort(), ...rest });
	}
	if (LIVE_KIND === 'codex') return codex({ model: CODEX_MODEL, ...codexEffort(), ...rest });
	return pi({ model: model ?? MODEL, ...piThinking(), ...rest });
}

/** The execution services of the executor kind of the run. */
export function executionFor() {
	if (LIVE_KIND === 'claude') return claudeExecution();
	if (LIVE_KIND === 'codex') return codexExecution();
	return SIGN_IN === 'login'
		? piExecution({ credentials: fileCredentials(PI_CREDENTIALS) })
		: piExecution();
}

/**
 * The execution of a case that needs the provider to refuse the key. A stored
 * Pi sign-in wins over the environment key, so under a Pi login the
 * execution reads an empty credential store and the key variable answers.
 */
export function refusingExecutionFor() {
	if (LIVE_KIND !== 'pi' || SIGN_IN !== 'login') return executionFor();
	const empty = join(tmpdir(), `ambion-no-credentials-${process.pid}`, 'credentials.json');
	return piExecution({ credentials: fileCredentials(empty) });
}
