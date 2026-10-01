/**
 * The real `codex` binary on a scripted model. `codexOn` gives the
 * execution a Codex home that routes the model provider to a scripted
 * Responses endpoint. The environment of the binary holds a host home with
 * traps: a config that spawns a server and reroutes the provider, and an
 * instructions file. A seat that reads the host home shows it.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Execution } from '@ambionframework/ambion';
import { ROOM_SERVER } from '@ambionframework/ambion/hosting';
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
		const sdk = createRequire(import.meta.resolve('@openai/codex-sdk'));
		const codex = createRequire(sdk.resolve('@openai/codex/package.json'));
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
	/** More lines for the `config.toml` of the home. */
	readonly config?: string;
	/** Whether the room tools server names a command that does not exist, so it cannot start. */
	readonly brokenRoomServer?: boolean;
}

/** A real binary on a script: the execution to give a room, the endpoint, and the cleanup. */
export interface CodexOnScript {
	readonly execution: Execution;
	readonly responses: ScriptedResponses;
	/** The Codex home of the seats. */
	readonly home: string;
	/** The home of the host user. Its `.codex` holds the traps. */
	readonly hostHome: string;
	/** The environment of the binary. A host in another process builds its execution from it. */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Whether the server in the config of the host started. */
	readonly leaked: () => boolean;
	/** The connections that the binary tried outside the loopback interface. */
	readonly outbound: readonly string[];
	close(): Promise<void>;
}

/**
 * A `codex` executable that runs the bundled binary with a room tools server
 * that cannot start. The last `-c` flag wins, so it replaces the server table.
 */
function brokenServerBinary(dir: string): string {
	const path = join(dir, 'codex');
	const table = `mcp_servers.${ROOM_SERVER}={command="/nonexistent/node",args=[],required=true}`;
	writeFileSync(path, `#!/bin/sh\nexec '${bundledBinary()}' "$@" -c '${table}'\n`);
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
		HTTP_PROXY: proxy.url,
		HTTPS_PROXY: proxy.url,
		ALL_PROXY: proxy.url,
		NO_PROXY: '127.0.0.1,localhost',
	};
	return {
		// With a host login, the default `login` links it. Otherwise no seat links a login.
		execution: codexExecution({
			env,
			...(options.hostLogin === undefined ? { login: false } : {}),
			...(options.brokenRoomServer ? { codexPath: brokenServerBinary(dir) } : {}),
			...options.runtime,
			home,
		}),
		responses,
		home,
		hostHome,
		env,
		leaked: () => existsSync(spawned),
		outbound: proxy.seen,
		close: async () => {
			await responses.close();
			await proxy.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
