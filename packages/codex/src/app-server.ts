/**
 * The `codex app-server` process and its JSON-RPC connection.
 *
 * One connection serves one activation. The host writes one JSON message on
 * each line of standard input, and the server answers on standard output.
 * A message with an `id` and a `method` is a request, and a message with
 * only an `id` is a response. A message with a `method` and no `id` is a
 * notification. The server exits when its input ends, so a host that dies
 * leaves no process behind.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** The most characters of standard error that a failure message holds. */
export const STDERR_TAIL = 2_000;

/** How long `close` waits for the process to exit after SIGTERM, in milliseconds. */
const KILL_AFTER_MS = 2_000;

/** A JSON-RPC error: from the server, or from the host to refuse a server request. */
export class RpcError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = 'RpcError';
		this.code = code;
	}
}

/** How the process ended, with the end of its standard error. */
export interface Exit {
	/** The text that names the exit code or the signal, or the error that stopped the process from starting. */
	readonly reason: string;
	readonly stderr: string;
}

/** What the host listens for on a connection. */
export interface Handlers {
	/** A notification of the server. */
	notification(method: string, params: unknown): void;
	/** A request of the server. The answer is the result, or an `RpcError` that the server receives. */
	request(method: string, params: unknown): Promise<unknown>;
	/** The process ended. Called once, and not after `close`. */
	exit(exit: Exit): void;
}

/** What starts the process. */
export interface Launch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly cwd?: string;
}

/** A JSON-RPC connection to an app-server. */
export interface Connection {
	/** Send a request, and resolve with its result. An error answer rejects with an `RpcError`. */
	request(method: string, params: unknown): Promise<unknown>;
	/** Send a notification. */
	notify(method: string, params?: unknown): void;
	/** The end of the standard error of the process. */
	stderr(): string;
	/** End the input and stop the process. Safe to call again. */
	close(): void;
}

/** What opens a connection. A test supplies its own. */
export type Connect = (launch: Launch, handlers: Handlers) => Connection;

/** The end of what a process wrote to its standard error. */
class Tail {
	private text = '';

	add(data: string): void {
		this.text = (this.text + data).slice(-STDERR_TAIL);
	}

	get value(): string {
		return this.text.trim();
	}
}

/** A message of the server, after parsing. */
interface Incoming {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string };
}

/** The text that says how a process ended. */
function reasonOf(code: number | null, signal: NodeJS.Signals | null): string {
	return signal === null ? `exited with code ${code}` : `was stopped by ${signal}`;
}

/** The connection to a running `codex app-server`. */
class ProcessConnection implements Connection {
	private readonly child: ChildProcess;
	private readonly handlers: Handlers;
	private readonly tail = new Tail();
	private readonly pending = new Map<
		number,
		{ resolve: (result: unknown) => void; reject: (error: Error) => void }
	>();
	private serial = 0;
	private closed = false;
	private ended: Exit | undefined;

	constructor(launch: Launch, handlers: Handlers) {
		this.handlers = handlers;
		this.child = spawn(launch.command, [...launch.args], {
			env: { ...launch.env },
			stdio: ['pipe', 'pipe', 'pipe'],
			...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
		});
		// A write after the process died fails with EPIPE. The exit handler reports the end.
		this.child.stdin?.on('error', () => {});
		this.child.stderr?.setEncoding('utf8');
		this.child.stderr?.on('data', (data: string) => this.tail.add(data));
		this.child.once('error', (error) => this.end(`could not start: ${error.message}`));
		this.child.once('close', (code, signal) => this.end(`${reasonOf(code, signal)}`));
		if (this.child.stdout !== null) {
			createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) =>
				this.receive(line),
			);
		}
	}

	request(method: string, params: unknown): Promise<unknown> {
		if (this.ended !== undefined) return Promise.reject(new Error(this.ended.reason));
		const id = ++this.serial;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write({ id, method, params });
		});
	}

	notify(method: string, params?: unknown): void {
		this.write(params === undefined ? { method } : { method, params });
	}

	stderr(): string {
		return this.tail.value;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.child.stdin?.end();
		if (this.ended !== undefined) return;
		// The server exits when its input ends. The signals stop one that does not.
		this.child.kill('SIGTERM');
		setTimeout(() => {
			if (this.ended === undefined) this.child.kill('SIGKILL');
		}, KILL_AFTER_MS).unref();
	}

	private write(message: object): void {
		if (this.ended !== undefined || this.child.stdin?.writable !== true) return;
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	/** The process ended. Every request in flight fails, and the host hears once. */
	private end(reason: string): void {
		if (this.ended !== undefined) return;
		this.ended = { reason, stderr: this.tail.value };
		for (const { reject } of this.pending.values())
			reject(new Error(`Codex app-server ${reason}.`));
		this.pending.clear();
		if (!this.closed) this.handlers.exit(this.ended);
	}

	private receive(line: string): void {
		let message: Incoming;
		try {
			message = JSON.parse(line) as Incoming;
		} catch {
			// A line that is not JSON carries no message.
			return;
		}
		if (message.method === undefined) this.respond(message);
		else if (message.id === undefined) this.handlers.notification(message.method, message.params);
		else void this.serve(message.id, message.method, message.params);
	}

	private respond(message: Incoming): void {
		if (typeof message.id !== 'number') return;
		const waiting = this.pending.get(message.id);
		this.pending.delete(message.id);
		if (message.error !== undefined) {
			waiting?.reject(new RpcError(message.error.code ?? -32603, message.error.message ?? ''));
		} else {
			waiting?.resolve(message.result);
		}
	}

	/** Answer a request of the server with the result of the handler, or with the error it threw. */
	private async serve(id: number | string, method: string, params: unknown): Promise<void> {
		try {
			this.write({ id, result: await this.handlers.request(method, params) });
		} catch (error) {
			const code = error instanceof RpcError ? error.code : -32603;
			const message = error instanceof Error ? error.message : String(error);
			this.write({ id, error: { code, message } });
		}
	}
}

/** Start `codex app-server`. */
export const spawnAppServer: Connect = (launch, handlers) =>
	new ProcessConnection(launch, handlers);
