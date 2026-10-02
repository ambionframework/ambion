/**
 * The JSON-RPC connection to a process: requests and their answers, errors,
 * notifications, the requests of the server, the end of the process, and
 * the stop. Each test runs a real child process that stands for the server.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	type Connection,
	type Exit,
	type Handlers,
	RpcError,
	STDERR_TAIL,
	spawnAppServer,
} from '../src/app-server.ts';
import { until } from './support.ts';

const directory = mkdtempSync(join(tmpdir(), 'ambion-codex-rpc-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** A server that answers `echo` with its params, `fail` with an error, and `ask` after the host answers its request. */
const SERVER = `
const readline = require('node:readline');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
	const m = JSON.parse(line);
	if (m.method === 'initialized') { send({ method: 'ready', params: {} }); return; }
	if (m.method === 'echo') send({ id: m.id, result: m.params });
	else if (m.method === 'fail') send({ id: m.id, error: { code: -32600, message: 'bad request' } });
	else if (m.method === 'ask') { pending = m.id; send({ id: 'srv-1', method: 'item/tool/call', params: m.params }); }
	else if (m.method === 'noise') { process.stdout.write('not json\\n'); send({ id: m.id, result: 'after the noise' }); }
	else if (m.method === 'die') { process.stderr.write(m.params.last); process.exit(3); }
	else if (m.id === 'srv-1') send({ id: pending, result: m.result ?? { error: m.error } });
});
let pending;
`;

/** Start the server, and collect what the handlers hear. */
function started(
	script: string,
	handlers: Partial<Handlers> = {},
): { connection: Connection; heard: unknown[]; exits: Exit[] } {
	const heard: unknown[] = [];
	const exits: Exit[] = [];
	const connection = spawnAppServer(
		{ command: process.execPath, args: ['-e', script], env: { PATH: process.env.PATH ?? '' } },
		{
			notification: (method, params) => void heard.push({ method, params }),
			request: async () => ({ answered: true }),
			exit: (exit) => void exits.push(exit),
			...handlers,
		},
	);
	return { connection, heard, exits };
}

describe('requests', () => {
	it('answers each request with its own result, also when the answers come in another order', async () => {
		const { connection } = started(SERVER);
		try {
			const [one, two] = await Promise.all([
				connection.request('echo', { n: 1 }),
				connection.request('echo', { n: 2 }),
			]);
			expect([one, two]).toEqual([{ n: 1 }, { n: 2 }]);
		} finally {
			connection.close();
		}
	});

	it('rejects with the code and the message of an error answer, and drops a line that is not JSON', async () => {
		const { connection } = started(SERVER);
		try {
			await expect(connection.request('fail', {})).rejects.toMatchObject({
				name: 'RpcError',
				code: -32600,
				message: 'bad request',
			});
			expect(await connection.request('noise', {})).toBe('after the noise');
		} finally {
			connection.close();
		}
	});

	it('hears a notification of the server', async () => {
		const { connection, heard } = started(SERVER);
		try {
			connection.notify('initialized');
			await until(() => heard.length > 0, 'the notification');
			expect(heard).toEqual([{ method: 'ready', params: {} }]);
		} finally {
			connection.close();
		}
	});
});

describe('requests of the server', () => {
	it('answers with the result of the handler, and with its error when the handler throws', async () => {
		let mode: 'result' | 'error' = 'result';
		const { connection } = started(SERVER, {
			request: async (method, params) => {
				if (mode === 'error') throw new RpcError(-32601, `no ${method}`);
				return { got: params };
			},
		});
		try {
			expect(await connection.request('ask', { x: 1 })).toEqual({ got: { x: 1 } });
			mode = 'error';
			expect(await connection.request('ask', { x: 2 })).toEqual({
				error: { code: -32601, message: 'no item/tool/call' },
			});
		} finally {
			connection.close();
		}
	});
});

describe('the end of the process', () => {
	it('reports the exit once, with the end of the standard error, and fails the requests in flight', async () => {
		const { connection, exits } = started(SERVER);
		const dying = connection.request('die', { last: `${'x'.repeat(STDERR_TAIL + 50)}LAST WORDS` });
		await expect(dying).rejects.toThrow(/exited with code 3/);
		await until(() => exits.length > 0, 'the exit');
		expect(exits).toHaveLength(1);
		expect(exits[0]?.reason).toBe('exited with code 3');
		expect(exits[0]?.stderr.endsWith('LAST WORDS')).toBe(true);
		expect(exits[0]?.stderr.length).toBeLessThanOrEqual(STDERR_TAIL);
		await expect(connection.request('echo', {})).rejects.toThrow(/exited with code 3/);
		connection.close();
	});

	it('reports a binary that does not exist', async () => {
		const exits: Exit[] = [];
		const connection = spawnAppServer(
			{ command: '/nonexistent/ambion/codex', args: [], env: {} },
			{
				notification: () => {},
				request: async () => null,
				exit: (exit) => void exits.push(exit),
			},
		);
		await expect(connection.request('echo', {})).rejects.toThrow(/could not start/);
		await until(() => exits.length > 0, 'the exit');
		expect(exits[0]?.reason).toContain('could not start');
		expect(exits[0]?.reason).toContain('ENOENT');
	});
});

describe('close', () => {
	it('stops a server that ends with its input, and reports no exit', async () => {
		const { connection, exits } = started(SERVER);
		expect(await connection.request('echo', 1)).toBe(1);
		connection.close();
		connection.close();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(exits).toEqual([]);
	});

	it('kills a server that ignores its input and SIGTERM, after two seconds', async () => {
		const pidFile = join(directory, 'stubborn.pid');
		const stubborn = `
			process.on('SIGTERM', () => {});
			process.stdin.resume();
			setInterval(() => {}, 1000);
			// The file comes last, so the test closes a process that ignores SIGTERM.
			require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
		`;
		const { connection } = started(stubborn);
		await until(() => {
			try {
				return readFileSync(pidFile, 'utf8') !== '';
			} catch {
				return false;
			}
		}, 'the process');
		const pid = Number(readFileSync(pidFile, 'utf8'));
		connection.close();
		const alive = () => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		// SIGTERM changes nothing, so the process lives until the kill.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(alive()).toBe(true);
		await until(() => !alive(), 'the kill', 6_000);
	}, 15_000);
});
