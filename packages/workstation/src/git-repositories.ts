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

import type { GitEnv, GitForkOutcome, GitRepository } from '@ambionframework/workspace';
import { namespaceOf, SOURCES, validName } from '@ambionframework/workspace/git';
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

	envFor(agent: WorkspaceAgent): GitEnv {
		return {
			list: (namespace, signal) => this.list(namespace, signal),
			get: (id, signal) => this.get(id, signal),
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
