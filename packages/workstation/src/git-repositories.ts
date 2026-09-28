/**
 * The repositories of the git account, as the git contract reports them.
 *
 * Each repository is a bare repository at `<root>/<namespace>/<name>.git`,
 * with its facts in its own files: the source of a fork in
 * `git config ambion.source`, the description in its `description` file,
 * and the default branch in `HEAD`. The backend keeps no registry table.
 *
 * A fork builds in `<root>/.staging` and lands with one rename. The source
 * and the fork have one owner on one filesystem, so the clone hard-links
 * the object files. `rename(2)` refuses a target folder that holds files,
 * so a second fork of one name gets `name_taken`, also when another host
 * process made the first. In one process, a second fork of one target
 * waits for the first.
 */

import type {
	GitChange,
	GitCommit,
	GitEnv,
	GitForkOutcome,
	GitRepository,
	GitRevision,
} from '@ambionframework/workspace';
import {
	assertCommitHash,
	byPath,
	namespaceOf,
	revisionOf,
	SOURCES,
	validName,
} from '@ambionframework/workspace/git';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';
import { type GitAccount, tagged } from './git-account.ts';

/** The branch that a repository names when its `HEAD` names none. */
const DEFAULT_BRANCH = 'main';

/** The text that `git init` writes into `description`. It counts as no description. */
const UNNAMED = "Unnamed repository; edit this file 'description' to name the repository.";

/**
 * Print one record for each repository: its ID, `HEAD`, each branch with
 * its commit, the source, and the description in base64. `AMBION_ID`
 * names one repository, and `AMBION_NAMESPACE` limits the list to one
 * namespace. The glob skips `.staging`, and the script skips
 * `template-sources`.
 */
const LIST_SCRIPT = [
	'set -euo pipefail',
	'root="$HOME/$AMBION_ROOT"',
	'describe() {',
	'  local id="$1" repo="$root/$1.git"',
	'  [ -f "$repo/HEAD" ] || return 0',
	String.raw`  printf 'AMBION_REPO %s\n' "$id"`,
	String.raw`  printf 'AMBION_HEAD %s\n' "$(git --git-dir="$repo" symbolic-ref -q HEAD || true)"`,
	`  git --git-dir="$repo" for-each-ref --format='AMBION_BRANCH %(refname) %(objectname)' refs/heads`,
	String.raw`  printf 'AMBION_SOURCE %s\n' "$(git --git-dir="$repo" config --get ambion.source || true)"`,
	String.raw`  printf 'AMBION_DESCRIPTION %s\n' "$(base64 -w0 <"$repo/description" 2>/dev/null || true)"`,
	'}',
	'if [ -n "$AMBION_ID" ]; then describe "$AMBION_ID"; exit 0; fi',
	'shopt -s nullglob',
	'for dir in "$root"/*/; do',
	'  namespace=$(basename "$dir")',
	'  [ "$namespace" != template-sources ] || continue',
	'  [ -z "$AMBION_NAMESPACE" ] || [ "$namespace" = "$AMBION_NAMESPACE" ] || continue',
	'  for repo in "$dir"*.git; do describe "$namespace/$(basename "$repo" .git)"; done',
	'done',
	'',
].join('\n');

/**
 * Print the full hash of the commit that `AMBION_REV` names in the
 * repository `AMBION_ID`, or an empty value when it names none. The caller
 * builds the revision with `revisionOf`, so git reads a branch or a tag as a
 * name alone. When `AMBION_KIND` is `hash`, the revision is a hash prefix:
 * `--disambiguate` lists the objects it names, and a branch or a tag with
 * the same name plays no part. A prefix of more than one object names none.
 */
const RESOLVE_SCRIPT = [
	'set -euo pipefail',
	'repo="$HOME/$AMBION_ROOT/$AMBION_ID.git"',
	'[ -f "$repo/HEAD" ] || exit 0',
	'rev="$AMBION_REV"',
	'if [ "$AMBION_KIND" = hash ]; then',
	'  found=$(git --git-dir="$repo" rev-parse --disambiguate="$rev" 2>/dev/null || true)',
	'  [ -n "$found" ] && [ "$(wc -l <<<"$found")" -eq 1 ] || exit 0',
	'  rev="$found"',
	'fi',
	String.raw`printf 'AMBION_COMMIT %s\n' "$(git --git-dir="$repo" rev-parse --verify --quiet "$rev^{commit}" || true)"`,
	'',
].join('\n');

