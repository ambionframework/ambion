/**
 * The git account's client: one SSH session as `<workspace>-git`, and the
 * scripts that the git backend runs in it.
 *
 * Every operation of the git backend is a short `bash` script in the
 * account's home. `run` passes its values as variables of the script, so
 * no value reaches a command line that `ps` shows. The environment over
 * SSH runs the script in a process group of its own, and an abort kills
 * the group. The script prints each fact on a line of its own, with a tag
 * that starts with `AMBION_`, and `tagged` reads those lines. A login shell
 * can print other lines, and `tagged` skips them.
 *
 * The client stays open while an operation runs, and it closes after
 * `idleTimeout` with no operation. The next operation opens a new one.
 */

import {
	BACKGROUND_CONTEXT,
	type ShellOutputUpdate,
	withAbortSignal,
} from '@earendil-works/pi-agent-core';
import { type ServerAddress, Session, type WorkstationCredential } from './session.ts';
import { SshEnv } from './ssh-env.ts';

/** The longest that one script of the git account runs, in seconds. A fork of a large repository takes time. */
const SCRIPT_TIMEOUT_SECONDS = 600;

/** The values of a script, by the name of each variable. */
export type ScriptVariables = Readonly<Record<string, string>>;

/** The client of the git account, shared by every operation of one backend. */
export class GitAccount {
	private session: Promise<Session> | undefined;
	private timer: NodeJS.Timeout | undefined;
	private busy = 0;
	private closed = false;

	constructor(
		private readonly address: ServerAddress,
		private readonly credential: WorkstationCredential,
		private readonly idleMs: number,
	) {}

	/** A live session, and a new one when the last one ended. */
	private async live(): Promise<Session> {
		const pending = this.session ?? Session.connect(this.address, this.credential);
		this.session = pending;
		let session: Session;
		try {
			session = await pending;
		} catch (error) {
			if (this.session === pending) this.session = undefined;
			throw error;
		}
		if (!session.closed) return session;
		if (this.session === pending) this.session = undefined;
		return this.live();
	}

	/** Run `work` over an environment of the git account, and hand the session back after. */
	async use<T>(work: (env: SshEnv, session: Session) => Promise<T>): Promise<T> {
		if (this.closed) throw new Error('The git backend is disposed.');
		const session = await this.live();
		clearTimeout(this.timer);
		this.busy += 1;
		const env = new SshEnv(session, () => this.release(session));
		try {
			return await work(env, session);
		} finally {
			await env.cleanup();
		}
	}

	/** Close the session once no operation uses it for `idleMs`. */
	private release(session: Session): void {
		this.busy -= 1;
		if (this.busy > 0) return;
		clearTimeout(this.timer);
		// The next operation finds the session closed, and `live` opens a new one.
		this.timer = setTimeout(() => {
			if (this.busy === 0) session.close();
		}, this.idleMs);
		this.timer.unref();
	}

	/**
	 * Run `script` in `bash` in the account's home, with `variables`
	 * exported. Resolves with the output, and rejects with it when the
	 * script exits with a status other than 0.
	 */
	run(script: string, variables: ScriptVariables, signal?: AbortSignal): Promise<string> {
		return this.use((env) => runIn(env, script, variables, signal));
	}

	/** Close the client. Every later operation rejects. */
	async close(): Promise<void> {
		this.closed = true;
		clearTimeout(this.timer);
		const pending = this.session;
		this.session = undefined;
		if (pending === undefined) return;
		const session = await pending.catch(() => undefined);
		session?.close();
	}
}

/** Run `script` over `env`, and give its output. */
export async function runIn(
	env: SshEnv,
	script: string,
	variables: ScriptVariables,
	signal?: AbortSignal,
): Promise<string> {
	let text = '';
	const onUpdate = (update: ShellOutputUpdate) => {
		if (update.kind === 'replace') text = update.output.text;
	};
	const context =
		signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT);
	const ran = await env.exec(
		script,
		{ env: variables, timeout: SCRIPT_TIMEOUT_SECONDS, onUpdate },
		context,
	);
	if (!ran.ok) throw ran.error;
	if (ran.value.truncation.truncated) {
		throw new Error('The output of a script of the git account is too long.');
	}
	if (ran.value.exitCode !== 0) {
		throw new Error(
			`A script of the git account exited with ${ran.value.exitCode}: ${text.trim()}`,
		);
	}
	return text;
}

/** The value of each line of `output` that starts with `tag` and a space, in order. */
export function tagged(output: string, tag: string): string[] {
	const prefix = `${tag} `;
	return output
		.split('\n')
		.filter((line) => line.startsWith(prefix))
		.map((line) => line.slice(prefix.length));
}
