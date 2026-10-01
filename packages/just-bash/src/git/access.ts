/**
 * The access of `justGitBackend`, in the process. The just-bash backends
 * read it from the backend that their `git` option names. Their `git`
 * reaches the prefix alone, passes each request to `fetch`, and asks
 * `credentialFor` for the token of each request.
 *
 * This module holds types only, so the root entry of the package imports
 * it with `import type` and loads no `node:sqlite`.
 */

import type { WorkspaceAgent } from '@ambionframework/workspace/resource';

/** One credential: one scope on one repository, until `expiresAt`. */
export interface GitCredential {
	/** The clone URL of the repository. */
	readonly url: string;
	readonly scope: 'read' | 'write';
	readonly token: string;
	/** Milliseconds since the epoch. */
	readonly expiresAt: number;
}

/** A web-standard fetch, in the shape the `just-git` client calls. */
export type GitFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** What a just-bash backend needs to reach `justGitBackend` as one agent. */
export interface JustGitAccess {
	/** Every clone URL starts with this prefix. The just-bash `git` reaches it alone. */
	readonly prefix: string;
	/** Carries a git request to the server in the same process. */
	readonly fetch: GitFetch;
	/** The credential of `agent` for one clone URL, or `undefined` for a URL that no agent reaches. Rejects for a reserved name. */
	credentialFor(agent: WorkspaceAgent, url: string): Promise<GitCredential | undefined>;
}
