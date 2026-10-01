/**
 * `workstationBackend`: a `BashBackend` over SSH to one remote server, with
 * one Unix account for each agent (`docs/workstation.md`).
 *
 * The resource calls `connect()` and `cleanup()` once for each
 * operation, and a handshake on each would add network round trips to every
 * tool call. The backend keeps one session for each agent: `connect()`
 * builds it on the first call, and later calls reuse it. A background process
 * holds an env of its own over the same session. A session with no open
 * env for `idleTimeout` seconds closes, and a session that errs closes too.
 * The next `connect()` for that agent builds a new one.
 *
 * The host owns every credential. The backend awaits `credentialFor` each
 * time it builds a session, and it stores, issues, and rotates no
 * credential.
 *
 * The `git` option takes a `workstationGitBackend`. With it, each `connect`
 * asks `identityFor` for the agent's key, and writes the key and the ssh
 * configuration into the agent's `~/.ssh` (`git-agent.ts`). A failure of
 * either step fails the `connect`.
 */

import {
	type BashBackend,
	MAX_TIMER_SECONDS,
	type WorkspaceEndpoint,
	type WorkspaceEndpoints,
	type WorkspaceEnv,
	type WorkspaceLayout,
} from '@ambionframework/workspace';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';
import { writeGitFiles } from './git-agent.ts';
import type { WorkstationGitBackend } from './git-backend.ts';
import { forwardWorkspaceEndpoint } from './ports.ts';
import { Session, type WorkstationCredential } from './session.ts';
import { SshEnv } from './ssh-env.ts';

/** How long an unused session stays open when the options name no `idleTimeout`. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;

export interface WorkstationOptions {
	/** The server's address. */
	readonly server: string;
	/** The server's SSH port. The default is 22. */
	readonly port?: number;
	/** The server's host key fingerprint, as `ssh-keygen -lf` prints it: `SHA256:` and then base64. */
	readonly hostKey: string;
	/** Where the audit log and the room mirrors live on the server. */
	readonly layout: WorkspaceLayout;
	/** Seconds a session may stay unused before the backend closes it. The default is 300. */
	readonly idleTimeout?: number;
	/**
	 * The repositories that `git` in each agent's shell reaches. The
	 * workspace opens it under a resource of its own. Absent, the workspace has
	 * no `repos`, `clone` or `fork` tool.
	 */
	readonly git?: WorkstationGitBackend;
	/** The account and the key of one agent, and of the workspace's host identity. */
	credentialFor(agent: WorkspaceAgent): WorkstationCredential | Promise<WorkstationCredential>;
}

/** The facts that hold on every workstation. The application names the commands its server installs. */
const guidance = (host: string, loginPort: number) =>
	[
		'Your workspace is a real server. You log in to it as your own Unix account, and your',
		'home is your working directory. Other agents have accounts of their own, and the',
		"server's permissions keep your home apart from theirs. bash is a real shell with open",
		'network access, and the commands you can run are the ones the server installs.',
		`Your workstation hostname is ${host}. SSH login uses port ${loginPort}.`,
		'A forwarded service port targets remote 127.0.0.1. Its private HTTP URL uses a',
		'temporary loopback port on the Ambion host.',
	].join('\n');

/** One agent's session, and the idle timer that closes it. */
interface Entry {
	readonly session: Promise<Session>;
	readonly startup: AbortController;
	ready?: Session;
	timer: NodeJS.Timeout | undefined;
	/** Environments, pending acquisitions, and open endpoints that hold this session. */
	open: number;
}

/** The address and the idle timeout that both backends of the package take. */
interface ServerOptions {
	readonly server: string;
	readonly port?: number;
	readonly hostKey: string;
	readonly idleTimeout?: number;
}

/** The port and the idle timeout of `options`, after the checks. `who` names the backend in each error. */
export function checkedServer(
	who: string,
	options: ServerOptions,
): { port: number; idleMs: number } {
	if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(options.hostKey)) {
		throw new Error(
			`${who}: hostKey must be a SHA256 fingerprint, as \`ssh-keygen -lf\` prints it.`,
		);
	}
	const port = options.port ?? 22;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new RangeError(`${who}: port must be an integer from 1 to 65535.`);
	}
	const idle = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
	if (!(idle > 0 && idle <= MAX_TIMER_SECONDS)) {
		throw new RangeError(
			`${who}: idleTimeout must be more than 0 and at most ${MAX_TIMER_SECONDS} seconds.`,
		);
	}
	return { port, idleMs: idle * 1000 };
}

