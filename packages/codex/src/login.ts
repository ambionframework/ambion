/**
 * The login with `CODEX_API_KEY`: the wait for `account/login/completed` and
 * the error of a failed login.
 */
import { PermanentError } from '@ambionframework/ambion/hosting';
import { RpcError } from './app-server.ts';

/** How long the login waits for `account/login/completed`, in milliseconds. */
const LOGIN_MS = 30_000;

/** A login that Codex completed with `success: false`. */
export class LoginRefused extends Error {}

/** A login that Codex never answered. The next pass tries again. */
class LoginSilent extends Error {}

/** What `account/login/completed` carries. */
export interface LoginResult {
	readonly success: boolean;
	readonly error?: string | null;
	readonly loginId?: string | null;
}

/** The wait for the `account/login/completed` of one login. */
export class LoginWait {
	private readonly done = Promise.withResolvers<LoginResult>();
	private readonly early: LoginResult[] = [];
	private readonly timer = setTimeout(
		() => this.done.reject(new LoginSilent('no answer in time')),
		LOGIN_MS,
	);
	/** The login id of the start answer. `null` when the answer has none. Absent until it arrives. */
	private id: string | null | undefined;

	constructor() {
		this.timer.unref();
	}

	/** A completion arrives. One that comes before the start answers waits for the login id. */
	completed(result: LoginResult): void {
		if (this.id === undefined) this.early.push(result);
		else if (this.matches(result)) this.done.resolve(result);
	}

	/** The completion of the login that the start answer names. */
	result(id: string | null): Promise<LoginResult> {
		this.id = id;
		const first = this.early.find((result) => this.matches(result));
		if (first !== undefined) this.done.resolve(first);
		return this.done.promise;
	}

	stop(): void {
		clearTimeout(this.timer);
	}

	private matches(result: LoginResult): boolean {
		return this.id === null || result.loginId === this.id;
	}
}

/**
 * The error of a failed login. A refusal is permanent. A login that gets no
 * answer is transient, so the next pass tries again. No message holds the key.
 */
export function loginError(error: unknown, apiKey: string): Error {
	if (error instanceof LoginSilent) {
		return new Error(`Codex gave no answer to the login with CODEX_API_KEY in ${LOGIN_MS} ms.`);
	}
	const cause =
		error instanceof RpcError || error instanceof LoginRefused ? error.message : 'the login failed';
	return new PermanentError(
		`Codex refused the login with CODEX_API_KEY: ${cause.replaceAll(apiKey, '[key]')}`,
	);
}
