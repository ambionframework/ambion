/**
 * The agent side of `workstationGitBackend`: the files in the agent's
 * `~/.ssh` that let its own `git` reach the git account.
 *
 * At each `connect`, the bash backend writes three files with mode `0600`:
 * the key that `identityFor` gives, a `known_hosts` file with one line for
 * the alias, and an ssh configuration that maps the alias to the loopback
 * address. It makes `Include ambion-git.conf` the first line of
 * `~/.ssh/config` and keeps every other line. An `Include` after a `Host`
 * block applies to that block alone, so the line comes first.
 *
 * One script reads the files and writes each one that differs. Each write
 * goes to a temporary name in `~/.ssh`, then `chmod 600`, then a rename, so
 * no reader sees a half file and each rename stays on one filesystem.
 */

import type { BashServices } from '@ambionframework/workspace';
import { runIn, type ScriptVariables } from './git-account.ts';
import type { WorkstationGitAccess, WorkstationGitIdentity } from './git-backend.ts';
import type { SshEnv } from './ssh-env.ts';

/** The git transport that the shell of the workstation carries. */
export const WORKSTATION_TRANSPORTS: readonly string[] = Object.freeze(['ssh']);

/**
 * The access of `workstationGitBackend`, narrowed by its transport.
 * `openWorkspace` refuses a transport outside `WORKSTATION_TRANSPORTS`
 * first. This check holds the rule for a caller that connects without a
 * workspace.
 */
export function sshAccess(services: BashServices | undefined): WorkstationGitAccess | undefined {
	const access = services?.git;
	if (access === undefined) return undefined;
	if (!WORKSTATION_TRANSPORTS.includes(access.transport)) {
		throw new Error(
			`The workstation carries the git transport ssh, and the git access uses ${access.transport}.`,
		);
	}
	return access as WorkstationGitAccess;
}

/** The ssh configuration of the alias. `ssh` expands `~` in each path. */
function configOf(identity: WorkstationGitIdentity): string {
	return [
		`Host ${identity.alias}`,
		'  HostName 127.0.0.1',
		`  Port ${identity.port}`,
		`  User ${identity.user}`,
		'  IdentityFile ~/.ssh/ambion-git.key',
		'  IdentitiesOnly yes',
		`  HostKeyAlias ${identity.alias}`,
		'  UserKnownHostsFile ~/.ssh/ambion-git.known_hosts',
		'  StrictHostKeyChecking yes',
		'  BatchMode yes',
		'',
	].join('\n');
}

/** The values of the script: the content of each file. */
function gitFiles(identity: WorkstationGitIdentity): ScriptVariables {
	return {
		AMBION_KEY: identity.privateKey,
		AMBION_KNOWN: `${identity.alias} ${identity.hostKey}\n`,
		AMBION_CONF: configOf(identity),
	};
}

/**
 * Write each file that differs from its value, or that has a mode other
 * than `0600`. Then put the `Include` line first in `~/.ssh/config`.
 */
const FILES_SCRIPT = [
	'set -euo pipefail',
	'umask 077',
	'dir="$HOME/.ssh"',
	'[ -d "$dir" ] || mkdir -m 700 "$dir"',
	'next=',
	`trap 'rm -f -- "$next"' EXIT`,
	'put() {',
	'  local file="$dir/$1"',
	'  if [ -f "$file" ] && [ "$(stat -c %a "$file")" = 600 ] && [ "$(cat "$file"; printf .)" = "$2." ]; then return 0; fi',
	'  next=$(mktemp "$dir/.$1.XXXXXX")',
	`  printf '%s' "$2" >"$next"`,
	'  chmod 600 "$next"',
	'  mv -f "$next" "$file"',
	'}',
	'put ambion-git.key "$AMBION_KEY"',
	'put ambion-git.known_hosts "$AMBION_KNOWN"',
	'put ambion-git.conf "$AMBION_CONF"',
	'config="$dir/config"',
	'line="Include ambion-git.conf"',
	'first=',
	'if [ -f "$config" ]; then IFS= read -r first <"$config" || true; fi',
	'if [ "$first" != "$line" ]; then',
	'  next=$(mktemp "$dir/.config.XXXXXX")',
	String.raw`  { printf '%s\n' "$line"; if [ -f "$config" ]; then cat "$config"; fi; } >"$next"`,
	'  chmod 600 "$next"',
	'  mv -f "$next" "$config"',
	'fi',
	'',
].join('\n');

/** Keep the git files of one agent current, over that agent's environment. */
export async function writeGitFiles(
	env: SshEnv,
	identity: WorkstationGitIdentity,
	signal?: AbortSignal,
): Promise<void> {
	await runIn(env, FILES_SCRIPT, gitFiles(identity), signal, 'The script of the git files');
}
