import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { listCameras } from '../templates/camera/camera.ts';
import { demoStream, openHost } from './host.ts';
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
	const model = values.model ?? process.env.AMBION_MODEL ?? 'openai/gpt-6-luna';
	return {
		...values,
		model,
		directory: values.directory ?? (values.demo ? '.data/demo' : '.data/live'),
	};
}

/** Read the configured local credential without writing it into the checkout. */
async function loadOpenAiKey(model: string, skip: boolean): Promise<void> {
	if (skip || !model.startsWith('openai/')) return;
	let key: string;
	try {
		key = (await readFile(join(homedir(), '.openai', 'dev-key'), 'utf8')).trim();
	} catch {
		throw new Error('Cannot read the OpenAI key from ~/.openai/dev-key.');
	}
	if (!key || /\s/.test(key)) throw new Error('The OpenAI key file must contain one raw key.');
	process.env.OPENAI_API_KEY = key;
}

function validate(model: string, demo: boolean) {
	if (process.platform !== 'darwin') throw new Error('Camera Chat requires macOS.');
	const key = `${model.split('/')[0]?.toUpperCase().replaceAll('-', '_')}_API_KEY`;
	if (!demo && !process.env[key])
		throw new Error(`Set ${key}, or use --demo for the scripted agent.`);
}

async function main() {
	const config = options();
	const skipKey = config.demo || Boolean(config['list-cameras']);
	await loadOpenAiKey(config.model, skipKey);
	validate(config.model, skipKey);
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
			stream: config.demo ? demoStream() : undefined,
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