/**
 * Print the commit `AMBION_HASH` of the repository `AMBION_ID`: its parents,
 * then its author, its message, and its changes in base64, so no byte of a
 * name, a message, or a path breaks a line. It prints nothing when the
 * repository or the commit does not exist. The changes are `diff-tree -z`
 * against the first parent, or against an empty tree for a root commit.
 */
const SHOW_SCRIPT = [
	'set -euo pipefail',
	'repo="$HOME/$AMBION_ROOT/$AMBION_ID.git"',
	'[ -f "$repo/HEAD" ] || exit 0',
	'[ "$(git --git-dir="$repo" cat-file -t "$AMBION_HASH" 2>/dev/null || true)" = commit ] || exit 0',
	'show() { git --git-dir="$repo" show -s --format="$1" "$AMBION_HASH"; }',
	String.raw`printf 'AMBION_PARENTS %s\n' "$(show '%P')"`,
	String.raw`printf 'AMBION_AUTHOR %s\n' "$(show '%an%x00%ae%x00%aI' | base64 -w0)"`,
	// The stored message: every byte after the blank line that ends the headers.
	String.raw`printf 'AMBION_MESSAGE %s\n' "$(git --git-dir="$repo" cat-file commit "$AMBION_HASH" | sed '1,/^$/d' | base64 -w0)"`,
	String.raw`printf 'AMBION_CHANGES %s\n' "$(git --git-dir="$repo" diff-tree --root --diff-merges=first-parent --no-commit-id --no-renames -r --name-status -z "$AMBION_HASH" | base64 -w0)"`,
	'',
].join('\n');

/**
 * How `diff-tree --name-status` names a change. `T` is a change of type, such
 * as a file that becomes a symbolic link, and the port calls it `modified`.
 */
const CHANGES: Readonly<Record<string, GitChange>> = {
	A: 'added',
	M: 'modified',
	T: 'modified',
	D: 'deleted',
};

/** The changes that `diff-tree -z --name-status` prints: a status, then a path, each ended by NUL. */
function changesOf(encoded: string): GitCommit['changes'] {
	const fields = Buffer.from(encoded, 'base64').toString('utf8').split('\0');
	const changes: { path: string; change: GitChange }[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const change = CHANGES[fields[index] ?? ''];
		const path = fields[index + 1];
		if (change !== undefined && path !== undefined) changes.push({ path, change });
	}
	return byPath(changes);
}

/** `date` as an ISO 8601 time in UTC, or as git gave it when it does not parse. */
function isoOf(date: string): string {
	const at = new Date(date);
	return Number.isNaN(at.getTime()) ? date : at.toISOString();
}

/** The commit that the output of `SHOW_SCRIPT` names, or `undefined` for no output. */
function commitOf(hash: string, output: string): GitCommit | undefined {
	const [parents] = tagged(output, 'AMBION_PARENTS');
	if (parents === undefined) return undefined;
	const text = (tag: string) =>
		Buffer.from(tagged(output, tag)[0] ?? '', 'base64').toString('utf8');
	const [name = '', email = '', date = ''] = text('AMBION_AUTHOR').replace(/\n$/, '').split('\0');
	return {
		hash,
		message: text('AMBION_MESSAGE'),
		author: { name, email, date: isoOf(date) },
		parents: parents.split(' ').filter((parent) => parent !== ''),
		changes: changesOf(tagged(output, 'AMBION_CHANGES')[0] ?? ''),
	};
}

