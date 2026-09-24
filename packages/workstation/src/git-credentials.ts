/**
 * The git credentials of one account on the server, kept current in
 * `~/.git-credentials`.
 *
 * A workstation runs a real `git`, and it reads each credential from a
 * file. On the first connection of each session, the backend sets a
 * credential helper that answers `get` from the file alone, with
 * `useHttpPath`, so one line matches one repository. `git` never writes
 * the file. Each `connect` renders one line for each credential that the
 * agent holds, reads the file over SFTP, and writes it when the two
 * differ, so a line that someone removed comes back at the next
 * `connect`. Each write sets the git settings again, since a home that
 * lost the file can have lost them too.
 *
 * A credential counts as missing when little of its life is left: the
 * margin is the smaller of 10 minutes and half of its life. Until then the
 * session keeps the credential it holds, so the file changes only when a
 * repository comes or goes, or a credential enters its margin.
 *
 * No token reaches a command line. The backend writes the file over SFTP
 * to a temporary name in the home, then moves it into place with mode
 * `0600`. The home has mode `0700`, so no other account reads the file.
 */

import {
	BACKGROUND_CONTEXT,
	type GitAccess,
	type GitCredential,
	randomName,
	type WorkspaceEnv,
} from '@ambionframework/workspace';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';

/** The most of a credential's life that its margin takes. */
const MAX_MARGIN_MS = 10 * 60 * 1000;

const FILE = '~/.git-credentials';

/**
 * A helper that answers `get` from the file alone. The plain `store` helper
 * also rewrites the file after each request, in a form of its own, so the
 * file would differ from the backend's at every `connect`. With this one,
 * the backend is the one writer of the file.
 */
const HELPER = '!f() { test "$1" = get && git credential-store --file ~/.git-credentials get; }; f';

const CONFIGURE = [
	`git config --global --replace-all credential.helper '${HELPER}'`,
	'git config --global credential.useHttpPath true',
].join(' && ');

/** One credential that a session holds, and when it counts as missing. */
interface Held {
	readonly credential: GitCredential;
	/** Milliseconds since the epoch. */
	readonly renewAt: number;
}

/** What one session knows of its git credentials. */
export interface GitCredentialState {
	configured: boolean;
	held: ReadonlyMap<string, Held>;
}

/** The state of a session that has written nothing yet. */
export function freshGitState(): GitCredentialState {
	return { configured: false, held: new Map() };
}

/** The credentials to write: each one the session holds while it lasts, and a new one otherwise. */
function renewed(
	current: ReadonlyMap<string, Held>,
	issued: readonly GitCredential[],
	now: number,
): Map<string, Held> {
	const next = new Map<string, Held>();
	for (const credential of issued) {
		const prior = current.get(credential.url);
		if (prior !== undefined && prior.credential.scope === credential.scope && prior.renewAt > now) {
			next.set(credential.url, prior);
			continue;
		}
		const margin = Math.min(MAX_MARGIN_MS, (credential.expiresAt - now) / 2);
		next.set(credential.url, { credential, renewAt: credential.expiresAt - margin });
	}
	return next;
}

/** One line of `~/.git-credentials`: `<protocol>://ambion:<token>@<host>/<path>`. */
function lineOf(credential: GitCredential): string {
	const url = new URL(credential.url);
	return `${url.protocol}//ambion:${encodeURIComponent(credential.token)}@${url.host}${url.pathname}`;
}

async function configure(env: WorkspaceEnv): Promise<void> {
	const ran = await env.exec(CONFIGURE, { timeout: 30 }, BACKGROUND_CONTEXT);
	if (!ran.ok || ran.value.exitCode !== 0) {
		throw new Error(
			'The workstation could not configure git. A workspace with a git backend needs git on the server.',
		);
	}
}

/** Write `content` to the credential file with mode `0600`, through a temporary name in the home. */
async function writeFile(env: WorkspaceEnv, content: string): Promise<void> {
	const temp = `~/.git-credentials.${randomName()}`;
	const written = await env.writeFile(temp, content, BACKGROUND_CONTEXT);
	if (!written.ok) throw written.error;
	const moved = await env.exec(
		`chmod 600 ${temp} && mv -f ${temp} ${FILE}`,
		{ timeout: 30 },
		BACKGROUND_CONTEXT,
	);
	if (!moved.ok || moved.value.exitCode !== 0) {
		await env.remove(temp, { force: true }, BACKGROUND_CONTEXT);
		throw new Error('The workstation could not write ~/.git-credentials.');
	}
}

/** Keep the credential file of `agent` current, and configure git on the first call of a session. */
export async function syncGitCredentials(
	env: WorkspaceEnv,
	agent: WorkspaceAgent,
	access: GitAccess,
	state: GitCredentialState,
): Promise<void> {
	state.held = renewed(state.held, await access.credentialsFor(agent), Date.now());
	const lines = [...state.held.values()].map((held) => lineOf(held.credential)).sort();
	const content = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
	const current = await env.readTextFile(FILE, BACKGROUND_CONTEXT);
	if (state.configured && current.ok && current.value === content) return;
	// A home that lost its credential file can have lost its git settings too.
	await configure(env);
	state.configured = true;
	await writeFile(env, content);
}
