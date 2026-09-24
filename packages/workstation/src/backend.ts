/**
 * `workstationBackend`: a `BashBackend` over SSH to one remote server, with
 * one Unix account for each agent (`docs/workstation.md`).
 *
 * The resource owner calls `connect()` and `cleanup()` once for each
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
 * The workstation carries no git transport. `connect` ignores the git
 * access that a git backend gives.
 */

import type { BashBackend, WorkspaceEnv, WorkspaceLayout } from '@ambionframework/workspace';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';
import { Session, type WorkstationCredential } from './session.ts';
import { SshEnv } from './ssh-env.ts';

/** How long an unused session stays open when the options name no `idleTimeout`. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;
/** The largest timeout a Node timer holds, in seconds. */
const MAX_TIMEOUT_SECONDS = 2_147_483;

export interface WorkstationOptions {
	/** The server's address. */
	readonly host: string;
	/** The server's SSH port. The default is 22. */
	readonly port?: number;
	/** The server's host key fingerprint, as `ssh-keygen -lf` prints it: `SHA256:` and then base64. */
	readonly hostKey: string;
	/** Where the audit log and the room mirrors live on the server. */
	readonly layout: WorkspaceLayout;
	/** Seconds a session may stay unused before the backend closes it. The default is 300. */
	readonly idleTimeout?: number;
	/** The account and the key of one agent, and of the workspace's host identity. */
	credentialFor(agent: WorkspaceAgent): WorkstationCredential | Promise<WorkstationCredential>;
}

/** The facts that hold on every workstation. The application names the commands its server installs. */
const GUIDANCE = [
	'Your workspace is a real server. You log in to it as your own Unix account, and your',
	'home is your working directory. Other agents have accounts of their own, and the',
	"server's permissions keep your home apart from theirs. bash is a real shell with open",
	'network access, and the commands you can run are the ones the server installs.',
].join('\n');

/** One agent's session, and the idle timer that closes it. */
interface Entry {
	readonly session: Promise<Session>;
	timer: NodeJS.Timeout | undefined;
	/** The envs over this session that are not yet cleaned up. A background process holds one. */
	open: number;
}

function checked(options: WorkstationOptions): { port: number; idleMs: number } {
	if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(options.hostKey)) {
		throw new Error(
			'workstationBackend: hostKey must be a SHA256 fingerprint, as `ssh-keygen -lf` prints it.',
		);
	}
	const port = options.port ?? 22;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new RangeError('workstationBackend: port must be an integer from 1 to 65535.');
	}
	const idle = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
	if (!(idle > 0 && idle <= MAX_TIMEOUT_SECONDS)) {
		throw new RangeError(
			`workstationBackend: idleTimeout must be more than 0 and at most ${MAX_TIMEOUT_SECONDS} seconds.`,
		);
	}
	return { port, idleMs: idle * 1000 };
}

/** A `BashBackend` over SSH to one server, with one account for each agent. */
export function workstationBackend(options: WorkstationOptions): BashBackend {
	const { port, idleMs } = checked(options);
	const address = { host: options.host, port, hostKey: options.hostKey };
	const entries = new Map<string, Entry>();

	const forget = (name: string, entry: Entry) => {
		clearTimeout(entry.timer);
		if (entries.get(name) === entry) entries.delete(name);
	};

	const open = (agent: WorkspaceAgent, signal: AbortSignal | undefined): Entry => {
		const entry: Entry = {
			session: (async () => Session.connect(address, await options.credentialFor(agent), signal))(),
			timer: undefined,
			open: 0,
		};
		entries.set(agent.name, entry);
		entry.session.then(
			(session) => session.whenEnded(() => forget(agent.name, entry)),
			() => forget(agent.name, entry),
		);
		return entry;
	};

	/** Close the session once no env is open over it for `idleMs`. */
	const idle = (name: string, entry: Entry, session: Session) => {
		entry.open -= 1;
		if (entry.open > 0) return;
		clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			forget(name, entry);
			session.close();
		}, idleMs);
		entry.timer.unref();
	};

	return {
		layout: options.layout,
		guidance: GUIDANCE,
		async connect(agent: WorkspaceAgent, signal?: AbortSignal): Promise<WorkspaceEnv> {
			const current = entries.get(agent.name);
			const entry = current ?? open(agent, signal);
			const session = await entry.session;
			if (session.closed) {
				forget(agent.name, entry);
				return this.connect(agent, signal);
			}
			clearTimeout(entry.timer);
			entry.open += 1;
			return new SshEnv(session, () => idle(agent.name, entry, session));
		},
		async dispose(): Promise<void> {
			const all = [...entries.values()];
			entries.clear();
			for (const entry of all) clearTimeout(entry.timer);
			const sessions = await Promise.allSettled(all.map((entry) => entry.session));
			for (const settled of sessions) if (settled.status === 'fulfilled') settled.value.close();
		},
	};
}
