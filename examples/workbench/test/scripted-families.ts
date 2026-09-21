import { byAgent, quiet, type Script, scripted } from '@ambionframework/ambion/testing';
import type { OpenOptions } from '../src/workbench.ts';

/**
 * Scripted executions for the Claude and Codex seats. Each runs a script and
 * needs no key and no network. Without a script, a seat stays quiet.
 */
export function scriptedFamilies(
	script: Script = byAgent({}),
): NonNullable<OpenOptions['executions']> {
	return { claude: scripted(script), codex: scripted(script) };
}

export { quiet };
