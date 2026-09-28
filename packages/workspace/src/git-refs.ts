/**
 * The commit ref of a host: the commit that a branch, a tag, or a hash names
 * in a repository, read on the git owner, as the kernel's commit URI.
 *
 * An agent writes a commit ref itself. A host that wants to know that a
 * commit exists on the server builds the ref here, or compares a cited ref
 * with the one this gives. `readCommitOf` reads the commit a ref names, so a
 * host shows it to a person.
 */

import { commitUri, parseCommitUri, REF_LIMITS } from '@ambionframework/ambion';
import type { GitCommit, GitEnv, GitRevision } from './git-backend.ts';
import { revisionOf } from './git-names.ts';
import type { WorkspaceAgent, WorkspaceResource } from './resource.ts';

/** How a refusal names `at`: `branch 'main'`, `tag 'v1'`, or `commit abc1234`. */
function named(at: GitRevision): string {
	if ('branch' in at) return `branch '${at.branch}'`;
	return 'tag' in at ? `tag '${at.tag}'` : `commit ${at.commit}`;
}

/**
 * The ref of the commit that `at` names in `repository`, as `agent` reads it
 * on the git owner. Throws for a name that git would misread, for a
 * repository or a name that does not exist, and for a ref longer than a
 * message carries.
 */
export async function commitRefOf(
	git: WorkspaceResource<GitEnv>['use'],
	workspace: string,
	agent: WorkspaceAgent,
	request: { readonly repository: string; readonly at: GitRevision },
	signal?: AbortSignal,
): Promise<string> {
	const { repository, at } = request;
	revisionOf(at);
	const commit = await git(agent, (env) => env.resolve(repository, at, signal), signal);
	if (commit === undefined) throw new Error(`${repository} has no ${named(at)}.`);
	const via = 'branch' in at ? { branch: at.branch } : 'tag' in at ? { tag: at.tag } : undefined;
	const ref = commitUri(workspace, repository, commit, via);
	if (ref.length > REF_LIMITS.length)
		throw new Error(
			`The ref of ${repository} ${named(at)} has ${ref.length} characters, and a ref has at most ${REF_LIMITS.length}.`,
		);
	return ref;
}

/**
 * The commit that the commit ref `ref` names, as `agent` reads it on the git
 * owner. Throws for a ref that is not a commit ref of `workspace`, and for a
 * commit that the server does not hold.
 */
export async function readCommitOf(
	git: WorkspaceResource<GitEnv>['use'],
	workspace: string,
	agent: WorkspaceAgent,
	ref: string,
	signal?: AbortSignal,
): Promise<GitCommit> {
	const named = parseCommitUri(ref);
	if (named === undefined) throw new Error(`${ref} is not a commit ref.`);
	if (named.workspace !== workspace)
		throw new Error(`${ref} names the workspace '${named.workspace}', not '${workspace}'.`);
	const commit = await git(
		agent,
		(env) => env.show(named.repository, named.commit, signal),
		signal,
	);
	if (commit === undefined) throw new Error(`${named.repository} holds no commit ${named.commit}.`);
	return commit;
}
