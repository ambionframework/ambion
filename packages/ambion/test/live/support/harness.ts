/**
 * The harness of a live run and the executors it builds. The restart child
 * imports this file, so it names no test runner.
 */
import { claude, claudeExecution } from '../../../../claude/src/index.ts';
import { codex, codexExecution } from '../../../../codex/src/index.ts';
import { type PiOptions, pi, piExecution } from '../../../../pi/src/index.ts';

/** The harnesses a live seat can run on. */
export type Harness = 'pi' | 'claude' | 'codex';

/** The harness of a value: `pi`, `claude` or `codex`. Absent means `pi`. */
export function harnessOf(value: string | undefined): Harness {
	if (value === undefined || value === '') return 'pi';
	if (value === 'pi' || value === 'claude' || value === 'codex') return value;
	throw new Error(`AMBION_HARNESS is '${value}'. Use 'pi', 'claude' or 'codex'.`);
}

export const HARNESS: Harness = harnessOf(process.env.AMBION_HARNESS);

/** The model of every Codex seat. `AMBION_MODEL` names a Pi or Claude model. */
export const CODEX_MODEL = 'gpt-5.6-luna';

/** The model every live seat runs on. The example reads the same variable. */
export const MODEL =
	HARNESS === 'codex' ? CODEX_MODEL : (process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5');

/** Codex reports tokens and no cost. A case that reads the cost skips under it. */
export const REPORTS_COST = HARNESS !== 'codex';

/**
 * The model id of a Claude seat: `MODEL` without its provider prefix. The
 * Claude harness runs Anthropic models only.
 */
function claudeModel(model: string): string {
	const slash = model.indexOf('/');
	if (slash === -1) return model;
	if (model.slice(0, slash) !== 'anthropic') {
		throw new Error(`The Claude harness runs Anthropic models. '${model}' names another provider.`);
	}
	return model.slice(slash + 1);
}

/**
 * The key's variable. Pi derives it from the provider, the way
 * `registryStream` does. The Claude harness reads `ANTHROPIC_API_KEY`, and
 * the Codex harness reads `CODEX_API_KEY`.
 */
export const KEY_VAR =
	HARNESS === 'claude'
		? 'ANTHROPIC_API_KEY'
		: HARNESS === 'codex'
			? 'CODEX_API_KEY'
			: `${MODEL.slice(0, MODEL.indexOf('/')).toUpperCase().replace(/-/g, '_')}_API_KEY`;

/** The executor of one live seat on the harness of the run. */
export function executorFor(options: Omit<PiOptions, 'model'> & { model?: string }) {
	const { model, ...rest } = options;
	if (HARNESS === 'claude') return claude({ model: claudeModel(model ?? MODEL), ...rest });
	if (HARNESS === 'codex') {
		return codex({
			model: CODEX_MODEL,
			modelReasoningEffort: 'medium',
			nativeTools: 'none',
			...rest,
		});
	}
	return pi({ model: model ?? MODEL, ...rest });
}

/** The execution services of the harness of the run. */
export function executionFor() {
	if (HARNESS === 'claude') return claudeExecution();
	if (HARNESS === 'codex') return codexExecution();
	return piExecution();
}
