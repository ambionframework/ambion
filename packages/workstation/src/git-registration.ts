/**
 * The storage steps of registration on the git account.
 * `registerRepositories` of the workspace holds the decisions and calls
 * these steps. Each step runs a shell script on the server.
 *
 * A write goes in three parts. The backend writes the files into a staging
 * folder over SFTP. A script commits them as `ambion` to a bare repository.
 * For a new repository, the script installs a `pre-receive` hook and
 * renames the repository into its folder. The rename is the one step that
 * publishes a repository. A template that changes takes a commit on the
 * tip of `main`, and the move of `main` compares the old commit. A fork is
 * a clone, so a fork made before the update keeps its own objects and refs.
 *
 * A commit adds every file with `--force`, so a `.gitignore` in the source
 * skips no file. The step that reads a repository writes its description
 * when it differs. A crash leaves a folder in `.staging`, and the sweep
 * removes it. When two host processes register one repository at once, one
 * rename or one move wins, and each reads the repository that landed.
 */

import { randomName, type SourceFiles } from '@ambionframework/workspace';
import {
	BACKEND_AUTHOR,
	DEFAULT_BRANCH,
	type RegistrationSteps,
} from '@ambionframework/workspace/git';
import { type GitAccount, runIn, tagged } from './git-account.ts';
import type { SshEnv } from './ssh-env.ts';

/**
 * Write the description of a template when it differs, and print the files
 * at its tip, as `git ls-tree -r -z` in base64. Print nothing when the
 * template does not exist.
 */
const TIP_SCRIPT = [
	'set -euo pipefail',
	'repo="$HOME/$AMBION_ROOT/templates/$AMBION_NAME.git"',
	'[ -f "$repo/HEAD" ] || exit 0',
	`printf '%s' "$AMBION_DESCRIPTION" | cmp -s - "$repo/description" ||`,
	`  printf '%s' "$AMBION_DESCRIPTION" >"$repo/description"`,
	"tree=''",
	'if git --git-dir="$repo" rev-parse -q --verify HEAD >/dev/null; then',
	'  tree=$(git --git-dir="$repo" ls-tree -r -z --full-tree HEAD | base64 -w0)',
	'fi',
	String.raw`printf 'AMBION_TREE %s\n' "$tree"`,
	'',
].join('\n');

/** Check for a published shared repo and update only its description. */
const SHARED_EXISTS_SCRIPT = [
	'set -euo pipefail',
	'repo="$HOME/$AMBION_ROOT/shared/$AMBION_NAME.git"',
	'[ -f "$repo/HEAD" ] || exit 0',
	`printf '%s' "$AMBION_DESCRIPTION" | cmp -s - "$repo/description" ||`,
	`  printf '%s' "$AMBION_DESCRIPTION" >"$repo/description"`,
	"printf 'AMBION_SHARED_EXISTS 1\\n'",
	'',
].join('\n');

/** The lines that make the next commit come from the backend author. */
const AS_BACKEND = [
	`export GIT_AUTHOR_NAME=${BACKEND_AUTHOR.name} GIT_AUTHOR_EMAIL=${BACKEND_AUTHOR.email}`,
	`export GIT_COMMITTER_NAME=${BACKEND_AUTHOR.name} GIT_COMMITTER_EMAIL=${BACKEND_AUTHOR.email}`,
];

