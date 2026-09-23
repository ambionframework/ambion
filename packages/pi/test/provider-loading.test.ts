import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const node = process.env.AMBION_NODE ?? process.execPath;
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const entry = pathToFileURL(`${packageRoot}/dist/index.mjs`).href;
const testing = pathToFileURL(`${packageRoot}/dist/testing.mjs`).href;
const loader = fileURLToPath(new URL('./support/import-trace-loader.mjs', import.meta.url));

/**
 * A fresh process imports the built Pi entry and the provider catalog. It takes
 * under one second alone and several seconds when the other packages test in
 * parallel on a CI runner. The limit stays far above that cost. The Vitest
 * limit of each test stays above the process limit, so the process error
 * reaches the report.
 */
const processLimit = 60_000;
const testLimit = 90_000;

function runFreshProcess(code: string): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(node, ['--loader', loader, '--input-type=module', '-e', code], {
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error('fresh import process timed out'));
		}, processLimit);
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve({ code, stderr });
		});
	});
}

describe('provider loading', () => {
	it(
		'does not load the provider catalog while importing the Pi entry, reading a room, or running a scripted room',
		async () => {
			const result = await runFreshProcess(
				`const { readRoom, startRoom, defineAgent, defineHuman } = await import('@ambionframework/ambion');
			const { pi, piExecution } = await import(${JSON.stringify(entry)});
			const { quiet, scripted } = await import(${JSON.stringify(testing)});
			await readRoom('lazy-provider-test');
			const agent = (name) =>
				defineAgent({
					name,
					identity: name,
					executor: pi({ instructions: 'quiet', model: 'scripted/' + name }),
				});
			const room = await startRoom({
				name: 'lazy-scripted-check',
				agents: [agent('worker'), agent('assistant')],
				summary: 'assistant',
				execution: piExecution({ stream: scripted(() => quiet()) }),
			});
			const visit = await room.visit(defineHuman({ name: 'person', identity: 'tester' }));
			const exchange = await visit.send({ text: 'hello' });
			await exchange.waitForSummary();
			await room.stop();`,
			);
			expect(result.code).toBe(0);
			expect(result.stderr).not.toContain('AMBION_PROVIDER_IMPORT:');
		},
		testLimit,
	);

	it(
		'loads the catalog when the default model resolver is first used',
		async () => {
			const result = await runFreshProcess(
				`const { systemClock } = await import('@ambionframework/ambion');
			const { createExecutionServices } = await import(${JSON.stringify(entry)});
			const services = createExecutionServices({ clock: systemClock() });
			const model = await services.model('anthropic/claude-sonnet-4-5', 'test');
			if (model.id !== 'claude-sonnet-4-5' || model.provider !== 'anthropic') {
				throw new Error('unexpected model');
			}`,
			);
			expect(result.code).toBe(0);
			expect(result.stderr).toContain('AMBION_PROVIDER_IMPORT:');
		},
		testLimit,
	);
});
