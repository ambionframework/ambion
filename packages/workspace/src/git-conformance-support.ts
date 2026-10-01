/**
 * What the git conformance cases share: the agents and the helpers that run
 * the git resource and the bash resource as one agent.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { runScript } from './execution-env.ts';
import type { GitEnv } from './git-backend.ts';
import type { WorkspaceAgent } from './resource.ts';
import type { Workspace } from './workspace.ts';

export const ctx = BACKGROUND_CONTEXT;

export const ANALYST: WorkspaceAgent = { name: 'analyst' };
export const REVIEWER: WorkspaceAgent = { name: 'reviewer' };

/** Run `operation` on the git resource as `agent`. */
export function git<T>(
	workspace: Workspace,
	agent: WorkspaceAgent,
	operation: (env: GitEnv) => Promise<T>,
): Promise<T> {
	const resource = workspace.git;
	if (resource === undefined) throw new Error('The workspace has no git resource.');
	return resource.use(agent, operation);
}

/**
 * Run one shell command as `agent`, and give its exit status and its output.
 * The author variables let a real `git` commit. The just-bash `git` locks
 * the author to the agent, and ignores them.
 */
export async function sh(
	workspace: Workspace,
	agent: WorkspaceAgent,
	command: string,
): Promise<{ code: number; output: string }> {
	const ran = await workspace.use(agent, (env) =>
		runScript(
			env,
			command,
			{
				timeout: 120,
				env: authorOf(agent),
				capture: { limits: { maxBytes: 100_000, maxLines: 1000 } },
			},
			ctx,
		),
	);
	if (!ran.ok) throw ran.error;
	return { code: ran.value.exitCode, output: ran.value.output };
}

/** The author and committer variables of `agent`. */
function authorOf(agent: WorkspaceAgent): Record<string, string> {
	const email = `${agent.name}@ambion.invalid`;
	return {
		GIT_AUTHOR_NAME: agent.name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: agent.name,
		GIT_COMMITTER_EMAIL: email,
	};
}

/** Fork `source` to `<agent>/<name>`, and give the fork's clone URL. */
export async function forkAs(
	workspace: Workspace,
	agent: WorkspaceAgent,
	source: string,
	name: string,
): Promise<string> {
	const outcome = await git(workspace, agent, (env) => env.fork(source, name));
	if (!outcome.ok)
		throw new Error(`the fork of ${source} to ${name} was refused: ${outcome.reason}`);
	return outcome.repository.url;
}
