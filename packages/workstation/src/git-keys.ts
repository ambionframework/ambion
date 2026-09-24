/**
 * The git key of each agent: an Ed25519 pair that the backend issues, and
 * one line for it in `~/.ssh/authorized_keys.ambion` of the git account.
 *
 * The keys live in the backend's memory. An agent keeps its key until the
 * smaller of 10 minutes and half of its life is left, and then it gets a
 * new one. A restart of the host issues new keys.
 *
 * Each write of the key file is one script under `flock` on the server, so
 * the writes of every host process take turns and no line is lost. The
 * script reads the server's clock, renders the expiry in the server's time
 * zone, adds the new line, drops each line whose expiry has passed, and
 * renames a temporary file over the old one. An old line stays until its
 * expiry, so a command in flight with the old key finishes.
 */

import ssh2 from 'ssh2';
import { type GitAccount, tagged } from './git-account.ts';

const { utils } = ssh2;

/** A key pair in the OpenSSH format. */
export interface KeyPair {
	readonly private: string;
	readonly public: string;
}

/** How many pairs the generator tries before it gives up. One pair in 256 fails. */
const MAX_ATTEMPTS = 64;

/** The longest margin of a key: 10 minutes. */
const MARGIN_MS = 10 * 60 * 1000;

function readable(key: string): boolean {
	return !(utils.parseKey(key) instanceof Error);
}

/**
 * An Ed25519 pair whose two halves `ssh2` reads back. About once in 256
 * pairs, the generator of `ssh2` drops a leading zero byte of the public
 * key, and `utils.parseKey` refuses both halves. The function then
 * generates again.
 */
export function ed25519Pair(
	generate: () => KeyPair = () => utils.generateKeyPairSync('ed25519'),
): KeyPair {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		const pair = generate();
		if (readable(pair.private) && readable(pair.public)) return pair;
	}
	throw new Error(`ssh2 gave ${MAX_ATTEMPTS} Ed25519 key pairs that it cannot read.`);
}

/** The public half as `authorized_keys` takes it: the key type, a space, and the base64 key. */
function publicText(pair: KeyPair): string {
	const [type, key] = pair.public.split(' ');
	if (type === undefined || key === undefined)
		throw new Error('ssh2 gave a public key with no type.');
	return `${type} ${key}`;
}

/**
 * The script that adds the line of one key. `expiry-time` names the last
 * whole second that `sshd` accepts the key, so `sshd` refuses it from
 * `AMBION_TTL` whole seconds after the current second on. The script
 * prints the server's time in milliseconds.
 */
const KEY_SCRIPT = [
	'set -euo pipefail',
	'umask 077',
	'exec 9>>"$HOME/.ambion/keys.lock"',
	'flock 9',
	'file="$HOME/.ssh/authorized_keys.ambion"',
	'ms=$(date +%s%3N)',
	'now=$((ms / 1000))',
	'current=$(date -d "@$now" +%Y%m%d%H%M%S)',
	'expiry=$(date -d "@$((now + AMBION_TTL - 1))" +%Y%m%d%H%M%S)',
	'next=$(mktemp "$HOME/.ssh/.authorized_keys.ambion.XXXXXX")',
	`trap 'rm -f "$next"' EXIT`,
	`re='expiry-time="([0-9]{14})"'`,
	'{',
	'  if [ -f "$file" ]; then',
	'    while IFS= read -r line || [ -n "$line" ]; do',
	`      if [[ "$line" =~ $re ]] && [[ "\${BASH_REMATCH[1]}" < "$current" ]]; then continue; fi`,
	String.raw`      printf '%s\n' "$line"`,
	'    done <"$file"',
	'  fi',
	String.raw`  printf 'restrict,from="127.0.0.1,::1",expiry-time="%s",command="%s %s" %s ambion:%s\n' "$expiry" "$AMBION_SERVE" "$AMBION_AGENT" "$AMBION_KEY" "$AMBION_AGENT"`,
	'} >"$next"',
	'chmod 600 "$next"',
	'mv -f "$next" "$file"',
	String.raw`printf 'AMBION_NOW %s\n' "$ms"`,
	'',
].join('\n');

/** One agent's key, and when `sshd` refuses it. */
export interface HeldKey {
	readonly privateKey: string;
	/** Milliseconds since the epoch, on the server's clock. */
	readonly expiresAt: number;
	/** The server's clock minus this process's clock, in milliseconds, when the key was issued. */
	readonly skew: number;
}

/** The keys of the agents of one backend. */
export class AgentKeys {
	private readonly held = new Map<string, HeldKey>();
	/** The issues in flight, by agent. A second caller for one agent waits for the first. */
	private readonly issuing = new Map<string, Promise<HeldKey>>();

	constructor(
		private readonly account: GitAccount,
		/** Seconds a key lives. */
		private readonly ttl: number,
	) {}

	/** The key of `agent`, and a new one when the backend holds none or the key is inside its margin. */
	keyOf(agent: string, serve: string): Promise<HeldKey> {
		const held = this.held.get(agent);
		if (held !== undefined && !this.inMargin(held)) return Promise.resolve(held);
		const pending = this.issuing.get(agent);
		if (pending !== undefined) return pending;
		const issued = this.issue(agent, serve).finally(() => this.issuing.delete(agent));
		this.issuing.set(agent, issued);
		return issued;
	}

	private inMargin(held: HeldKey): boolean {
		const margin = Math.min(MARGIN_MS, (this.ttl * 1000) / 2);
		return held.expiresAt - (Date.now() + held.skew) <= margin;
	}

	/** Generate a pair, and write its line before the key reaches the agent. */
	private async issue(agent: string, serve: string): Promise<HeldKey> {
		const pair = ed25519Pair();
		const before = Date.now();
		const output = await this.account.run(KEY_SCRIPT, {
			AMBION_AGENT: agent,
			AMBION_KEY: publicText(pair),
			AMBION_TTL: String(this.ttl),
			AMBION_SERVE: serve,
		});
		const midpoint = (before + Date.now()) / 2;
		const now = Number(tagged(output, 'AMBION_NOW')[0]);
		if (!Number.isInteger(now)) throw new Error('The git account gave no time for a new key.');
		const held = {
			privateKey: pair.private,
			expiresAt: (Math.floor(now / 1000) + this.ttl) * 1000,
			skew: now - midpoint,
		};
		this.held.set(agent, held);
		return held;
	}
}
