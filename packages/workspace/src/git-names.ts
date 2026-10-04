/**
 * Repository IDs and the reserved namespace.
 *
 * An ID is `<namespace>/<name>`. `templates` holds the read-only templates,
 * `shared` holds writable repositories common to the workspace, and every
 * other namespace is the name of an agent. No agent takes a reserved name.
 * The file also holds the default branch and the author of the commits that
 * a backend writes itself.
 */

import { isName } from '@ambionframework/ambion/names';
import type { GitCommit, GitRevision } from './git-backend.ts';
import type { WorkspaceAgent } from './resource.ts';

/** The namespace of the read-only templates. */
export const TEMPLATES = 'templates';

/** The namespace of the repositories shared by every agent. */
export const SHARED = 'shared';

/** The default branch of a repository whose `HEAD` names none, and of every repository that a backend creates. */
export const DEFAULT_BRANCH = 'main';

/** The author of every commit that a backend writes. */
export const BACKEND_AUTHOR = Object.freeze({ name: 'ambion', email: 'ambion@ambion.invalid' });

/** The rule for the name of a repository, 1 to 64 characters, as the source of a pattern. */
export const NAME_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$';

const NAME = new RegExp(NAME_PATTERN);

/** Whether `name` is a valid repository name. */
export function validName(name: string): boolean {
	return NAME.test(name);
}

/** The namespace of an ID, or `undefined` for an ID that is not `<namespace>/<name>`. */
export function namespaceOf(id: string): string | undefined {
	const slash = id.indexOf('/');
	if (slash <= 0 || slash !== id.lastIndexOf('/')) return undefined;
	const namespace = id.slice(0, slash);
	return isName(namespace) && validName(id.slice(slash + 1)) ? namespace : undefined;
}

/** Refuse an agent that takes the reserved name, or a name that no namespace takes. */
export function assertAgent(agent: WorkspaceAgent): void {
	if (agent.name === TEMPLATES || agent.name === SHARED) {
		throw new Error(`The name '${agent.name}' is reserved by the git backend.`);
	}
	if (!isName(agent.name)) {
		throw new Error(`The name '${agent.name}' is not a namespace of the git backend.`);
	}
}

/** Whether no agent can push to the repository `id`: a template. */
export function readOnly(id: string): boolean {
	return namespaceOf(id) === TEMPLATES;
}

/** Whether `agent` may push to the repository `id`. */
export function writableBy(id: string, agent: WorkspaceAgent): boolean {
	const namespace = namespaceOf(id);
	return namespace === SHARED || namespace === agent.name;
}

/** A commit hash, full or short. */
const HASH = /^[0-9a-f]{7,64}$/;

/**
 * A full commit hash: 40 hex digits, or 64 in a SHA-256 repository. The
 * kernel's commit URI holds the same hash. A backend checks its own input,
 * since host code can call `show` without a ref.
 */
const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Throw a `RangeError` when `hash` is not a full commit hash. */
export function assertCommitHash(hash: string): void {
	if (!FULL_HASH.test(hash))
		throw new RangeError(`'${hash}' is not a full commit hash of 40 or 64 lowercase hex digits.`);
}

/** The changes of a commit in the order `show` gives them: by path, as code units compare. */
export function byPath(changes: GitCommit['changes']): GitCommit['changes'] {
	return [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The characters a git ref name never holds beside a control or a space: `~^:?*[\`. */
const REF_FORBIDDEN = /[~^:?*[\\]/;

/** Whether `name` holds a control character, a space, or DEL. */
function hasControl(name: string): boolean {
	return [...name].some((char) => {
		const code = char.charCodeAt(0);
		return code <= 0x20 || code === 0x7f;
	});
}

/**
 * Whether `name` is a branch or a tag name that git takes as a name alone,
 * after the rules of `git check-ref-format`. A name with `..`, `@{`, or one
 * of the characters git reads as an expression is refused.
 */
export function validRefName(name: string): boolean {
	if (name === '@' || name.endsWith('.') || REF_FORBIDDEN.test(name) || hasControl(name))
		return false;
	if (name.includes('..') || name.includes('@{')) return false;
	return name
		.split('/')
		.every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * The revision git reads for `at`: `refs/heads/<branch>`, `refs/tags/<tag>`,
 * or the hash. A backend adds `^{commit}`. Throws for a name or a hash that
 * git would read as something else.
 */
export function revisionOf(at: GitRevision): string {
	if ('commit' in at) {
		if (!HASH.test(at.commit))
			throw new Error(`'${at.commit}' is not a commit hash of 7 to 64 lowercase hex digits.`);
		return at.commit;
	}
	const [kind, name] = 'branch' in at ? ['branch', at.branch] : ['tag', at.tag];
	if (!validRefName(name)) throw new Error(`'${name}' is not a valid git ${kind} name.`);
	return `refs/${kind === 'branch' ? 'heads' : 'tags'}/${name}`;
}
