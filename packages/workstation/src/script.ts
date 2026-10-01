/**
 * The script that one `exec` writes to `setsid --wait bash -s` on the
 * channel's standard input.
 *
 * The command's stderr joins its stdout, so the output arrives in the order
 * the command wrote it. The channel's stderr then carries only the script's
 * own lines.
 *
 * `sshd` drops an `env` request unless `AcceptEnv` names the variable, so the
 * variables travel in the script, and no value reaches a command line that
 * `ps` shows to another account. The command runs as `bash -c <command>`,
 * the same as a local shell: it is the body of a quoted heredoc,
 * so bash reads it as text, and its standard input is `/dev/null`, so it
 * cannot read the rest of the script.
 *
 * `trap : TERM` keeps the script's shell alive through the `SIGTERM` of a
 * stop. It waits for the command, so the channel reports the command's own
 * exit status. The handler resets to the default in the command.
 */

import { randomName, shellQuote } from '@ambionframework/workspace';

/** The stderr line that gives the process group ID. `exec` reads it and removes it. */
export const PGID_PREFIX = 'AMBION_PGID=';

/** The shell's name for an environment variable. */
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A heredoc delimiter that no line of `command` equals. */
function delimiterFor(command: string): string {
	const lines = new Set(command.split('\n'));
	let delimiter = `AMBION_${randomName()}`;
	while (lines.has(delimiter)) delimiter = `AMBION_${randomName()}`;
	return delimiter;
}

/** The names in `env` that the shell cannot export. */
export function invalidNames(env: Readonly<Record<string, string>> | undefined): string[] {
	return Object.keys(env ?? {}).filter((name) => !VARIABLE.test(name));
}

/** The whole script for one command. Check `invalidNames(env)` first. */
export function commandScript(
	command: string,
	cwd: string,
	env: Readonly<Record<string, string>> | undefined,
): string {
	const delimiter = delimiterFor(command);
	const exports = Object.entries(env ?? {}).map(
		([name, value]) => `export ${name}=${shellQuote(value)}`,
	);
	return [
		`printf '\\n${PGID_PREFIX}%s\\n' "$$" >&2`,
		'trap : TERM',
		`cd -- ${shellQuote(cwd)} || exit 1`,
		...exports,
		`bash -c "$(cat <<'${delimiter}'`,
		command,
		delimiter,
		`)" </dev/null 2>&1`,
		'',
	].join('\n');
}
