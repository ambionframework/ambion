import { type ChildProcess, spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { WorkerClient, WorkerError } from './client.ts';
import { openHostClient } from './host-client.ts';
import type { Template } from './project.ts';

const DEFAULT_PORT = 8787;
const READY_TIMEOUT_MS = 30_000;
const DEFAULT_CREDENTIAL_KEY = 'ANTHROPIC_API_KEY';

class DevError extends Error {}

export interface DevArguments {
	directory: string;
	port: number;
}

interface DevParseState {
	directory: string | undefined;
	port: number;
}

function consumeDevArgument(args: readonly string[], index: number, state: DevParseState): number {
	const arg = args[index];
	if (arg?.startsWith('--port=')) {
		const value = arg.slice('--port='.length);
		if (!/^\d+$/.test(value)) throw new DevError("'--port' needs a number between 1 and 65535.");
		state.port = Number(value);
		return index;
	}
	if (arg === '--port') {
		const value = args[index + 1];
		if (value === undefined || !/^\d+$/.test(value))
			throw new DevError("'--port' needs a number between 1 and 65535.");
		state.port = Number(value);
		return index + 1;
	}
	if (arg?.startsWith('--')) throw new DevError(`Unknown dev option '${arg}'.`);
	if (state.directory !== undefined)
		throw new DevError('Use one project directory with `ambion dev`.');
	state.directory = arg;
	return index;
}

export function parseDevArguments(args: readonly string[], cwd = process.cwd()): DevArguments {
	const state: DevParseState = { directory: undefined, port: DEFAULT_PORT };
	for (let index = 0; index < args.length; index += 1) {
		index = consumeDevArgument(args, index, state);
	}
	if (state.port < 1 || state.port > 65535)
		throw new DevError("'--port' needs a number between 1 and 65535.");
	return { directory: resolve(cwd, state.directory ?? '.'), port: state.port };
}

function assertOpenTuiRuntime(): void {
	if (process.versions.bun !== undefined) return;
	const match = /^(\d+)\.(\d+)/.exec(process.versions.node);
	if (match === null) return;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (major > 26 || (major === 26 && minor >= 4)) return;
	throw new DevError(
		`ambion dev needs Node.js 26.4 or newer with --experimental-ffi (or Bun 1.3 or newer). Current Node.js is ${process.versions.node}.`,
	);
}

function assertInteractiveTerminal(): void {
	if (process.stdin.isTTY === true && process.stdout.isTTY === true) return;
	throw new DevError('ambion dev needs an interactive terminal (stdin and stdout must be TTYs).');
}

type Vars = Record<string, string | undefined>;

/** The file that holds a project's credentials: `.dev.vars` for Wrangler, `.env` for Node. */
const VARS_FILE: Record<Template, string> = { cloudflare: '.dev.vars', node: '.env' };
const EXAMPLE_HINT: Record<Template, string> = {
	cloudflare: '.dev.vars.example to .dev.vars',
	node: '.env.example to .env',
};
const NOT_A_PROJECT = (directory: string): DevError =>
	new DevError(`'${directory}' is not an Ambion project. Run \u001b[1mambion new\u001b[0m first.`);

async function readVars(directory: string, template: Template): Promise<Vars> {
	let text: string;
	try {
		text = await readFile(resolve(directory, VARS_FILE[template]), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw error;
	}
	try {
		return parseEnv(text);
	} catch {
		// A file that does not parse holds no usable credential.
		return {};
	}
}

function credentialKey(model: string | undefined): string {
	const provider = (model ?? 'anthropic/claude-sonnet-5')
		.split('/')[0]
		?.replace(/[^a-z0-9]/gi, '_')
		.toUpperCase();
	return provider === undefined || provider === '' ? DEFAULT_CREDENTIAL_KEY : `${provider}_API_KEY`;
}

/** Fail at start when the model has no credential. A room without one never answers. */
function requireCredential(vars: Vars, template: Template): void {
	const key = credentialKey(vars.AMBION_MODEL);
	if (vars[key]) return;
	throw new DevError(`No ${key} found. Copy ${EXAMPLE_HINT[template]} and set ${key}.`);
}

/** Read the kind of project: the `ambion.template` marker, else the Wrangler file. */
export async function detectTemplate(directory: string): Promise<Template> {
	let manifest: { ambion?: { template?: unknown } };
	try {
		manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
	} catch {
		throw NOT_A_PROJECT(directory);
	}
	const marker = manifest.ambion?.template;
	if (marker === 'node' || marker === 'cloudflare') return marker;
	try {
		await access(resolve(directory, 'wrangler.jsonc'));
		return 'cloudflare';
	} catch {
		throw NOT_A_PROJECT(directory);
	}
}

function appendLines(target: string[], chunk: Buffer | string): void {
	const lines = String(chunk)
		.split(/\r?\n/)
		.filter((line) => line.trim() !== '');
	for (const line of lines) {
		target.push(formatWorkerLine(line));
		if (target.length > 80) target.shift();
	}
}

function formatWorkerLine(line: string): string {
	let value: unknown;
	try {
		// Wrangler prefixes console output (for example, `[wrangler:log] `),
		// while the generated template writes the event itself as JSON.
		const jsonStart = line.indexOf('{');
		value = JSON.parse(jsonStart < 0 ? line : line.slice(jsonStart));
	} catch {
		return line;
	}
	if (typeof value !== 'object' || value === null) return line;
	if (!('ambion' in value) || value.ambion !== 'seat' || !('event' in value)) return line;
	if (value.event !== 'error' || !('error' in value) || typeof value.error !== 'string')
		return line;
	const seat = 'seat' in value && typeof value.seat === 'string' ? value.seat : 'seat';
	const error = conciseSeatError(value.error);
	return `[${seat}] error: ${error}`;
}

function conciseSeatError(error: string): string {
	const status = /^(\d{3})\s+/.exec(error);
	const payload = status === null ? error : error.slice(status[0].length);
	try {
		const detail = providerErrorDetail(JSON.parse(payload));
		if (detail !== undefined) return status === null ? detail : `${status[1]} ${detail}`;
	} catch {
		// Keep the original provider text when it is not JSON.
	}
	return error.replace(/\b(?:sk|key|api)[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]');
}

function providerErrorDetail(value: unknown): string | undefined {
	const outer = recordOf(value);
	const detail = recordOf(outer?.error);
	if (detail === undefined) return undefined;
	const type = typeof detail.type === 'string' ? detail.type : undefined;
	const message = typeof detail.message === 'string' ? detail.message : undefined;
	return (
		[type, message].filter((part): part is string => part !== undefined).join(': ') || undefined
	);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function startupMessage(error: unknown, logs: readonly string[], port: number): DevError {
	const details = logs.filter((line) =>
		/address already in use|EADDRINUSE|error|failed/i.test(line),
	);
	if (details.length > 0) {
		return new DevError(`Could not start Wrangler on 127.0.0.1:${port}: ${details.at(-1)}`);
	}
	return new DevError(
		error instanceof Error
			? `Could not start Wrangler on 127.0.0.1:${port}: ${error.message}`
			: `Could not start Wrangler on 127.0.0.1:${port}.`,
	);
}

function waitForExit(
	child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	return new Promise((resolveExit) => {
		child.once('exit', (code, signal) => resolveExit({ code, signal }));
	});
}

async function assertPortFree(port: number): Promise<void> {
	await new Promise<void>((resolvePort, rejectPort) => {
		const socket = createConnection({ host: '127.0.0.1', port });
		const finish = (error?: Error) => {
			socket.destroy();
			if (error === undefined) resolvePort();
			else rejectPort(error);
		};
		socket.once('connect', () => finish(new DevError(`Port ${port} is already in use.`)));
		socket.once('error', (error: NodeJS.ErrnoException) => {
			if (error.code === 'ECONNREFUSED') finish();
			else finish(new DevError(`Cannot check port ${port}: ${error.message}`));
		});
	});
}

async function waitForReady(
	child: ChildProcess,
	client: WorkerClient,
	logs: readonly string[],
	port: number,
	signal?: AbortSignal,
): Promise<void> {
	let spawnError: Error | undefined;
	child.once('error', (error) => {
		spawnError = error;
	});
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new DevError('Development server startup was interrupted.');
		if (spawnError !== undefined) throw startupMessage(spawnError, logs, port);
		if (child.exitCode !== null || child.signalCode !== null)
			throw startupMessage(undefined, logs, port);
		try {
			await client.health();
			return;
		} catch {
			await new Promise((resolveWaiting) => setTimeout(resolveWaiting, 150));
		}
	}
	throw startupMessage(new Error('readiness check timed out'), logs, port);
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const kill = (signal: NodeJS.Signals) => {
		try {
			if (process.platform === 'win32' || child.pid === undefined) child.kill(signal);
			else process.kill(-child.pid, signal);
		} catch {
			child.kill(signal);
		}
	};
	kill('SIGTERM');
	let timeout: NodeJS.Timeout | undefined;
	await Promise.race([
		waitForExit(child),
		new Promise((resolveStop) => {
			timeout = setTimeout(resolveStop, 3_000);
		}),
	]);
	if (timeout !== undefined) clearTimeout(timeout);
	if (child.exitCode === null && child.signalCode === null) kill('SIGKILL');
}

function interruptOn(controller: AbortController, extra?: () => void): () => void {
	const onInterrupt = () => {
		controller.abort();
		extra?.();
	};
	process.once('SIGINT', onInterrupt);
	process.once('SIGTERM', onInterrupt);
	return () => {
		process.removeListener('SIGINT', onInterrupt);
		process.removeListener('SIGTERM', onInterrupt);
	};
}

/** Host the room of a Node project in this process and run its terminal. */
async function runNodeDev(directory: string, vars: Vars): Promise<void> {
	// The project reads its model and key from the environment at load. A value
	// the shell already set wins over the file.
	for (const [name, value] of Object.entries(vars)) {
		if (value !== undefined) process.env[name] ??= value;
	}
	requireCredential({ ...vars, ...process.env }, 'node');
	const logs: string[] = [];
	const controller = new AbortController();
	const stopInterrupts = interruptOn(controller);
	let client: Awaited<ReturnType<typeof openHostClient>> | undefined;
	try {
		client = await openHostClient(directory, (message) => appendLines(logs, message));
		const started = await client.start();
		await client.join();
		const { runTerminalRoom } = await import('./tui.ts');
		await runTerminalRoom({ client, roomName: started.started, logs, signal: controller.signal });
	} finally {
		stopInterrupts();
		await client?.close();
	}
}

/** Start Wrangler, connect the generated Worker, and run its terminal. */
async function runCloudflareDev(directory: string, port: number, vars: Vars): Promise<void> {
	requireCredential(vars, 'cloudflare');
	await assertPortFree(port);
	const logs: string[] = [];
	const child = spawn(
		'pnpm',
		['exec', 'wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port)],
		{ cwd: directory, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
	);
	const controller = new AbortController();
	child.once('error', (error) => {
		appendLines(logs, error.message);
	});
	let childStop: Promise<void> | undefined;
	const stopInterrupts = interruptOn(controller, () => {
		childStop ??= stopChild(child);
	});
	child.stdout?.on('data', (chunk: Buffer | string) => appendLines(logs, chunk));
	child.stderr?.on('data', (chunk: Buffer | string) => appendLines(logs, chunk));
	try {
		const client = new WorkerClient(`http://127.0.0.1:${port}`);
		await waitForReady(child, client, logs, port, controller.signal);
		const started = await client.start();
		await client.join();
		const { runTerminalRoom } = await import('./tui.ts');
		await runTerminalRoom({ client, roomName: started.started, logs, signal: controller.signal });
	} catch (error) {
		if (error instanceof WorkerError && error.status === 0)
			throw new DevError(`The local Worker stopped responding: ${error.message}`);
		if (error instanceof DevError) throw error;
		throw startupMessage(error, logs, port);
	} finally {
		stopInterrupts();
		childStop ??= stopChild(child);
		await childStop;
	}
}

/** Run the terminal room of a generated project, on Wrangler or in this process. */
export async function runDev(args: readonly string[]): Promise<void> {
	assertOpenTuiRuntime();
	assertInteractiveTerminal();
	const parsed = parseDevArguments(args);
	const template = await detectTemplate(parsed.directory);
	const vars = await readVars(parsed.directory, template);
	if (template === 'node') await runNodeDev(parsed.directory, vars);
	else await runCloudflareDev(parsed.directory, parsed.port, vars);
}
