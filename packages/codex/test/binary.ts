/**
 * The real `codex` binary on a scripted model. `codexOn` gives the
 * execution a Codex home that routes the model provider to a scripted
 * Responses endpoint. The environment of the binary holds a host home with
 * traps: a config that spawns a server and reroutes the provider, an
 * instructions file, and a skill under `.agents/skills`. A seat that reads
 * the host home shows it.
 */

import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Execution } from '@ambionframework/ambion';
import { codexExecution } from '../src/index.ts';
import type { CodexExecutionOptions } from '../src/options.ts';
import {
	type OnRequest,
	type Reply,
	type ScriptedResponses,
	scriptedResponses,
} from './responses.ts';

/** The variable that Codex requires for the provider. Its value is a dummy. */
export const DUMMY_KEY_VAR = 'AMBION_SCRIPTED_KEY';

/** The model of every seat on the scripted endpoint. The catalog of the binary lists it. */
export const MODEL = 'gpt-5.6-luna';

/** The bundled binary of this platform, or nothing when the platform package is missing. */
function bundledBinary(): string | undefined {
	try {
		const codex = createRequire(import.meta.resolve('@openai/codex/package.json'));
		const platform = process.platform === 'android' ? 'linux' : process.platform;
		const root = join(
			dirname(codex.resolve(`@openai/codex-${platform}-${process.arch}/package.json`)),
			'vendor',
		);
		const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
		return readdirSync(root)
			.flatMap((target) => [join(root, target, 'bin', name), join(root, target, 'codex', name)])
			.find((path) => existsSync(path));
	} catch {
		return undefined;
	}
}

/** Whether this platform has a bundled binary. A suite of the binary skips when it has none. */
export const hasBinary = bundledBinary() !== undefined;

/** The config of a Codex home that sends every model request to `url`. */
export function homeConfig(url: string, signIn = false, extra = ''): string {
	return [
		'model_provider = "scripted"',
		'',
		'[model_providers.scripted]',
		'name = "scripted"',
		`base_url = "${url}"`,
		'wire_api = "responses"',
		signIn ? 'requires_openai_auth = true' : `env_key = "${DUMMY_KEY_VAR}"`,
		'',
		extra,
	].join('\n');
}

/** A text no seat may read. The instructions file of the host holds it. */
export const HOST_MARKER = 'HOST-INSTRUCTIONS-MARKER-7f3a91';

/** A text no seat may read. The description of the skill of the host holds it. */
export const SKILL_MARKER = 'HOST-SKILL-MARKER-4c2d08';

/** The skill of the host user, in the form Codex discovers under `$HOME/.agents/skills`. */
const HOST_SKILL = `---\nname: host-trap\ndescription: ${SKILL_MARKER}\n---\n\nUse this skill never.\n`;

/** The config of the host user. Each line would change a seat that read it. */
function hostConfig(spawned: string): string {
	const spawn = `require('node:fs').writeFileSync(${JSON.stringify(spawned)}, 'spawned')`;
	return [
		'model_provider = "dead"',
		'',
		'[model_providers.dead]',
		'name = "dead"',
		'base_url = "http://127.0.0.1:1/v1"',
		'wire_api = "responses"',
		`env_key = "${DUMMY_KEY_VAR}"`,
		'',
		'[mcp_servers.leak]',
		`command = ${JSON.stringify(process.execPath)}`,
		`args = ${JSON.stringify(['-e', spawn])}`,
		'',
	].join('\n');
}

