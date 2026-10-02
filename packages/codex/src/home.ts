/**
 * The Codex home of a seat. Codex keeps its config, its sign-in, its
 * threads, and its caches in one directory, `CODEX_HOME`. The execution
 * gives its seats a home of their own, so the config and the instructions
 * of the person who runs the host never reach a seat. The one file the
 * home shares is the sign-in: `auth.json` links to the login of the host.
 * The binary also gets a private home directory, `HOME`, inside the Codex
 * home, and an environment of allowlisted host variables. A seat sources no
 * file of the host user and sees no secret of the host.
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
	 * `CODEX_API_KEY`. A seat with `CODEX_API_KEY` logs in with the key, and the
	 * key wins over `auth.json`. A home that already holds an `auth.json` keeps it.
	 */
	readonly login?: string | false;
	/**
	 * Variables to lay over the environment of the executable. The base is the
	 * variables of this process that `ENV_ALLOWLIST` and `ENV_PREFIXES` name.
	 * A value adds or replaces a variable, and `undefined` removes one. Use it
	 * for the variable that holds the key of a provider. The defaults of `home`
	 * and `login` read the `HOME` and the `CODEX_HOME` of this process with
	 * `env` laid over them. The binary never sees those two values: it always
	 * runs with `CODEX_HOME` set to `home`, and with `HOME` and `USERPROFILE`
	 * set to the private directory `home` holds.
	 */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Where the seats of an execution live and what the binary runs with. */
export interface SeatHome {
	/** The absolute path of the Codex home. */
	readonly path: string;
	/** The absolute path of the login file to link, or nothing when no seat links one. */
	readonly login: string | undefined;
	/** The private home directory of the binary: `home` under `path`. */
	readonly privateHome: string;
	/** The environment of the binary: the allowlisted variables, the overlay, and the variables of the seat. */
	readonly env: Readonly<Record<string, string>>;
}

/** The name of the private home directory inside the Codex home. */
const USER_HOME = 'home';

/**
 * The variables of the host that a seat inherits. The binary needs a path, a
 * locale, a temporary directory, a proxy, a certificate store, and on Windows
 * the system variables. It needs no shell and no terminal: the seat has no
 * native tool.
 */
const ENV_ALLOWLIST = [
	'PATH',
	'USER',
	'LOGNAME',
	'TMPDIR',
	'TEMP',
	'TMP',
	'TZ',
	'LANG',
	'USERPROFILE',
	'APPDATA',
	'LOCALAPPDATA',
	'SYSTEMROOT',
	'COMSPEC',
	'PATHEXT',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'all_proxy',
	'no_proxy',
	'NODE_EXTRA_CA_CERTS',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'CODEX_API_KEY',
	'CODEX_ACCESS_TOKEN',
	'CODEX_CA_CERTIFICATE',
] as const;

/**
 * The prefixes of the variables of the host that a seat inherits as well.
 * `OPENAI_` holds `OPENAI_API_KEY` and `OPENAI_BASE_URL`, which the default
 * provider of Codex reads. A provider with another `env_key` needs the `env`
 * option. No `CODEX_` prefix: Codex reads other `CODEX_` variables that move
 * its state, its sandbox, and its servers out of the seat.
 */
const ENV_PREFIXES = ['OPENAI_', 'LC_'] as const;

type Variables = Readonly<Record<string, string | undefined>>;

/**
 * Whether the allowlist admits a variable name. Windows compares the names
 * of variables without case, and spells some in mixed case (`Path`,
 * `SystemRoot`, `ComSpec`), so the comparison there uses upper case.
 */
function allowed(name: string): boolean {
	const key = process.platform === 'win32' ? name.toUpperCase() : name;
	return (
		(ENV_ALLOWLIST as readonly string[]).includes(key) ||
		ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
	);
}

/** The variables of this process that the allowlist admits, with `overlay` laid over them. */
function overlaid(overlay: Variables | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && allowed(name)) env[name] = value;
	}
	for (const [name, value] of Object.entries(overlay ?? {})) {
		if (value === undefined) delete env[name];
		else env[name] = value;
	}
	return env;
}

/** The environment of the host user: this process with `overlay` laid over it. Only the defaults of `home` and `login` read it. */
function hostEnv(overlay: Variables | undefined): Variables {
	return { ...process.env, ...overlay };
}

/** The name of the sign-in file, in the host login and in the home. */
const AUTH = 'auth.json';

/** The value of a variable, or nothing when it is absent or empty. */
function setValue(env: Variables, name: string): string | undefined {
	const value = env[name];
	return value === undefined || value === '' ? undefined : value;
}

/** The login file of the host: in its `CODEX_HOME` when `env` sets one, else in `.codex` of its home directory. */
function hostLogin(env: Variables, hostHome: string): string {
	const codexHome = setValue(env, 'CODEX_HOME');
	return join(codexHome ?? join(hostHome, '.codex'), AUTH);
}

/**
 * The home, the login, and the environment of a seat. This function only
 * computes: it touches no file. The defaults of `home` and `login` read the
 * environment of the host user, which is this process with `env` laid over
 * it. The environment of the binary is the allowlisted variables of this
 * process, then `env`, then the variables of the seat. The variables of the
 * seat win: `CODEX_HOME` is `path`, and `HOME` and `USERPROFILE` are the
 * private directory `privateHome`.
 */
export function seatHome(options: HomeOptions): SeatHome {
	const host = hostEnv(options.env);
	const hostHome = setValue(host, 'HOME') ?? homedir();
	const path = resolve(options.home ?? join(hostHome, '.ambion', 'codex'));
	const login =
		options.login === false ? undefined : resolve(options.login ?? hostLogin(host, hostHome));
	const own = join(path, USER_HOME);
	const env = { ...overlaid(options.env), CODEX_HOME: path, HOME: own, USERPROFILE: own };
	return { path, login, privateHome: own, env };
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

/** Link the login of the host as `auth.json`. A home that holds an `auth.json` keeps it, and a host with no login file links nothing. */
async function linkLogin(home: SeatHome): Promise<void> {
	if (home.login === undefined || (await listed(join(home.path, AUTH)))) return;
	if (await reachable(home.login)) await linkTo(home.login, home.path);
}

/**
 * Make the home ready: create the directory, link the login of the host as
 * `auth.json`, and create the private home directory of the binary. A home
 * that holds an `auth.json` keeps it, and a host with no login file links
 * nothing. The call is safe to repeat and to run at once for several seats.
 */
export async function openHome(home: SeatHome): Promise<void> {
	// The home holds full transcripts, logs, and the linked login.
	await mkdir(home.path, { recursive: true, mode: 0o700 });
	await linkLogin(home);
	await mkdir(home.privateHome, { recursive: true, mode: 0o700 });
}
