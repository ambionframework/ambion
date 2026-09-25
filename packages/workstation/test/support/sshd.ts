/**
 * The setup of the integration tier: the file that `test/sshd/setup.sh`
 * writes, the options of a backend over it, and the helpers that run one
 * command as one account.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceEnv } from '@ambionframework/workspace';
import { BACKGROUND_CONTEXT, type ShellOutputUpdate } from '@earendil-works/pi-agent-core';
import type { WorkstationOptions, workstationBackend } from '../../src/index.ts';

/** The file that `setup.sh` writes. Without it, every test of the tier skips. */
export const configPath = process.env.AMBION_WORKSTATION_SSHD;

export interface SetupFile {
	readonly host: string;
	readonly port: number;
	readonly hostKey: string;
	/** An address of the server other than the loopback address. */
	readonly external: string;
	/** The folder of the private key of each account, by the account's name. */
	readonly keys: string;
	readonly layout: WorkstationOptions['layout'];
}

export async function readSetup(): Promise<SetupFile> {
	return JSON.parse(await readFile(configPath ?? '', 'utf8')) as SetupFile;
}

/** The private key of the account `name`. */
export function keyOf(setup: SetupFile, name: string): Promise<string> {
	return readFile(join(setup.keys, name), 'utf8');
}

/** The options of a `workstationBackend` with one account for each agent. */
export async function options(): Promise<WorkstationOptions> {
	const setup = await readSetup();
	return {
		host: setup.host,
		port: setup.port,
		hostKey: setup.hostKey,
		layout: setup.layout,
		credentialFor: async (agent) => ({
			username: agent.name,
			privateKey: await keyOf(setup, agent.name),
		}),
	};
}

export type Backend = ReturnType<typeof workstationBackend>;

/** Run `body` over an env of `agent`, and clean the env up after. */
export async function withEnv<T>(
	backend: Backend,
	agent: string,
	body: (env: WorkspaceEnv) => Promise<T>,
): Promise<T> {
	const env = await backend.connect({ name: agent });
	try {
		return await body(env);
	} finally {
		await env.cleanup();
	}
}

/** Remove everything in the agent's home but `.ssh`, so each case starts clean. */
export const WIPE = 'find ~ -mindepth 1 -maxdepth 1 ! -name .ssh -exec rm -rf -- {} +';

/** What one command gave: its exit status, and its stdout and stderr together. */
export interface Ran {
	readonly code: number;
	readonly output: string;
}

/** Run `command` over `env`, and give its exit status and its output. */
export async function run(env: WorkspaceEnv, command: string): Promise<Ran> {
	let output = '';
	const onUpdate = (update: ShellOutputUpdate): void => {
		if (update.kind === 'replace') output = update.output.text;
	};
	const ran = await env.exec(
		command,
		{ timeout: 120, capture: { limits: { maxBytes: 100_000, maxLines: 1000 } }, onUpdate },
		BACKGROUND_CONTEXT,
	);
	if (!ran.ok) throw ran.error;
	return { code: ran.value.exitCode, output };
}
