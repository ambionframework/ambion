import { parseArgs } from 'node:util';
import { listCameras } from '../templates/camera/camera.ts';
import { DEFAULT_MODEL, openHost } from './host.ts';
import { requireLogin } from './login.ts';
import { createCameraRenderer } from './terminal.ts';
import { runTui } from './tui.ts';

function options() {
	const { values } = parseArgs({
		options: {
			demo: { type: 'boolean', default: false },
			device: { type: 'string' },
			'list-cameras': { type: 'boolean' },
			directory: { type: 'string' },
			model: { type: 'string' },
		},
	});
	if (values.device && !/^\d+$/.test(values.device))
		throw new Error('--device must be an AVFoundation video device index.');
	const model = values.model ?? DEFAULT_MODEL;
	return {
		...values,
		model,
		directory: values.directory ?? (values.demo ? '.data/demo' : '.data/live'),
	};
}

async function main() {
	const config = options();
	if (process.platform !== 'darwin') throw new Error('Camera Chat requires macOS.');
	if (!config.demo && !config['list-cameras']) await requireLogin();
	if (config['list-cameras']) {
		console.log(
			(await listCameras()).map((camera) => `${camera.index}: ${camera.name}`).join('\n'),
		);
		return;
	}
	const renderer = await createCameraRenderer();
	try {
		const host = await openHost({
			directory: config.directory,
			model: config.model,
			demo: config.demo,
			device: config.device,
		});
		try {
			await runTui(renderer, host, config.demo);
		} finally {
			await host.close();
		}
	} finally {
		renderer.destroy();
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