/** A `BashBackend` over SSH to one server, with one account for each agent. */
export function workstationBackend(options: WorkstationOptions): BashBackend {
	const { port, idleMs } = checkedServer('workstationBackend', options);
	const { git } = options;
	const address = { host: options.server, port, hostKey: options.hostKey };
	const entries = new Map<string, Entry>();
	const activeEndpoints = new Set<() => Promise<void>>();
	let disposed = false;

	const forget = (name: string, entry: Entry) => {
		clearTimeout(entry.timer);
		if (entries.get(name) === entry) entries.delete(name);
	};

	const open = (agent: WorkspaceAgent): Entry => {
		const startup = new AbortController();
		const entry: Entry = {
			startup,
			session: (async () => {
				const credential = await options.credentialFor(agent);
				if (startup.signal.aborted) throw startup.signal.reason;
				return Session.connect(address, credential, startup.signal);
			})(),
			timer: undefined,
			open: 0,
		};
		entries.set(agent.name, entry);
		entry.session.then(
			(session) => {
				entry.ready = session;
				session.whenEnded(() => forget(agent.name, entry));
				if (disposed || entry.open === 0) {
					forget(agent.name, entry);
					session.close();
				}
			},
			() => forget(agent.name, entry),
		);
		return entry;
	};

	/** Close the session once no env is open over it for `idleMs`. */
	const idle = (name: string, entry: Entry, session: Session) => {
		entry.open -= 1;
		if (entry.open > 0) return;
		clearTimeout(entry.timer);
		if (session.closed) {
			forget(name, entry);
			return;
		}
		if (disposed) {
			forget(name, entry);
			session.close();
			return;
		}
		entry.timer = setTimeout(() => {
			forget(name, entry);
			session.close();
		}, idleMs);
		entry.timer.unref();
	};

	/** Reserve a session reference while the caller awaits a pending SSH setup. */
	const acquireEntry = async (
		agent: WorkspaceAgent,
		entry: Entry,
		signal: AbortSignal | undefined,
	): Promise<{ session: Session; release(): void }> => {
		clearTimeout(entry.timer);
		entry.open += 1;
		const release = leaseRelease(agent.name, entry, idle, releasePending);
		const setupSignal =
			signal === undefined ? entry.startup.signal : AbortSignal.any([signal, entry.startup.signal]);
		let session: Session;
		try {
			session = await waitFor(entry.session, setupSignal);
		} catch (error) {
			release();
			throw error;
		}
		if (session.closed) {
			release();
			forget(agent.name, entry);
			return leaseFor(agent, signal);
		}
		return { session, release };
	};

	/** A lease over the agent's session, and a new session when the last one closed. */
	const leaseFor = async (
		agent: WorkspaceAgent,
		signal: AbortSignal | undefined,
	): Promise<{ session: Session; release(): void }> => {
		if (disposed) throw new Error('The workstation backend is disposed.');
		if (signal?.aborted) throw signal.reason ?? new Error('Connection aborted.');
		return acquireEntry(agent, entries.get(agent.name) ?? open(agent), signal);
	};

	const releasePending = (name: string, entry: Entry) => {
		if (entry.open > 0) entry.open -= 1;
		if (entry.open === 0) {
			if (entry.ready === undefined) {
				entry.startup.abort(new Error('Workstation session setup has no active owner.'));
			} else {
				entry.ready.close();
			}
			forget(name, entry);
		}
	};

	const envFor = async (
		agent: WorkspaceAgent,
		signal: AbortSignal | undefined,
	): Promise<SshEnv> => {
		const lease = await leaseFor(agent, signal);
		return new SshEnv(lease.session, lease.release);
	};

	const endpoints: WorkspaceEndpoints = {
		machine: options.server,
		async forward(agent, remotePort, signal): Promise<WorkspaceEndpoint> {
			if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
				throw new RangeError('The workstation service port must be an integer from 1 to 65535.');
			}
			const lease = await leaseFor(agent, signal);
			if (disposed) {
				lease.release();
				throw new Error('The workstation backend is disposed.');
			}
			return forwardWorkspaceEndpoint(lease.session, remotePort, signal, lease.release, (close) => {
				activeEndpoints.add(close);
				return () => activeEndpoints.delete(close);
			});
		},
	};

	return {
		layout: options.layout,
		guidance: guidance(options.server, port),
		endpoints,
		...(git === undefined ? {} : { git }),
		async connect(agent: WorkspaceAgent, signal?: AbortSignal): Promise<WorkspaceEnv> {
			const env = await envFor(agent, signal);
			if (git === undefined) return env;
			try {
				await writeGitFiles(env, await git.access.identityFor(agent), signal);
			} catch (error) {
				await env.cleanup();
				throw error;
			}
			return env;
		},
		async dispose(): Promise<void> {
			disposed = true;
			const all = [...entries.values()];
			entries.clear();
			for (const entry of all) {
				clearTimeout(entry.timer);
				entry.startup.abort(new Error('Workstation backend disposed.'));
			}
			await Promise.all([...activeEndpoints].map((close) => close()));
			for (const entry of all) {
				void entry.session.then(
					(session) => session.close(),
					() => undefined,
				);
			}
		},
	};
}

function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void work.catch(() => undefined);
		return Promise.reject(signal.reason ?? new Error('Operation aborted.'));
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error('Operation aborted.'));
		signal.addEventListener('abort', abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
	});
}

function once(fn: () => void): () => void {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		fn();
	};
}

function leaseRelease(
	name: string,
	entry: Entry,
	idle: (name: string, entry: Entry, session: Session) => void,
	releasePending: (name: string, entry: Entry) => void,
): () => void {
	return once(() => {
		const session = entry.ready;
		if (session === undefined) releasePending(name, entry);
		else idle(name, entry, session);
	});
}