/** Commit the files of the staging folder to a new bare repository, and rename it into `templates`. */
const BUILD_SCRIPT = [
	'set -euo pipefail',
	'root="$HOME/$AMBION_ROOT"',
	'stage="$root/.staging/$AMBION_STAGE"',
	'repo="$stage/repo.git"',
	'mkdir -p "$stage/files"',
	'git init --bare --quiet "$repo"',
	'export GIT_DIR="$repo" GIT_WORK_TREE="$stage/files" GIT_INDEX_FILE="$stage/index"',
	'git add -A --force',
	'tree=$(git write-tree)',
	...AS_BACKEND,
	String.raw`commit=$(printf 'Register the template %s\n' "$AMBION_NAME" | git commit-tree "$tree")`,
	`git update-ref refs/heads/${DEFAULT_BRANCH} "$commit"`,
	`git symbolic-ref HEAD refs/heads/${DEFAULT_BRANCH}`,
	'git config core.logAllRefUpdates always',
	'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
	`[ -z "$AMBION_DESCRIPTION" ] || printf '%s' "$AMBION_DESCRIPTION" >"$repo/description"`,
	'mkdir -p "$repo/hooks"',
	String.raw`printf '#!/bin/sh\necho "ambion: a template is read-only" >&2\nexit 1\n' >"$repo/hooks/pre-receive"`,
	'chmod 755 "$repo/hooks/pre-receive"',
	'mkdir -p "$root/templates"',
	'mv -T "$repo" "$root/templates/$AMBION_NAME.git" 2>/dev/null || true',
	'rm -rf -- "$stage"',
	'',
].join('\n');

/**
 * Commit the files of the staging folder on the tip of a template's `main`,
 * and move `main` if no other write moved it. Print the error of git, in
 * base64, when the move fails.
 */
const UPDATE_SCRIPT = [
	'set -euo pipefail',
	'root="$HOME/$AMBION_ROOT"',
	'stage="$root/.staging/$AMBION_STAGE"',
	'repo="$root/templates/$AMBION_NAME.git"',
	'mkdir -p "$stage/files"',
	`old=$(git --git-dir="$repo" rev-parse -q --verify refs/heads/${DEFAULT_BRANCH} || true)`,
	'export GIT_DIR="$repo" GIT_WORK_TREE="$stage/files" GIT_INDEX_FILE="$stage/index"',
	'git add -A --force',
	'tree=$(git write-tree)',
	...AS_BACKEND,
	'if [ -n "$old" ]; then set -- -p "$old"; else set --; fi',
	String.raw`commit=$(printf 'Register the template %s\n' "$AMBION_NAME" | git commit-tree "$tree" "$@")`,
	`if ! refused=$(git update-ref refs/heads/${DEFAULT_BRANCH} "$commit" "$old" 2>&1); then`,
	String.raw`  printf 'AMBION_REFUSED %s\n' "$(printf '%s' "$refused" | base64 -w0)"`,
	'fi',
	'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
	'rm -rf -- "$stage"',
	'',
].join('\n');

/** Build and fully seed a shared repo before its rename publishes it. */
const SHARED_BUILD_SCRIPT = [
	'set -euo pipefail',
	'root="$HOME/$AMBION_ROOT"',
	'stage="$root/.staging/$AMBION_STAGE"',
	'repo="$stage/repo.git"',
	'mkdir -p "$stage/files"',
	'git init --bare --quiet "$repo"',
	'export GIT_DIR="$repo" GIT_WORK_TREE="$stage/files" GIT_INDEX_FILE="$stage/index"',
	'git add -A --force',
	'tree=$(git write-tree)',
	...AS_BACKEND,
	String.raw`commit=$(printf 'Register the shared repository %s\n' "$AMBION_NAME" | git commit-tree "$tree")`,
	`git update-ref refs/heads/${DEFAULT_BRANCH} "$commit"`,
	`git symbolic-ref HEAD refs/heads/${DEFAULT_BRANCH}`,
	'git config core.logAllRefUpdates always',
	'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
	`[ -z "$AMBION_DESCRIPTION" ] || printf '%s' "$AMBION_DESCRIPTION" >"$repo/description"`,
	'mkdir -p "$repo/hooks"',
	'cat >"$repo/hooks/pre-receive" <<\'AMBION_HOOK\'',
	'#!/bin/sh',
	'set -eu',
	"zero=$(printf '%040d' 0)",
	'protected=$(git symbolic-ref HEAD)',
	'while read old new ref; do',
	'  [ "$ref" = "$protected" ] || continue',
	'  [ "$new" != "$zero" ] || { echo "ambion: cannot delete protected branch $protected" >&2; exit 1; }',
	'  if [ "$old" != "$zero" ] && ! git --no-replace-objects merge-base --is-ancestor "$old" "$new"; then',
	'    echo "ambion: non-fast-forward push to protected branch $protected" >&2',
	'    exit 1',
	'  fi',
	'done',
	'AMBION_HOOK',
	'chmod 755 "$repo/hooks/pre-receive"',
	'mkdir -p "$root/shared"',
	'mv -T "$repo" "$root/shared/$AMBION_NAME.git" 2>/dev/null || true',
	'rm -rf -- "$stage"',
	'',
].join('\n');

