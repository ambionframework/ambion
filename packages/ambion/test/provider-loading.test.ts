import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const node = process.env.AMBION_NODE ?? process.execPath;
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const entry = pathToFileURL(`${packageRoot}/dist/index.mjs`).href;
const loader = fileURLToPath(new URL('./support/import-trace-loader.mjs', import.meta.url));

function runFreshProcess(code: string): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(node, ['--loader', loader, '--input-type=module', '-e', code], {
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error('fresh import process timed out'));
		}, 10_000);
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
	it('does not load the provider catalog while importing and reading the public entry', async () => {
		const result = await runFreshProcess(
			`const { readRoom } = await import(${JSON.stringify(entry)});
			await readRoom('lazy-provider-test');`,
		);
		expect(result.code).toBe(0);
		expect(result.stderr).not.toContain('AMBION_PROVIDER_IMPORT:');
	});

	it('does not load the provider catalog during scripted room execution', async () => {
		const result = await runFreshProcess(
			`const { createAssistantMessageEventStream, fauxAssistantMessage } = await import(
				'@earendil-works/pi-ai'
			);
			const { startRoom, defineAgent, defineHuman, pi } = await import(${JSON.stringify(entry)});
			const streamFn = (_model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				const message = fauxAssistantMessage('', { stopReason: 'stop' });
				queueMicrotask(() => {
					if (options?.signal?.aborted) return;
					stream.push({ type: 'start', partial: message });
					stream.push({ type: 'done', reason: 'stop', message });
				});
				return stream;
			};
			const assistant = defineAgent({
				name: 'assistant',
				identity: 'summarizes',
				executor: pi({ instructions: 'quiet', model: 'scripted/assistant' }),
			});
			const worker = defineAgent({
				name: 'worker',
				identity: 'answers',
				executor: pi({ instructions: 'quiet', model: 'scripted/worker' }),
			});
			const room = await startRoom({
				name: 'lazy-scripted-check',
				agents: [worker, assistant],
				summary: assistant.name,
				streamFn,
			});
			const visit = await room.visit(defineHuman({ name: 'person', identity: 'tester' }));
			const exchange = await visit.send({ text: 'hello' });
			await exchange.waitForSummary();
			await room.stop();`,
		);
		expect(result.code).toBe(0);
		expect(result.stderr).not.toContain('AMBION_PROVIDER_IMPORT:');
	});

	it('loads the catalog when the default model resolver is first used', async () => {
		const result = await runFreshProcess(
			`const { createRuntime } = await import(${JSON.stringify(entry)});
			const model = await createRuntime().model('anthropic/claude-sonnet-4-5', 'test');
			if (model.id !== 'claude-sonnet-4-5' || model.provider !== 'anthropic') {
				throw new Error('unexpected model');
			}`,
		);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain('AMBION_PROVIDER_IMPORT:');
	});
});
