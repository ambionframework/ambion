/**
 * The real `codex` binary on a scripted model. `codexOn` writes a Codex
 * home that routes the model provider to a scripted Responses endpoint,
 * and builds the execution that runs the binary with a minimal environment.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Execution } from '@ambionframework/ambion';
import { codexExecution } from '../src/index.ts';
import {
	type OnRequest,
	type Reply,
	type ScriptedResponses,
	scriptedResponses,
} from './responses.ts';

/** The variable that Codex requires for the provider. Its value is a dummy. */
export const DUMMY_KEY_VAR = 'AMBION_SCRIPTED_KEY';

/** The model of every seat on the scripted endpoint. The catalog of the binary lists it. */
export const MODEL = 'gpt-5.6-luna';

/** The bundled binary of this platform, or nothing when the platform package is missing. */
function bundledBinary(): string | undefined {
	try {
		const sdk = createRequire(import.meta.resolve('@openai/codex-sdk'));
		const codex = createRequire(sdk.resolve('@openai/codex/package.json'));
		const platform = process.platform === 'android' ? 'linux' : process.platform;
		const root = join(
			dirname(codex.resolve(`@openai/codex-${platform}-${process.arch}/package.json`)),
			'vendor',
		);
		const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
		return readdirSync(root)
			.flatMap((target) => [join(root, target, 'bin', name), join(root, target, 'codex', name)])
			.find((path) => existsSync(path));
	} catch {
		return undefined;
	}
}

/** Whether this platform has a bundled binary. A suite of the binary skips when it has none. */
export const hasBinary = bundledBinary() !== undefined;

/** The config of a Codex home that sends every model request to `url`. */
export function homeConfig(url: string): string {
	return [
		'model_provider = "scripted"',
		'check_for_update_on_startup = false',
		'',
		'[model_providers.scripted]',
		'name = "scripted"',
		`base_url = "${url}"`,
		'wire_api = "responses"',
		`env_key = "${DUMMY_KEY_VAR}"`,
		'',
	].join('\n');
}

/** A real binary on a script: the execution to give a room, the endpoint, and the cleanup. */
export interface CodexOnScript {
	readonly execution: Execution;
	readonly responses: ScriptedResponses;
	/** The Codex home of the run. */
	readonly home: string;
	close(): Promise<void>;
}

/**
 * Run the real binary against the script. The environment holds `PATH`, a
 * home in a temporary directory, and the dummy key. It holds nothing of the
 * host, so no real sign-in or key reaches the binary.
 */
export async function codexOn(
	script: readonly Reply[],
	onRequest?: OnRequest,
): Promise<CodexOnScript> {
	const responses = await scriptedResponses(script, onRequest);
	const dir = mkdtempSync(join(tmpdir(), 'ambion-codex-binary-'));
	writeFileSync(join(dir, 'config.toml'), homeConfig(responses.url));
	const env = {
		PATH: process.env.PATH,
		HOME: dir,
		CODEX_HOME: dir,
		[DUMMY_KEY_VAR]: 'dummy-key-for-the-scripted-endpoint',
	};
	return {
		execution: codexExecution({ env }),
		responses,
		home: dir,
		close: async () => {
			await responses.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
