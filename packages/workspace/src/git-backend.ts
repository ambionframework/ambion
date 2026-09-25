/**
 * The git backend: the repositories of one workspace, beside the bash
 * backend.
 *
 * Every workspace has a bash backend. A git backend is optional. When a
 * workspace has one, the `repos` and `fork` tools run on it, under an owner
 * of its own, and the bash backend receives `GitAccess` when it connects,
 * so the `git` of each agent reaches the backend's repositories. A bash
 * backend lists the transports it carries in `gitTransports`, and
 * `openWorkspace` refuses a pair whose transport the bash backend does not
 * carry.
 *
 * A repository ID is `templates/<name>` or `<agent>/<name>`. Only its
 * registration changes a template. Only the owner of a repository holds a
 * write credential for it, and every other agent holds a read credential.
 * A credential grants one scope on one repository, and it expires. The
 * package of each git backend defines its credentials.
 *
 * This module holds types only, so the root entry loads no git library.
 * `docs/git.md` states the contract.
 */

import type { ResourceBackend, ResourceEnv } from './resource.ts';

/** A repository ID: `templates/<name>` or `<agent>/<name>`. */
export type GitRepositoryId = string;

/** One repository, as the backend reports it. */
export interface GitRepository {
	readonly id: GitRepositoryId;
	/** The URL a git client clones and pushes. Opaque to the agent. */
	readonly url: string;
	/** The repository this one was forked from. */
	readonly source?: GitRepositoryId;
	/** What the repository holds. The host sets it when it registers a template. */
	readonly description?: string;
	/** The branch that a clone checks out. */
	readonly defaultBranch: string;
	/** Each branch and the full hash of the commit it names. */
	readonly branches: Readonly<Record<string, string>>;
}

/**
 * What a bash backend needs to reach the git backend as one agent. The core
 * knows the transport by its name alone. The package of each git backend
 * extends this type with the wire shape of its transport, and the bash
 * backend that carries the transport reads it.
 */
export interface GitAccess {
	/** The name of the transport, such as `in-process` or `ssh`. */
	readonly transport: string;
}

/** What a fork gives: the new repository, or the reason the backend refused it. */
export type GitForkOutcome =
	| { readonly ok: true; readonly repository: GitRepository }
	| { readonly ok: false; readonly reason: 'no_source'; readonly source: GitRepositoryId }
	| { readonly ok: false; readonly reason: 'name_taken'; readonly repository: GitRepository }
	| { readonly ok: false; readonly reason: 'refused'; readonly message: string };

/** One agent's environment over the git backend. */
export interface GitEnv extends ResourceEnv {
	/** The repositories, in ID order. `namespace` limits the list to one namespace. */
	list(namespace?: string, signal?: AbortSignal): Promise<readonly GitRepository[]>;
	/** One repository, or `undefined` when it does not exist. */
	get(id: GitRepositoryId, signal?: AbortSignal): Promise<GitRepository | undefined>;
	/** Fork `source` to `<agent>/<name>`. Resolves when a clone of the fork succeeds. */
	fork(source: GitRepositoryId, name: string, signal?: AbortSignal): Promise<GitForkOutcome>;
}

/** The git backend of a workspace. */
export interface GitBackend extends ResourceBackend<GitEnv> {
	readonly access: GitAccess;
	/** The server this backend names in the guidance, with no credential. */
	readonly server: string;
}
