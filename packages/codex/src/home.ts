/**
 * The Codex home of a seat. Codex keeps its config, its sign-in, its
 * threads, and its caches in one directory, `CODEX_HOME`. The execution
 * gives its seats a home of their own, so the config and the instructions
 * of the person who runs the host never reach a seat. The one file the
 * home shares is the sign-in: `auth.json` links to the login of the host.
 *
 * Codex writes `auth.json` in place and reads it again before it refreshes
 * a token. A link keeps one login for the host and every seat. A copy would
 * hold a refresh token that Codex rotates, and the two files would diverge.
 */
import { link, lstat, mkdir, stat, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PermanentError } from '@ambionframework/ambion/hosting';

/** The options that place the Codex home of every seat of an execution. */
export interface HomeOptions {
	/**
	 * The Codex home of every seat. Absent, `.ambion/codex` under the `HOME` of
	 * `env`, or under the home directory of the user when `env` has no `HOME`.
	 * The directory persists, so a thread survives a restart of the host.
	 */
	readonly home?: string;
	/**
	 * The `auth.json` to link into the home. Absent, the login of the host:
	 * `auth.json` in the `CODEX_HOME` of `env` when it sets one, else in
	 * `.codex` under its `HOME`. `false` links nothing, for a seat that runs on
	 * `CODEX_API_KEY`. A home that already holds an `auth.json` keeps it.
	 */
	readonly login?: string | false;
	/**
	 * The environment of the executable. Absent, the environment of this
	 * process. Its `CODEX_HOME` names the Codex home of the host, which sets
	 * the default `login`. The binary never sees that value: it always runs
	 * with `CODEX_HOME` set to `home`.
	 */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Where the seats of an execution live and what the binary runs with. */
export interface SeatHome {
	/** The absolute path of the Codex home. */
	readonly path: string;
	/** The absolute path of the login file to link, or nothing when no seat links one. */
	readonly login: string | undefined;
	/** The environment of the binary: the execution environment, with `CODEX_HOME` set to `path`. */
	readonly env: Readonly<Record<string, string>>;
}

/** The name of the sign-in file, in the host login and in the home. */
const AUTH = 'auth.json';

/** The value of a variable, or nothing when it is absent or empty. */
function setValue(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
): string | undefined {
	const value = env[name];
	return value === undefined || value === '' ? undefined : value;
}

/** The login file of the host: in its `CODEX_HOME` when `env` sets one, else in `.codex` of its home directory. */
function hostLogin(env: Readonly<Record<string, string | undefined>>, userHome: string): string {
	const codexHome = setValue(env, 'CODEX_HOME');
	return join(codexHome ?? join(userHome, '.codex'), AUTH);
}

/**
 * The home, the login, and the environment of a seat. This function only
 * computes: it touches no file. The `CODEX_HOME` of `env` places the login
 * of the host. The environment of the binary replaces it with `path`.
 */
export function seatHome(options: HomeOptions): SeatHome {
	const host = options.env ?? process.env;
	const userHome = setValue(host, 'HOME') ?? homedir();
	const path = resolve(options.home ?? join(userHome, '.ambion', 'codex'));
	const login =
		options.login === false ? undefined : resolve(options.login ?? hostLogin(host, userHome));
	const env = Object.fromEntries(
		Object.entries(host).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	return { path, login, env: { ...env, CODEX_HOME: path } };
}

/** Whether a path names an entry. A link counts, whether or not its target exists. */
async function listed(path: string): Promise<boolean> {
	return lstat(path).then(
		() => true,
		() => false,
	);
}

/** Whether a path names a file or a directory, after links. */
async function reachable(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/** Whether the error says that the path exists. A concurrent activation made it. */
function existed(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * Link `target` at `path`: a symbolic link, else a hard link where the host
 * refuses symbolic links, such as Windows with no privilege. A path that
 * another activation made first counts as success.
 */
async function linkTo(target: string, home: string): Promise<void> {
	const path = join(home, AUTH);
	try {
		await symlink(target, path, 'file');
		return;
	} catch (error) {
		if (existed(error)) return;
	}
	try {
		await link(target, path);
	} catch (error) {
		if (existed(error)) return;
		throw new PermanentError(
			`Cannot link ${path} to the login file ${target}: ${(error as Error).message}. ` +
				`Run 'CODEX_HOME=${home} codex login' to sign in to the home, ` +
				`or pass login: false and set CODEX_API_KEY.`,
		);
	}
}

/**
 * Make the home ready: create the directory, and link the login of the host
 * as `auth.json`. A home that holds an `auth.json` keeps it, and a host with
 * no login file links nothing. The call is safe to repeat and to run at
 * once for several seats.
 */
export async function openHome(home: SeatHome): Promise<void> {
	// The home holds full transcripts, logs, and the linked login.
	await mkdir(home.path, { recursive: true, mode: 0o700 });
	if (home.login === undefined || (await listed(join(home.path, AUTH)))) return;
	if (await reachable(home.login)) await linkTo(home.login, home.path);
}
