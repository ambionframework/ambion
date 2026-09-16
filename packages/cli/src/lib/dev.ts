import { type ChildProcess, spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { WorkerClient, WorkerError } from './client.ts';

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

function readEnvValue(text: string, key: string): string | undefined {
	try {
		return parseEnv(text)[key];
	} catch {
		return undefined;
	}
}

async function credentialKey(directory: string): Promise<string> {
	const path = resolve(directory, '.dev.vars');
	try {
		const text = await readFile(path, 'utf8');
		const model = readEnvValue(text, 'AMBION_MODEL') ?? 'anthropic/claude-sonnet-5';
		const provider = model
			.split('/')[0]
			?.replace(/[^a-z0-9]/gi, '_')
			.toUpperCase();
		return provider === undefined || provider === ''
			? DEFAULT_CREDENTIAL_KEY
			: `${provider}_API_KEY`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		return DEFAULT_CREDENTIAL_KEY;
	}
}

async function hasCredential(directory: string, key: string): Promise<boolean> {
	try {
		const text = await readFile(resolve(directory, '.dev.vars'), 'utf8');
		return Boolean(readEnvValue(text, key));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		return false;
	}
}

async function checkProject(directory: string): Promise<void> {
	try {
		await access(resolve(directory, 'wrangler.jsonc'));
		await access(resolve(directory, 'package.json'));
	} catch {
		throw new DevError(`'${directory}' is not an Ambion project. Run [1mambion new[0m first.`);
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

/** Start Wrangler, connect the generated room, and run its terminal interface. */
export async function runDev(args: readonly string[]): Promise<void> {
	assertOpenTuiRuntime();
	assertInteractiveTerminal();
	const parsed = parseDevArguments(args);
	await checkProject(parsed.directory);
	const requiredKey = await credentialKey(parsed.directory);
	if (!(await hasCredential(parsed.directory, requiredKey))) {
		throw new DevError(
			`No ${requiredKey} found. Copy .dev.vars.example to .dev.vars and set ${requiredKey}.`,
		);
	}
	await assertPortFree(parsed.port);
	const logs: string[] = [];
	const child = spawn(
		'pnpm',
		['exec', 'wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(parsed.port)],
		{ cwd: parsed.directory, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
	);
	const controller = new AbortController();
	child.once('error', (error) => {
		appendLines(logs, error.message);
	});
	let childStop: Promise<void> | undefined;
	const onInterrupt = () => {
		controller.abort();
		childStop ??= stopChild(child);
	};
	process.once('SIGINT', onInterrupt);
	process.once('SIGTERM', onInterrupt);
	child.stdout?.on('data', (chunk: Buffer | string) => appendLines(logs, chunk));
	child.stderr?.on('data', (chunk: Buffer | string) => appendLines(logs, chunk));
	let client: WorkerClient | undefined;
	try {
		client = new WorkerClient(`http://127.0.0.1:${parsed.port}`);
		await waitForReady(child, client, logs, parsed.port, controller.signal);
		const started = await client.start();
		await client.join();
		const { runTerminalRoom } = await import('./tui.ts');
		await runTerminalRoom({ client, roomName: started.started, logs, signal: controller.signal });
	} catch (error) {
		if (error instanceof WorkerError && error.status === 0)
			throw new DevError(`The local Worker stopped responding: ${error.message}`);
		if (error instanceof DevError) throw error;
		throw startupMessage(error, logs, parsed.port);
	} finally {
		process.removeListener('SIGINT', onInterrupt);
		process.removeListener('SIGTERM', onInterrupt);
		if (childStop === undefined) childStop = stopChild(child);
		await childStop;
	}
}
