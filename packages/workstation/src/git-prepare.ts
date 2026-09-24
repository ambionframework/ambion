/**
 * The preparation of the git account, once before the first operation of
 * the backend: `~/.ambion` and `~/.ssh`, the forced command `serve`, the
 * sweep of the staging folder, and the templates.
 *
 * `serve` goes to a temporary name and then a rename, and only when its
 * content differs: `bash` reads a script as it runs, and a write in place
 * can change a running copy. The first `connect` and the first
 * `identityFor` await one preparation, so no key reaches `sshd` before its
 * forced command exists.
 */

import type { TemplateRegistration } from '@ambionframework/workspace/git';
import type { GitAccount } from './git-account.ts';
import { runIn } from './git-account.ts';
import { registerTemplates } from './git-registration.ts';

/** What the preparation learns about the account. */
export interface Prepared {
	/** The path of `serve`, from the home that the client reads with `realpath('.')`. */
	readonly serve: string;
	/** The host key that the client of the account verified: the key type, a space, and the base64 key. */
	readonly hostKey: string;
}

/** A home that the `command` option of a key line holds with no quoting. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/-]*$/;

/**
 * The forced command of every agent key. `sshd` puts the client's command
 * in `SSH_ORIGINAL_COMMAND`, and `serve` accepts a read or a push of one
 * repository in the form that `git` sends. The name pattern is the name
 * rule of a repository, so no path leaves the folder of the repositories.
 */
function serveScript(root: string): string {
	return [
		'#!/usr/bin/env bash',
		'set -euo pipefail',
		'agent="$1"',
		`re="^(git-upload-pack|git-receive-pack) '/?([a-z][a-z0-9-]*)/([a-z0-9][a-z0-9._-]{0,63})'$"`,
		`[[ "\${SSH_ORIGINAL_COMMAND:-}" =~ $re ]] || { echo 'ambion: refused' >&2; exit 1; }`,
		`service="\${BASH_REMATCH[1]}" namespace="\${BASH_REMATCH[2]}" name="\${BASH_REMATCH[3]}"`,
		`repo="$HOME/${root}/$namespace/$name.git"`,
		'if [ "$namespace" = template-sources ] || ! [ -f "$repo/HEAD" ]; then',
		'  echo "ambion: $namespace/$name does not exist" >&2; exit 1',
		'fi',
		'if [ "$service" = git-receive-pack ] && [ "$namespace" != "$agent" ]; then',
		'  echo "ambion: $agent cannot push to $namespace/$name" >&2; exit 1',
		'fi',
		'export GIT_COMMITTER_NAME="$agent" GIT_COMMITTER_EMAIL="$agent@ambion.invalid"',
		`exec git "\${service#git-}" "$repo"`,
		'',
	].join('\n');
}

/** Make the folders, write `serve` when it differs, and remove the staging folders older than one hour. */
const PREPARE_SCRIPT = [
	'set -euo pipefail',
	'umask 077',
	'mkdir -p "$HOME/.ambion" "$HOME/.ssh" "$HOME/$AMBION_ROOT/.staging"',
	'chmod 700 "$HOME/.ambion" "$HOME/.ssh"',
	'serve="$HOME/.ambion/serve"',
	'if ! [ -f "$serve" ] || [ "$(cat "$serve"; printf .)" != "$AMBION_SERVE." ]; then',
	'  next=$(mktemp "$HOME/.ambion/.serve.XXXXXX")',
	`  printf '%s' "$AMBION_SERVE" >"$next"`,
	'  chmod 700 "$next"',
	'  mv -f "$next" "$serve"',
	'fi',
	'find "$HOME/$AMBION_ROOT/.staging" -mindepth 1 -maxdepth 1 -mmin +60 -exec rm -rf -- {} +',
	'',
].join('\n');

/** Prepare the account, and register every template. */
export async function prepareAccount(
	account: GitAccount,
	root: string,
	templates: Readonly<Record<string, TemplateRegistration>>,
): Promise<Prepared> {
	const prepared = await account.use(async (env, session) => {
		if (!PLAIN_PATH.test(session.home)) {
			throw new Error(
				`The home of the git account, ${session.home}, holds a character that a key line cannot hold.`,
			);
		}
		await runIn(env, PREPARE_SCRIPT, { AMBION_ROOT: root, AMBION_SERVE: serveScript(root) });
		return { serve: `${session.home}/.ambion/serve`, hostKey: session.hostKey };
	});
	await registerTemplates(account, root, templates);
	return prepared;
}
