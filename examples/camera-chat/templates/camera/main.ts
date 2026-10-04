import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { builtInCamera, DEFAULT_FRAMERATE, startCamera } from './camera.ts';
import { demoFrame, type Frame } from './frame.ts';
import { openSensor, type SensorSource } from './server.ts';

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

/** The port of the process. The workspace sets `PORT` for every process that `bash` starts. */
function portOf(value: string | undefined): number {
	const port = Number(value);
	if (value === undefined || !Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error('PORT must be an integer from 1 to 65535. The workspace sets it.');
	return port;
}

async function main() {
	const { values } = parseArgs({
		options: {
			demo: { type: 'boolean' },
			device: { type: 'string' },
			framerate: { type: 'string' },
		},
	});
	if (process.platform !== 'darwin' && !values.demo)
		throw new Error('Camera capture requires macOS.');
	const framerate = Number(values.framerate ?? DEFAULT_FRAMERATE);
	if (!Number.isFinite(framerate) || framerate <= 0)
		throw new Error('--framerate must be a positive number.');
	const source = launchSource();
	const sensor = await openSensor(source, portOf(process.env.PORT));
	const receive = (frame: Frame) => sensor.receive(frame);
	let stopCamera = async () => {};
	try {
		if (values.demo) receive(demoFrame());
		else
			stopCamera = startCamera(
				values.device ?? (await builtInCamera()),
				receive,
				(message) => {
					sensor.fail(message);
					console.error(message);
					process.exitCode = 1;
					process.emit('SIGTERM');
				},
				framerate,
			);
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
