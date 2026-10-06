/** A disposable host that starts the fixture server through a real workspace tool. */

import { openWorkspace } from '@ambionframework/workspace';
import { workstationBackend } from '@ambionframework/workstation';
import { action, latest, portOf, processHandle, runToolRoom } from './process-http.ts';
import { options } from './sshd.ts';

const owner = 'analyst';
const bash = workstationBackend(await options());
const workspace = openWorkspace({ name: 'lab', backend: { bash }, audit: {} });
const command = process.env.AMBION_PROCESS_HTTP_COMMAND;

try {
	if (command === undefined) throw new Error('The crash host needs the launch command.');
	const started = await runToolRoom(workspace, owner, [
		action('bash', { command, name: 'http-process', wait: 1, timeout: 86400 }),
	]);
	const text = latest(started.results, 'bash');
	const identity = { handle: processHandle(text), port: portOf(text) };
	process.stdout.write(`${JSON.stringify(identity)}\n`);
	await new Promise<void>(() => {
		setInterval(() => undefined, 60_000);
	});
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	await workspace.dispose();
	await bash.dispose?.();
	process.exitCode = 1;
}
