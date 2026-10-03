/**
 * The child process of `processRuntime`. Node starts it with `--permission`
 * and no allow flag, so it loads this file and no other file, and it reads no
 * file, opens no socket, and starts no process or worker. The build bundles
 * the setup script, and this file imports only `node:` built-ins.
 *
 * It speaks JSON lines over stdio. The host sends one `run` line, and one
 * `result` line for each `call` line that the child sends. The child sends
 * one `done` line. The `id` of a call names the `result` that settles it, so
 * several calls run together.
 */
import { createInterface } from 'node:readline';
import { createContext, Script } from 'node:vm';
import { GUEST } from './guest.ts';

type Start = (
	hostCall: (name: string, json: string) => Promise<string>,
	hostDone: (json: string) => void,
	config: string,
) => void;

interface Waiting {
	resolve(text: string): void;
	reject(text: string): void;
}

const waiting = new Map<number, Waiting>();
let calls = 0;

function send(message: object): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function hostCall(name: string, json: string): Promise<string> {
	calls += 1;
	const id = calls;
	return new Promise((resolve, reject) => {
		waiting.set(id, { resolve, reject });
		try {
			send({ type: 'call', id, name, args: JSON.parse(json) });
		} catch (error) {
			waiting.delete(id);
			reject(JSON.stringify({ message: `The call could not be sent: ${String(error)}` }));
		}
	});
}

/** The functions that the code reaches never throw: a bad report is a failure report. */
function hostDone(json: string): void {
	try {
		send({ type: 'done', report: JSON.parse(json) });
	} catch (error) {
		send({
			type: 'done',
			report: { ok: false, message: `The report is not JSON: ${String(error)}` },
		});
	}
}

/** The code runs in a context of its own, with the globals of the setup script. */
function run(config: string): void {
	const context = createContext({}, { codeGeneration: { strings: true, wasm: false } });
	const start = new Script(GUEST).runInContext(context) as Start;
	start(hostCall, hostDone, config);
}

function settle(line: { id: number; ok: boolean; value?: unknown; failure?: unknown }): void {
	const call = waiting.get(line.id);
	waiting.delete(line.id);
	if (line.ok) call?.resolve(JSON.stringify(line.value));
	else call?.reject(JSON.stringify(line.failure));
}

function receive(text: string): void {
	const line = JSON.parse(text);
	if (line.type === 'run') run(line.config);
	else if (line.type === 'result') settle(line);
}

// Code that drops the promise of a failed call leaves a rejection that nothing handles.
process.on('unhandledRejection', () => {});
const input = createInterface({ input: process.stdin });
input.on('line', receive);
input.on('close', () => process.exit(0));
