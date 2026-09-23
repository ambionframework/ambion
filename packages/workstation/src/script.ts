/**
 * The script that one `exec` writes to `setsid --wait bash -s` on the
 * channel's standard input.
 *
 * The command's stderr joins its stdout, so the output arrives in the order
 * the command wrote it. The channel's stderr then carries only the script's
 * own lines. With a spill path, `tee` copies the output into a file that the
 * script creates first, with an exclusive create and mode `0600`. The script
 * does not wait for `tee`, so a child that keeps the output open does not
 * hold the exit status back.
 *
 * `sshd` drops an `env` request unless `AcceptEnv` names the variable, so the
 * variables travel in the script, and no value reaches a command line that
 * `ps` shows to another account. The command runs as `bash -c <command>`,
 * the same as in Pi's `NodeExecutionEnv`: it is the body of a quoted heredoc,
 * so bash reads it as text, and its standard input is `/dev/null`, so it
 * cannot read the rest of the script.
 */

import { randomName } from '@ambionframework/workspace';

/** The stderr line that gives the process group ID. `exec` reads it and removes it. */
export const PGID_PREFIX = 'AMBION_PGID=';

/** The shell's name for an environment variable. */
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `value` in single quotes for the shell. */
export function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

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

/** The spill file's variable in the script. Nothing exports it, so the command does not see it. */
const SPILL_VARIABLE = '__ambion_spill';

/** The lines that create the spill file, or point `tee` at `/dev/null` when the create fails. */
function spillLines(path: string): string[] {
	return [
		`${SPILL_VARIABLE}=${quote(path)}`,
		`(set -C; umask 077; : >"$${SPILL_VARIABLE}") 2>/dev/null || ${SPILL_VARIABLE}=/dev/null`,
	];
}

/** The whole script for one command. Check `invalidNames(env)` first. */
export function commandScript(
	command: string,
	cwd: string,
	env: Readonly<Record<string, string>> | undefined,
	spill?: string,
): string {
	const delimiter = delimiterFor(command);
	const exports = Object.entries(env ?? {}).map(
		([name, value]) => `export ${name}=${quote(value)}`,
	);
	const output = spill === undefined ? '2>&1' : `> >(exec tee -a -- "$${SPILL_VARIABLE}") 2>&1`;
	return [
		`printf '${PGID_PREFIX}%s\\n' "$$" >&2`,
		`cd -- ${quote(cwd)} || exit 1`,
		...exports,
		...(spill === undefined ? [] : spillLines(spill)),
		`bash -c "$(cat <<'${delimiter}'`,
		command,
		delimiter,
		`)" </dev/null ${output}`,
		'',
	].join('\n');
}
