/**
 * Start the persistent Relay Task acceptance fixture for manual browser checks.
 *
 * Run with:
 *   node scripts/tasks-ui.ts --delay-ms 45000
 *   node scripts/tasks-ui.ts --delay-ms 45000 --fail
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDemo } from '../src/server.ts';
import { taskStream } from '../test/task-stream.ts';

const args = process.argv.slice(2);
const delay = readDelay(
	args.includes('--delay-ms') ? args[args.indexOf('--delay-ms') + 1] : undefined,
);
const status = process.argv.includes('--fail') ? 'failed' : 'succeeded';
const port = readPort(args.includes('--port') ? args[args.indexOf('--port') + 1] : undefined);
const parent = await mkdtemp(join(tmpdir(), 'ambion-task-ui-'));
const directory = join(parent, 'demo');
const control = taskStream({ workerDelayMs: delay, workerStatus: status });
const demo = await openDemo(directory, 'start', control.stream);
let closing = false;

async function stop(): Promise<void> {
	if (closing) return;
	closing = true;
	await demo.close();
	await rm(parent, { recursive: true, force: true });
}

process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));

demo.server.listen(port, '127.0.0.1', () => {
	const address = demo.server.address();
	if (!address || typeof address === 'string')
		throw new Error('The Relay server did not bind a port.');
	console.log(`Relay Task UI: http://127.0.0.1:${address.port}/`);
	console.log(`Worker terminal status: ${status}; delay: ${delay}ms.`);
	console.log('In delivery as alice, send: Please start a background task.');
	console.log('While it is open, send: While the background task runs, what is its status?');
	console.log('Use Ctrl-C to stop the fixture.');
});

function readDelay(value: string | undefined): number {
	const result = Number(value ?? 15_000);
	if (!Number.isFinite(result) || result < 0)
		throw new Error('--delay-ms must be a nonnegative number.');
	return result;
}

function readPort(value: string | undefined): number {
	const result = Number(value ?? 0);
	if (!Number.isInteger(result) || result < 0 || result > 65_535)
		throw new Error('--port must be an integer between 0 and 65535.');
	return result;
}
