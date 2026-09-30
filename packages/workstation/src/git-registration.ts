/**
 * Repository registration on the git account: templates can refresh from
 * their source, while shared repositories are seeded once and then kept as
 * shared state. A crash leaves no partially published repository.
 *
 * For each template, in name order, registration takes the first case that
 * holds, and it compares the files by their blob hashes.
 *
 * 1. The template exists, and `git ls-tree -r` of its tip gives the blob
 *    hashes of the source. Nothing happens.
 * 2. The template exists, and the hashes differ. The backend writes the
 *    files into a staging folder over SFTP, commits them on the tip of
 *    `main` as `ambion`, and moves `main` to that commit. A fork is a clone,
 *    so a fork made before the update keeps its own objects and refs.
 * 3. The template does not exist. The backend writes the files into a
 *    staging folder over SFTP, commits them to a new bare repository on
 *    `main` as `ambion`, writes the description, installs a `pre-receive`
 *    hook that refuses every push, and renames the repository to
 *    `templates/<name>.git`.
 *
 * A commit adds every file with `--force`, so a `.gitignore` in the source
 * skips no file. Each case writes the description when it differs. The rename is the one
 * step that publishes a template, and the move of `main` compares the old
 * commit. A crash leaves a folder in `.staging`, and the sweep removes it.
 * When two host processes register one template at once, one rename or one
 * move wins, and each compares the template that landed.
 */

import { randomName, type SourceFiles } from '@ambionframework/workspace';
import {
	filesOf,
	hashesOf,
	type RepositoryRegistration,
	sameFiles,
	validName,
} from '@ambionframework/workspace/git';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
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
	'export GIT_AUTHOR_NAME=ambion GIT_AUTHOR_EMAIL=ambion@ambion.invalid',
	'export GIT_COMMITTER_NAME=ambion GIT_COMMITTER_EMAIL=ambion@ambion.invalid',
	String.raw`commit=$(printf 'Register the template %s\n' "$AMBION_NAME" | git commit-tree "$tree")`,
	'git update-ref refs/heads/main "$commit"',
	'git symbolic-ref HEAD refs/heads/main',
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
	'old=$(git --git-dir="$repo" rev-parse -q --verify refs/heads/main || true)',
	'export GIT_DIR="$repo" GIT_WORK_TREE="$stage/files" GIT_INDEX_FILE="$stage/index"',
	'git add -A --force',
	'tree=$(git write-tree)',
	'export GIT_AUTHOR_NAME=ambion GIT_AUTHOR_EMAIL=ambion@ambion.invalid',
	'export GIT_COMMITTER_NAME=ambion GIT_COMMITTER_EMAIL=ambion@ambion.invalid',
	'if [ -n "$old" ]; then set -- -p "$old"; else set --; fi',
	String.raw`commit=$(printf 'Register the template %s\n' "$AMBION_NAME" | git commit-tree "$tree" "$@")`,
	'if ! refused=$(git update-ref refs/heads/main "$commit" "$old" 2>&1); then',
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
	'export GIT_AUTHOR_NAME=ambion GIT_AUTHOR_EMAIL=ambion@ambion.invalid',
	'export GIT_COMMITTER_NAME=ambion GIT_COMMITTER_EMAIL=ambion@ambion.invalid',
	String.raw`commit=$(printf 'Register the shared repository %s\n' "$AMBION_NAME" | git commit-tree "$tree")`,
	'git update-ref refs/heads/main "$commit"',
	'git symbolic-ref HEAD refs/heads/main',
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

/** Refuse a path that leaves the root of the template. */
function checkPaths(name: string, files: SourceFiles): void {
	for (const path of Object.keys(files)) {
		const parts = path.split('/');
		if (parts.some((part) => part === '' || part === '.' || part === '..' || part === '.git')) {
			throw new Error(`The template '${name}' holds the path '${path}', which leaves its root.`);
		}
	}
}

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
		const written = await env.writeFile(`${folder}/${path}`, bytes, BACKGROUND_CONTEXT);
		if (!written.ok) throw written.error;
	}
}

/** Write the files of a template into a new folder in `.staging`, run `script` over it, and give its output. */
async function stageAndRun(
	account: GitAccount,
	root: string,
	name: string,
	registration: RepositoryRegistration,
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
			AMBION_DESCRIPTION: registration.description ?? '',
		});
	});
}

async function registerOne(
	account: GitAccount,
	root: string,
	name: string,
	registration: RepositoryRegistration,
): Promise<void> {
	if (!validName(name)) throw new Error(`'${name}' is not a valid template name.`);
	const files = await filesOf(registration);
	checkPaths(name, files);
	const wanted = hashesOf(files);
	const tip = await tipOf(account, root, name, registration.description);
	if (tip !== undefined && sameFiles(tip, wanted)) return;
	const script = tip === undefined ? BUILD_SCRIPT : UPDATE_SCRIPT;
	const output = await stageAndRun(account, root, name, registration, files, script);
	const landed = await tipOf(account, root, name, registration.description);
	if (landed === undefined)
		throw new Error(`The template '${name}' is missing after its registration.`);
	if (!sameFiles(landed, wanted)) throw new Error(notLanded(name, output));
}

/** The error of a registration whose template does not hold its source: the error of git, or another host. */
function notLanded(name: string, output: string): string {
	const refused = tagged(output, 'AMBION_REFUSED')[0];
	const cause =
		refused === undefined
			? 'Another host process can have registered other files.'
			: `git update-ref failed: ${Buffer.from(refused, 'base64').toString('utf8').trim()}`;
	return `The template '${name}' does not hold its source after its registration. ${cause}`;
}

/** Register every template, in name order. */
export async function registerTemplates(
	account: GitAccount,
	root: string,
	templates: Readonly<Record<string, RepositoryRegistration>>,
): Promise<void> {
	for (const name of Object.keys(templates).sort()) {
		const registration = templates[name];
		if (registration !== undefined) await registerOne(account, root, name, registration);
	}
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

async function registerSharedOne(
	account: GitAccount,
	root: string,
	name: string,
	registration: RepositoryRegistration,
): Promise<void> {
	if (!validName(name)) throw new Error(`'${name}' is not a valid shared repository name.`);
	// A published shared repo is durable shared state. Registration only
	// updates its description and must not even read the configured source.
	if (await sharedExists(account, root, name, registration.description)) return;
	const files = await filesOf(registration);
	checkPaths(name, files);
	await stageAndRun(account, root, name, registration, files, SHARED_BUILD_SCRIPT);
	if (!(await sharedExists(account, root, name, registration.description)))
		throw new Error(`The shared repository '${name}' is missing after its registration.`);
}

/** Register shared repositories in name order. */
export async function registerShared(
	account: GitAccount,
	root: string,
	shared: Readonly<Record<string, RepositoryRegistration>>,
): Promise<void> {
	for (const name of Object.keys(shared).sort()) {
		const registration = shared[name];
		if (registration !== undefined) await registerSharedOne(account, root, name, registration);
	}
}
