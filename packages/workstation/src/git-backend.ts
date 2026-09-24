/**
 * `workstationGitBackend`: the repositories of a workspace in the home of
 * one account on the workstation, `<workspace>-git`, and `git` over SSH to
 * reach them (`docs/workstation-git.md`).
 *
 * The host drives the git account over its own SSH client: `list`, `get`,
 * `fork`, and template registration run as short scripts on the server,
 * and the host runs no git library. Each agent reaches the account with a
 * key that the backend issues. The line of each key in
 * `~/.ssh/authorized_keys.ambion` has the forced command
 * `~/.ambion/serve <agent>`, and `serve` decides each request.
 *
 * The access carries the `ssh` transport. A bash backend that carries it
 * calls `identityFor` at each `connect` and writes the key and the ssh
 * configuration into the agent's home.
 */

import type { GitAccess, GitBackend, GitEnv } from '@ambionframework/workspace';
import { assertAgent, type TemplateRegistration } from '@ambionframework/workspace/git';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';
import { checkedServer } from './backend.ts';
import { GitAccount } from './git-account.ts';
import { AgentKeys } from './git-keys.ts';
import { type Prepared, prepareAccount } from './git-prepare.ts';
import { Repositories } from './git-repositories.ts';
import type { WorkstationCredential } from './session.ts';

/** Seconds an agent key lives when the options name no `keyTtl`. */
const DEFAULT_KEY_TTL_SECONDS = 3600;

/** A folder in the account's home: one or more names, and no name that starts with a dot. */
const ROOT = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

/** A host name for the clone URLs. */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export interface WorkstationGitOptions {
	/** The address of the server that holds the git account. */
	readonly host: string;
	/** The server's SSH port. The default is 22. An agent reaches the same port on the loopback address. */
	readonly port?: number;
	/** The server's host key fingerprint, as `ssh-keygen -lf` prints it: `SHA256:` and then base64. */
	readonly hostKey: string;
	/** The username and the private key of the git account. */
	readonly account: WorkstationCredential;
	/** The folder of the repositories, in the account's home. The default is `repos`. */
	readonly root?: string;
	/** The host name in every clone URL. The default is `ambion-git`. */
	readonly alias?: string;
	/** The templates, by name. */
	readonly templates?: Readonly<Record<string, TemplateRegistration>>;
	/** Whole seconds an agent key lives. The default is 3600. */
	readonly keyTtl?: number;
	/** Seconds the client of the git account may stay unused. The default is 300. */
	readonly idleTimeout?: number;
}

/** One agent's key for the git account, and how its ssh reaches the account. */
export interface WorkstationGitIdentity {
	/** The host name in the clone URLs. The ssh configuration maps it to the server. */
	readonly alias: string;
	readonly port: number;
	readonly user: string;
	/** The server's public host key: the key type, a space, and the base64 key. */
	readonly hostKey: string;
	/** The agent's private key, in the OpenSSH format. */
	readonly privateKey: string;
	/** Milliseconds since the epoch, on the server's clock. `sshd` refuses the key from this time on. */
	readonly expiresAt: number;
}

/** What a workstation bash backend needs to reach `workstationGitBackend` as one agent. */
export interface WorkstationGitAccess extends GitAccess {
	readonly transport: 'ssh';
	/** The key of `agent`. Rejects for a reserved name. */
	identityFor(agent: WorkspaceAgent): Promise<WorkstationGitIdentity>;
}

interface Settings {
	readonly port: number;
	readonly idleMs: number;
	readonly root: string;
	readonly alias: string;
	readonly keyTtl: number;
}

function checked(options: WorkstationGitOptions): Settings {
	const who = 'workstationGitBackend';
	const { port, idleMs } = checkedServer(who, options);
	const root = options.root ?? 'repos';
	if (!ROOT.test(root)) {
		throw new Error(
			`${who}: root must be a folder in the home, with no name that starts with a dot.`,
		);
	}
	const alias = options.alias ?? 'ambion-git';
	if (!ALIAS.test(alias)) throw new Error(`${who}: alias must be a host name.`);
	const keyTtl = options.keyTtl ?? DEFAULT_KEY_TTL_SECONDS;
	if (!Number.isInteger(keyTtl) || keyTtl < 1) {
		throw new RangeError(`${who}: keyTtl must be a whole number of seconds, 1 or more.`);
	}
	return { port, idleMs, root, alias, keyTtl };
}

/** A git backend in the home of one account on the workstation. */
export function workstationGitBackend(
	options: WorkstationGitOptions,
): GitBackend & { readonly access: WorkstationGitAccess } {
	const { port, idleMs, root, alias, keyTtl } = checked(options);
	const account = new GitAccount(
		{ host: options.host, port, hostKey: options.hostKey },
		options.account,
		idleMs,
	);
	const repositories = new Repositories(account, root, alias);
	const keys = new AgentKeys(account, keyTtl);
	let preparing: Promise<Prepared> | undefined;
	let disposed = false;

	/** One preparation, shared by every caller. A failure lets the next caller try again. */
	const ready = (agent: WorkspaceAgent): Promise<Prepared> => {
		if (disposed) return Promise.reject(new Error('The git backend is disposed.'));
		assertAgent(agent);
		preparing ??= prepareAccount(account, root, options.templates ?? {}).catch((error: unknown) => {
			preparing = undefined;
			throw error;
		});
		return preparing;
	};

	const access: WorkstationGitAccess = {
		transport: 'ssh',
		identityFor: async (agent) => {
			const prepared = await ready(agent);
			const key = await keys.keyOf(agent.name, prepared.serve);
			return {
				alias,
				port,
				user: options.account.username,
				hostKey: prepared.hostKey,
				privateKey: key.privateKey,
				expiresAt: key.expiresAt,
			};
		},
	};

	return Object.freeze({
		access,
		server: `ssh://${alias}`,
		connect: async (agent: WorkspaceAgent): Promise<GitEnv> => {
			await ready(agent);
			return repositories.envFor(agent);
		},
		dispose: async () => {
			disposed = true;
			await account.close();
		},
	});
}
