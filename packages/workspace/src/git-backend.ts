/**
 * The git backend: the repositories of one workspace, beside the bash
 * backend.
 *
 * Every workspace has a bash backend. A git backend is optional. The bash
 * backend takes the git backend as an option of its own package. It reads
 * the access of that git backend. The `git` of each agent then reaches the
 * repositories. A type of the package checks the pair: a git backend of
 * another package is a compile error. When the bash backend has a git
 * backend in `git`, the `repos`, `clone` and `fork` tools use it under an
 * resource of its own. `clone` looks up its source there, then checks it
 * out on the bash resource.
 *
 * A repository ID is `templates/<name>`, `shared/<name>`, or
 * `<agent>/<name>`. Only registration changes a template. Shared
 * repositories are writable by every agent. Only the owner of a fork holds
 * a write credential for it, and every other agent holds a read credential.
 * A credential grants one scope on one repository, and it expires. The
 * package of each git backend defines its credentials.
 *
 * This module holds types only, so the root entry loads no git library.
 * `docs/git.md` states the contract.
 */

import type { ResourceBackend, ResourceEnv } from './resource.ts';

/** A repository ID: `templates/<name>`, `shared/<name>`, or `<agent>/<name>`. */
export type GitRepositoryId = string;

/** One repository, as the backend reports it. */
export interface GitRepository {
	readonly id: GitRepositoryId;
	/** The URL a git client clones and pushes. Opaque to the agent. */
	readonly url: string;
	/** The repository this one was forked from. */
	readonly source?: GitRepositoryId;
	/** What the repository holds. The host sets it when it registers a template or shared repository. */
	readonly description?: string;
	/** The branch that a clone checks out. */
	readonly defaultBranch: string;
	/** Each branch and the full hash of the commit it names. */
	readonly branches: Readonly<Record<string, string>>;
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

/**
 * The git backend of a workspace. The package of each git backend adds an
 * `access` to its own type, and the bash backend of that package reads it.
 */
export interface GitBackend extends ResourceBackend<GitEnv> {
	/** The label that the guidance uses for the server of this backend, with no credential. */
	readonly label: string;
}