/** Each blob of `git ls-tree -r -z` output, by path. */
function blobsOf(listing: Buffer): ReadonlyMap<string, string> {
	const blobs = new Map<string, string>();
	for (const entry of listing.toString('utf8').split('\0')) {
		const tab = entry.indexOf('\t');
		const [, type, hash] = entry.slice(0, tab).split(' ');
		if (tab > 0 && type === 'blob' && hash !== undefined) blobs.set(entry.slice(tab + 1), hash);
	}
	return blobs;
}

/**
 * Write the description of `templates/<name>` when it differs, and give the
 * blob hashes at its tip, or `undefined` when it does not exist.
 */
async function tipOf(
	account: GitAccount,
	root: string,
	name: string,
	description: string | undefined,
): Promise<ReadonlyMap<string, string> | undefined> {
	const output = await account.run(TIP_SCRIPT, {
		AMBION_ROOT: root,
		AMBION_NAME: name,
		AMBION_DESCRIPTION: description ?? '',
	});
	const tree = tagged(output, 'AMBION_TREE')[0];
	return tree === undefined ? undefined : blobsOf(Buffer.from(tree, 'base64'));
}

/** Write each file into the staging folder over SFTP. */
async function writeFiles(env: SshEnv, folder: string, files: SourceFiles): Promise<void> {
	for (const [path, bytes] of Object.entries(files)) {
		const written = await env.writeFile(`${folder}/${path}`, bytes);
		if (!written.ok) throw written.error;
	}
}

/** Write `files` into a new folder in `.staging`, run `script` over it, and give its output. */
async function stageAndRun(
	account: GitAccount,
	root: string,
	name: string,
	description: string | undefined,
	files: SourceFiles,
	script: string,
): Promise<string> {
	const stage = `template.${randomName()}`;
	return account.use(async (env, session) => {
		await writeFiles(env, `${session.home}/${root}/.staging/${stage}/files`, files);
		return runIn(env, script, {
			AMBION_ROOT: root,
			AMBION_STAGE: stage,
			AMBION_NAME: name,
			AMBION_DESCRIPTION: description ?? '',
		});
	});
}

/** The git refusal that a move of `main` printed, or `undefined` when the move succeeded. */
function refusalOf(output: string): string | undefined {
	const refused = tagged(output, 'AMBION_REFUSED')[0];
	return refused === undefined ? undefined : Buffer.from(refused, 'base64').toString('utf8').trim();
}

async function sharedExists(
	account: GitAccount,
	root: string,
	name: string,
	description: string | undefined,
): Promise<boolean> {
	const output = await account.run(SHARED_EXISTS_SCRIPT, {
		AMBION_ROOT: root,
		AMBION_NAME: name,
		AMBION_DESCRIPTION: description ?? '',
	});
	return tagged(output, 'AMBION_SHARED_EXISTS').length > 0;
}

/** The storage steps of registration over the git account: shell scripts and a staging folder. */
export function registrationSteps(account: GitAccount, root: string): RegistrationSteps {
	return {
		template: (name, description) => tipOf(account, root, name, description),
		createTemplate: async (name, files, description) => {
			await stageAndRun(account, root, name, description, files, BUILD_SCRIPT);
		},
		updateTemplate: async (name, files, description) => {
			const output = await stageAndRun(account, root, name, description, files, UPDATE_SCRIPT);
			const refusal = refusalOf(output);
			if (refusal !== undefined) {
				throw new Error(
					`The template '${name}' did not move to its new source: git update-ref failed: ${refusal}`,
				);
			}
		},
		shared: (name, description) => sharedExists(account, root, name, description),
		seedShared: async (name, files, description) => {
			await stageAndRun(account, root, name, description, files, SHARED_BUILD_SCRIPT);
		},
	};
}
