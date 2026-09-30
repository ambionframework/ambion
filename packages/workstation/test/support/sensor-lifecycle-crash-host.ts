/** A disposable host process that starts the SN35 sensor through a real workspace tool. */

import { openWorkspace } from '@ambionframework/workspace';
import { workstationBackend } from '@ambionframework/workstation';
import { action, latest, processHandle, readyPort, runToolRoom } from './sensor-lifecycle.ts';
import { options } from './sshd.ts';

const owner = 'analyst';
const bash = workstationBackend(await options());
const workspace = openWorkspace({ name: 'lab', backend: { bash }, audit: {} });
const nodePath = process.env.AMBION_SENSOR_LIFECYCLE_NODE;

try {
	if (nodePath === undefined || !nodePath.startsWith('/')) {
		throw new Error('The crash host needs the absolute remote Node path.');
	}
	const started = await runToolRoom(workspace, owner, [
		action('bash', {
			command: `cd ~/sensor-server && AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/sn35" PORT=0 ${shellQuote(nodePath)} server.mjs`,
			name: 'sensor-server-crash-host',
			wait: 1,
			timeout: 86400,
		}),
	]);
	const text = latest(started.results, 'bash');
	const identity = { handle: processHandle(text), port: readyPort(text) };
	const delay = Number(process.env.AMBION_SENSOR_LIFECYCLE_RESPONSE_DELAY_MS ?? 0);
	process.stderr.write(`SN35_READY:${JSON.stringify(identity)}\n`);
	await new Promise((resolve) => setTimeout(resolve, Math.max(delay, 25)));
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

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
