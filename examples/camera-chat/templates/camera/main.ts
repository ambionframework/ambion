import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { SensorSource } from '@ambionframework/workspace/sensors';
import { builtInCamera, startCamera } from './camera.ts';
import { demoFrame, type Frame } from './frame.ts';
import { openSensor } from './server.ts';

const cwd = dirname(fileURLToPath(import.meta.url));
const git = (...args: string[]) =>
	execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
function launchSource(): SensorSource {
	const repository = process.env.AMBION_SENSOR_REPOSITORY;
	if (
		!repository ||
		!/^(?!templates\/)[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9._-]{0,63}$/.test(repository)
	)
		throw new Error('Set AMBION_SENSOR_REPOSITORY to your fork ID, such as observer/camera.');
	return {
		repository,
		commit: git('rev-parse', 'HEAD'),
		branch: git('branch', '--show-current') || undefined,
		dirty: git('status', '--porcelain').length > 0,
	};
}

async function main() {
	const { values } = parseArgs({
		options: { demo: { type: 'boolean' }, device: { type: 'string' } },
	});
	if (process.platform !== 'darwin' && !values.demo)
		throw new Error('Camera capture requires macOS.');
	const source = launchSource();
	const sensor = await openSensor(source);
	let ready = false;
	const receive = (frame: Frame) => {
		sensor.receive(frame);
		if (ready) return;
		ready = true;
		console.log(`READY ${JSON.stringify({ port: sensor.port, source })}`);
	};
	let stopCamera = async () => {};
	try {
		if (values.demo) receive(demoFrame());
		else
			stopCamera = startCamera(values.device ?? (await builtInCamera()), receive, (message) => {
				sensor.fail(message);
				console.error(message);
				process.exitCode = 1;
				process.emit('SIGTERM');
			});
		await new Promise<void>((resolve) => {
			process.once('SIGINT', resolve);
			process.once('SIGTERM', resolve);
		});
	} finally {
		await stopCamera();
		await sensor.close();
	}
}
main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