/** Clone the source into `.staging`, set its facts, and rename it to the target. */
const FORK_SCRIPT = [
	'set -euo pipefail',
	'root="$HOME/$AMBION_ROOT"',
	'mkdir -p "$root/.staging"',
	'stage=$(mktemp -d "$root/.staging/fork.XXXXXXXX")',
	'git clone --bare --quiet "$root/$AMBION_SOURCE.git" "$stage"',
	'git --git-dir="$stage" remote remove origin',
	'git --git-dir="$stage" config ambion.source "$AMBION_SOURCE"',
	'git --git-dir="$stage" config core.logAllRefUpdates always',
	'mkdir -p "$root/$(dirname "$AMBION_TARGET")"',
	'if mv -T "$stage" "$root/$AMBION_TARGET.git" 2>/dev/null; then',
	"  echo 'AMBION_FORK landed'",
	'else',
	'  rm -rf -- "$stage"',
	"  echo 'AMBION_FORK taken'",
	'fi',
	'',
].join('\n');

/** One repository while the parser reads its record. */
interface Draft {
	readonly id: string;
	head: string;
	readonly branches: Record<string, string>;
	source: string;
	description: string;
}

/** The branch of a full ref name, such as `main` for `refs/heads/main`. */
function branchOf(ref: string): string {
	return ref.replace(/^refs\/heads\//, '');
}

/** The text of a description in base64, or '' for none. */
function descriptionOf(encoded: string): string {
	const text = Buffer.from(encoded, 'base64').toString('utf8').replace(/\n$/, '');
	return text === UNNAMED ? '' : text;
}

/** Add one tagged line to the record it belongs to. */
function apply(draft: Draft, tag: string, value: string): void {
	switch (tag) {
		case 'AMBION_HEAD':
			draft.head = branchOf(value);
			break;
		case 'AMBION_BRANCH': {
			const [ref, hash] = value.split(' ');
			if (ref !== undefined && hash !== undefined) draft.branches[branchOf(ref)] = hash;
			break;
		}
		case 'AMBION_SOURCE':
			draft.source = value;
			break;
		case 'AMBION_DESCRIPTION':
			draft.description = descriptionOf(value);
			break;
	}
}

function repositoryOf(draft: Draft, alias: string): GitRepository {
	return {
		id: draft.id,
		url: `ssh://${alias}/${draft.id}`,
		...(draft.source === '' ? {} : { source: draft.source }),
		...(draft.description === '' ? {} : { description: draft.description }),
		defaultBranch: draft.head === '' ? DEFAULT_BRANCH : draft.head,
		branches: draft.branches,
	};
}

/** The repositories that the output of `LIST_SCRIPT` names, in ID order. */
function parseRepositories(output: string, alias: string): GitRepository[] {
	const drafts: Draft[] = [];
	for (const line of output.split('\n')) {
		const space = line.indexOf(' ');
		const tag = space < 0 ? line : line.slice(0, space);
		const value = space < 0 ? '' : line.slice(space + 1);
		if (tag === 'AMBION_REPO') {
			drafts.push({ id: value, head: '', branches: {}, source: '', description: '' });
			continue;
		}
		const current = drafts.at(-1);
		if (current !== undefined) apply(current, tag, value);
	}
	return drafts
		.filter((draft) => namespaceOf(draft.id) !== undefined && namespaceOf(draft.id) !== SOURCES)
		.map((draft) => repositoryOf(draft, alias))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The repositories of one git account. */
export class Repositories {
	/** The forks in flight, by target ID. A second fork of one target waits for the first. */
	private readonly forking = new Map<string, Promise<GitForkOutcome>>();

	constructor(
		private readonly account: GitAccount,
		private readonly root: string,
		private readonly alias: string,
	) {}

	private async read(id: string, namespace: string, signal?: AbortSignal) {
		const output = await this.account.run(
			LIST_SCRIPT,
			{ AMBION_ROOT: this.root, AMBION_ID: id, AMBION_NAMESPACE: namespace },
			signal,
		);
		return parseRepositories(output, this.alias);
	}

	/** Every repository that an agent reaches, in ID order. */
	list(namespace?: string, signal?: AbortSignal): Promise<GitRepository[]> {
		return this.read('', namespace ?? '', signal);
	}

	/** One repository, or `undefined` when no agent reaches it. */
	async get(id: string, signal?: AbortSignal): Promise<GitRepository | undefined> {
		const namespace = namespaceOf(id);
		if (namespace === undefined || namespace === SOURCES) return undefined;
		return (await this.read(id, '', signal)).find((repository) => repository.id === id);
	}

	/** The full hash of the commit that `at` names in `id`, or `undefined`. */
	private async resolve(
		id: string,
		at: GitRevision,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const namespace = namespaceOf(id);
		if (namespace === undefined || namespace === SOURCES) return undefined;
		const output = await this.account.run(
			RESOLVE_SCRIPT,
			{
				AMBION_ROOT: this.root,
				AMBION_ID: id,
				AMBION_REV: revisionOf(at),
				AMBION_KIND: 'commit' in at ? 'hash' : 'ref',
			},
			signal,
		);
		const hash = tagged(output, 'AMBION_COMMIT')[0] ?? '';
		return hash === '' ? undefined : hash;
	}

	/** The commit `hash` of `id`, or `undefined` when either does not exist. */
	private async show(
		id: string,
		hash: string,
		signal?: AbortSignal,
	): Promise<GitCommit | undefined> {
		const namespace = namespaceOf(id);
		if (namespace === undefined || namespace === SOURCES) return undefined;
		const output = await this.account.run(
			SHOW_SCRIPT,
			{ AMBION_ROOT: this.root, AMBION_ID: id, AMBION_HASH: hash },
			signal,
		);
		return commitOf(hash, output);
	}

	envFor(agent: WorkspaceAgent): GitEnv {
		return {
			list: (namespace, signal) => this.list(namespace, signal),
			get: (id, signal) => this.get(id, signal),
			// A refused name rejects the call, the same as every other failure of the env.
			resolve: async (id, at, signal) => this.resolve(id, at, signal),
			show: async (id, hash, signal) => {
				assertCommitHash(hash);
				return this.show(id, hash, signal);
			},
			fork: (source, name, signal) => this.fork(agent, source, name, signal),
			cleanup: async () => undefined,
		};
	}

	private async fork(
		agent: WorkspaceAgent,
		source: string,
		name: string,
		signal?: AbortSignal,
	): Promise<GitForkOutcome> {
		if (!validName(name)) {
			return { ok: false, reason: 'refused', message: `'${name}' is not a valid name.` };
		}
		signal?.throwIfAborted();
		const target = `${agent.name}/${name}`;
		const inFlight = this.forking.get(target);
		if (inFlight !== undefined) {
			const first = await inFlight.catch(() => undefined);
			return this.taken(first, target);
		}
		// The fork takes its place before its first await, so a second fork of one target waits for it.
		const made = this.forkChecked(source, target, signal);
		this.forking.set(target, made);
		try {
			return await made;
		} finally {
			this.forking.delete(target);
		}
	}

	/** Check the source and the target, then fork. */
	private async forkChecked(
		source: string,
		target: string,
		signal?: AbortSignal,
	): Promise<GitForkOutcome> {
		const from = await this.get(source, signal);
		if (from === undefined) return { ok: false, reason: 'no_source', source };
		const existing = await this.get(target, signal);
		if (existing !== undefined) return { ok: false, reason: 'name_taken', repository: existing };
		const output = await this.account.run(
			FORK_SCRIPT,
			{ AMBION_ROOT: this.root, AMBION_SOURCE: source, AMBION_TARGET: target },
			signal,
		);
		const landed = tagged(output, 'AMBION_FORK')[0] === 'landed';
		const repository = await this.get(target);
		if (repository === undefined || !landed) return this.taken(undefined, target, repository);
		return { ok: true, repository };
	}

	/** The outcome for a fork of `target` that another fork reached first. */
	private async taken(
		first: GitForkOutcome | undefined,
		target: string,
		known?: GitRepository,
	): Promise<GitForkOutcome> {
		const repository = known ?? (await this.get(target));
		if (repository !== undefined) return { ok: false, reason: 'name_taken', repository };
		return first?.ok === false
			? first
			: { ok: false, reason: 'refused', message: `The fork ${target} failed.` };
	}
}
