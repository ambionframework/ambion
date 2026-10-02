import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The login file that the seat links: `auth.json` in the `CODEX_HOME` of the host, else in `~/.codex`. */
export function hostLogin(env: Readonly<Record<string, string | undefined>> = process.env): string {
	return join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'auth.json');
}

/** Fail at startup when the host has no Codex login. The seat runs on that login and uses no key. */
export async function requireLogin(
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
	const file = hostLogin(env);
	try {
		await access(file);
	} catch {
		throw new Error(`No Codex login at ${file}. Run 'codex login', then start Camera Chat again.`);
	}
}
