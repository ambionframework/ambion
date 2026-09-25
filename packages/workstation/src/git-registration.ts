/**
 * Template registration on the git account: idempotent, and a crash leaves
 * no half template.
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

import { randomName } from '@ambionframework/workspace';
import {
	filesOf,
	hashesOf,
	sameFiles,
	type TemplateFiles,
	type TemplateRegistration,
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
	'if [ "$(cat "$repo/description" 2>/dev/null || true)" != "$AMBION_DESCRIPTION" ]; then',
	`  printf '%s' "$AMBION_DESCRIPTION" >"$repo/description"`,
	'fi',
	"tree=''",
	'if git --git-dir="$repo" rev-parse -q --verify HEAD >/dev/null; then',
	'  tree=$(git --git-dir="$repo" ls-tree -r -z --full-tree HEAD | base64 -w0)',
	'fi',
	String.raw`printf 'AMBION_TREE %s\n' "$tree"`,
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

/** Commit the files of the staging folder on the tip of a template's `main`, and move `main` if no other write moved it. */
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
	'git update-ref refs/heads/main "$commit" "$old" 2>/dev/null || true',
	'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
	'rm -rf -- "$stage"',
	'',
].join('\n');

/** Refuse a path that leaves the root of the template. */
function checkPaths(name: string, files: TemplateFiles): void {
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

/** The blob hashes at the tip of `templates/<name>`, or `undefined` when it does not exist. */
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
async function writeFiles(env: SshEnv, folder: string, files: TemplateFiles): Promise<void> {
	for (const [path, bytes] of Object.entries(files)) {
		const written = await env.writeFile(`${folder}/${path}`, bytes, BACKGROUND_CONTEXT);
		if (!written.ok) throw written.error;
	}
}

/** Write the files of a template into a new folder in `.staging`, and run `script` over it. */
async function stageAndRun(
	account: GitAccount,
	root: string,
	name: string,
	registration: TemplateRegistration,
	files: TemplateFiles,
	script: string,
): Promise<void> {
	const stage = `template.${randomName()}`;
	await account.use(async (env, session) => {
		await writeFiles(env, `${session.home}/${root}/.staging/${stage}/files`, files);
		await runIn(env, script, {
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
	registration: TemplateRegistration,
): Promise<void> {
	if (!validName(name)) throw new Error(`'${name}' is not a valid template name.`);
	const files = await filesOf(registration);
	checkPaths(name, files);
	const wanted = hashesOf(files);
	const tip = await tipOf(account, root, name, registration.description);
	if (tip !== undefined && sameFiles(tip, wanted)) return;
	const script = tip === undefined ? BUILD_SCRIPT : UPDATE_SCRIPT;
	await stageAndRun(account, root, name, registration, files, script);
	const landed = await tipOf(account, root, name, registration.description);
	if (landed === undefined)
		throw new Error(`The template '${name}' is missing after its registration.`);
	if (!sameFiles(landed, wanted)) {
		throw new Error(
			`The template '${name}' does not hold its source after its registration. Another host process can have registered other files.`,
		);
	}
}

/** Register every template, in name order. */
export async function registerTemplates(
	account: GitAccount,
	root: string,
	templates: Readonly<Record<string, TemplateRegistration>>,
): Promise<void> {
	for (const name of Object.keys(templates).sort()) {
		const registration = templates[name];
		if (registration !== undefined) await registerOne(account, root, name, registration);
	}
}
