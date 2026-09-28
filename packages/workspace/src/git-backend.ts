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

/**
 * A name of one commit: a branch, a tag, or a commit hash of 7 to 64
 * lowercase hex digits. A short hash must name one commit alone.
 */
export type GitRevision =
	{ readonly branch: string } | { readonly tag: string } | { readonly commit: string };

/** How a commit changed one path against its first parent. */
export type GitChange = 'added' | 'modified' | 'deleted';

/** One commit, as a backend reads it. */
export interface GitCommit {
	/** The full hash. */
	readonly hash: string;
	/** The whole message, subject and body. */
	readonly message: string;
	/** The author, and the author date as an ISO timestamp. */
	readonly author: { readonly name: string; readonly email: string; readonly date: string };
	/** The full hash of each parent, in order. A root commit has none. */
	readonly parents: readonly string[];
	/**
	 * Each path the commit changed against its first parent, or against an
	 * empty tree for a root commit, in path order. A rename is a deletion and
	 * an addition.
	 */
	readonly changes: readonly { readonly path: string; readonly change: GitChange }[];
}

/** One agent's environment over the git backend. */
export interface GitEnv extends ResourceEnv {
	/** The repositories, in ID order. `namespace` limits the list to one namespace. */
	list(namespace?: string, signal?: AbortSignal): Promise<readonly GitRepository[]>;
	/** One repository, or `undefined` when it does not exist. */
	get(id: GitRepositoryId, signal?: AbortSignal): Promise<GitRepository | undefined>;
	/**
	 * The full hash of the commit that `at` names in the repository `id`, or
	 * `undefined` when the repository, the branch, the tag, or the commit
	 * does not exist. A tag gives the commit it points at. Call
	 * `revisionOf(at)` for the revision to read: it refuses a name that git
	 * would read as an expression.
	 */
	resolve(id: GitRepositoryId, at: GitRevision, signal?: AbortSignal): Promise<string | undefined>;
	/**
	 * The commit with the full hash `hash` in the repository `id`, or
	 * `undefined` when the repository or the commit does not exist. Call
	 * `assertCommitHash(hash)` first: it refuses anything but a full hash.
	 */
	show(id: GitRepositoryId, hash: string, signal?: AbortSignal): Promise<GitCommit | undefined>;
	/** Fork `source` to `<agent>/<name>`. Resolves when a clone of the fork succeeds. */
	fork(source: GitRepositoryId, name: string, signal?: AbortSignal): Promise<GitForkOutcome>;
}

/** The git backend of a workspace. */
export interface GitBackend extends ResourceBackend<GitEnv> {
	readonly access: GitAccess;
	/** The server this backend names in the guidance, with no credential. */
	readonly server: string;
}