/** A proxy that records and refuses every connection. The binary reaches the network only through it. */
async function refusingProxy(): Promise<{ seen: string[]; url: string; close(): Promise<void> }> {
	const seen: string[] = [];
	const server = createServer((request, response) => {
		seen.push(`${request.method} ${request.url}`);
		response.writeHead(403).end();
	});
	server.on('connect', (request, socket) => {
		seen.push(`CONNECT ${request.url}`);
		// A client that dies mid-CONNECT resets the socket. The refusal stands either way.
		socket.on('error', () => undefined);
		socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		seen,
		url: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** The text of an `auth.json` for a sign-in with the API key `key`. */
export function apiKeyLogin(key: string): string {
	return JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key });
}

/** What a run of the binary needs besides the script. */
export interface CodexOnOptions {
	/** The runtime of the execution. It overrides the defaults: `home`, `login`, and `env`. */
	readonly runtime?: CodexExecutionOptions;
	/** The text of the login file of the host user, written as `.codex/auth.json` in the host home. */
	readonly hostLogin?: string;
	/** Whether the provider takes the sign-in of the home and not the dummy key. */
	readonly signIn?: boolean;
	/** The value of `CODEX_API_KEY` in the environment of the binary. */
	readonly apiKey?: string;
	/** More lines for the `config.toml` of the home. */
	readonly config?: string;
	/** A line that the binary writes to its standard error before it starts. */
	readonly stderrLine?: string;
}

/** A real binary on a script: the execution to give a room, the endpoint, and the cleanup. */
export interface CodexOnScript {
	readonly execution: Execution;
	readonly responses: ScriptedResponses;
	/** The Codex home of the seats. */
	readonly home: string;
	/** The home of the host user. Its `.codex` holds the traps. */
	readonly hostHome: string;
	/** The executable the seats run, when the script names a wrapper. */
	readonly codexPath?: string;
	/** The environment of the binary. A host in another process builds its execution from it. */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Whether the server in the config of the host started. */
	readonly leaked: () => boolean;
	/** The connections that the binary tried outside the loopback interface. */
	readonly outbound: readonly string[];
	close(): Promise<void>;
}

/** A `codex` executable that writes `line` to its standard error and then runs the bundled binary. */
function noisyBinary(dir: string, line: string): string {
	const path = join(dir, 'codex');
	writeFileSync(path, `#!/bin/sh\necho '${line}' >&2\nexec '${bundledBinary()}' "$@"\n`);
	chmodSync(path, 0o755);
	return path;
}

/**
 * Run the real binary against the script. The environment holds `PATH`, the
 * host home as `HOME` and `CODEX_HOME`, a proxy that refuses every outbound connection, and
 * the dummy key. The Codex home of the seats holds the scripted config.
 */
export async function codexOn(
	script: readonly Reply[],
	onRequest?: OnRequest,
	options: CodexOnOptions = {},
): Promise<CodexOnScript> {
	const responses = await scriptedResponses(script, onRequest);
	const proxy = await refusingProxy();
	const dir = mkdtempSync(join(tmpdir(), 'ambion-codex-binary-'));
	const hostHome = join(dir, 'host');
	const spawned = join(dir, 'leak-spawned');
	mkdirSync(join(hostHome, '.codex'), { recursive: true });
	writeFileSync(join(hostHome, '.codex', 'config.toml'), hostConfig(spawned));
	writeFileSync(join(hostHome, '.codex', 'AGENTS.md'), `${HOST_MARKER}\n`);
	mkdirSync(join(hostHome, '.agents', 'skills', 'host-trap'), { recursive: true });
	writeFileSync(join(hostHome, '.agents', 'skills', 'host-trap', 'SKILL.md'), HOST_SKILL);
	if (options.hostLogin !== undefined) {
		writeFileSync(join(hostHome, '.codex', 'auth.json'), options.hostLogin);
	}
	const home = options.runtime?.home ?? join(dir, 'seats');
	mkdirSync(home, { recursive: true });
	writeFileSync(
		join(home, 'config.toml'),
		homeConfig(responses.url, options.signIn, options.config),
	);
	const env = {
		PATH: process.env.PATH,
		HOME: hostHome,
		// The host names its Codex home. The binary never gets this value.
		CODEX_HOME: join(hostHome, '.codex'),
		[DUMMY_KEY_VAR]: 'dummy-key-for-the-scripted-endpoint',
		...(options.apiKey === undefined ? {} : { CODEX_API_KEY: options.apiKey }),
		HTTP_PROXY: proxy.url,
		HTTPS_PROXY: proxy.url,
		ALL_PROXY: proxy.url,
		NO_PROXY: '127.0.0.1,localhost',
	};
	const codexPath =
		options.stderrLine === undefined ? undefined : noisyBinary(dir, options.stderrLine);
	return {
		// With a host login, the default `login` links it. Otherwise no seat links a login.
		execution: codexExecution({
			env,
			...(options.hostLogin === undefined ? { login: false } : {}),
			...(codexPath === undefined ? {} : { codexPath }),
			...options.runtime,
			home,
		}),
		...(codexPath === undefined ? {} : { codexPath }),
		responses,
		home,
		hostHome,
		env,
		leaked: () => existsSync(spawned),
		outbound: proxy.seen,
		close: async () => {
			await responses.close();
			await proxy.close();
			// The close of the app-server sends a signal and returns. The binary can still write to
			// its home as it exits, so wait for it, stop one that remains, and then remove the files.
			if (seesProcesses) await gone(home);
			rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		},
	};
}

/** Whether `runningWith` can see the environment of a process. Linux reads /proc. macOS reads `ps -E`. */
export const seesProcesses = process.platform === 'linux' || process.platform === 'darwin';

/** The pids on Linux whose environment holds `entry`. */
function procsWith(entry: string): number[] {
	return readdirSync('/proc')
		.filter((name) => /^\d+$/.test(name))
		.filter((pid) => {
			try {
				return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(entry);
			} catch {
				return false;
			}
		})
		.map(Number);
}

/** The pids on macOS whose `ps -E` line holds `entry` as a whole word. A binary under SIP shows no environment. */
function psWith(entry: string): number[] {
	const lines = execFileSync('ps', ['-Eww', '-x', '-o', 'pid=,command='], { encoding: 'utf8' });
	return lines
		.split('\n')
		.filter((line) => line.split(/\s+/).includes(entry))
		.map((line) => Number(line.trim().split(/\s+/)[0]));
}

/**
 * The processes that run with `home` as their `CODEX_HOME`: the app-server of a seat. It returns
 * nothing on a platform that `seesProcesses` excludes.
 */
export function runningWith(home: string): number[] {
	const entry = `CODEX_HOME=${home}`;
	if (process.platform === 'linux') return procsWith(entry);
	if (process.platform === 'darwin') return psWith(entry);
	return [];
}

/** Wait until no process runs with `home`. A process that remains after the deadline is killed. */
async function gone(home: string, deadlineMs = 5_000): Promise<void> {
	const end = Date.now() + deadlineMs;
	while (runningWith(home).length > 0 && Date.now() < end) await sleep(50);
	for (const pid of runningWith(home)) kill(pid);
	while (runningWith(home).length > 0 && Date.now() < end + 5_000) await sleep(50);
}

/** Kill a process, and ignore one that is gone already. */
export function kill(pid: number): void {
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		// The process is gone already.
	}
}

/** An endpoint hook that holds the request `index` open until the client goes away. */
export function holding(index: number) {
	const open = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const onRequest: OnRequest = async (at, response) => {
		if (at !== index) return;
		response.on('close', () => closed.resolve());
		open.resolve();
		await closed.promise;
	};
	return { onRequest, open: open.promise, closed: closed.promise };
}
