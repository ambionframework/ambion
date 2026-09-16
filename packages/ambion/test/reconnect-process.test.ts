import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const child = fileURLToPath(new URL('./support/reconnect-child.ts', import.meta.url));

function runChild(phase: 'start' | 'resume', directory: string) {
	return new Promise<{ code: number | null; signal: string | null; output: string }>(
		(resolve, reject) => {
			const process_ = spawn(process.execPath, ['--no-warnings', child, phase, directory], {
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 10_000,
			});
			let output = '';
			let errors = '';
			process_.stdout.on('data', (chunk: Buffer) => {
				output += chunk.toString();
				if (phase === 'start' && output.includes('ready\n')) process_.kill('SIGKILL');
			});
			process_.stderr.on('data', (chunk: Buffer) => {
				errors += chunk.toString();
			});
			process_.on('error', reject);
			process_.on('close', (code, signal) => resolve({ code, signal, output: output + errors }));
		},
	);
}

it('reconnects from durable client identifiers in a fresh process after SIGKILL', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ambion-reconnect-'));
	try {
		const killed = await runChild('start', directory);
		expect(killed.output).toContain('ready\n');
		expect(killed.signal).toBe('SIGKILL');
		const recovered = await runChild('resume', directory);
		expect(recovered.code, recovered.output).toBe(0);
		expect(recovered.output).toContain('recovered\n');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
