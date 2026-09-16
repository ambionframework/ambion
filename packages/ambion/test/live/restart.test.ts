/**
 * A real provider contribution survives a process kill over SQLite. The
 * process dies after that contribution is durable and while a second wake is
 * still pending. A fresh process resumes the same exchange and answers it.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { live } from './support.ts';

const child = fileURLToPath(new URL('./support/live-restart-child.ts', import.meta.url));

interface ChildResult {
	readonly code: number | null;
	readonly signal: string | null;
	readonly lines: string[];
	readonly stderr: string;
	readonly readyAt: number | undefined;
}

function runChild(phase: 'start' | 'resume', directory: string): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		const process_ = spawn(process.execPath, ['--no-warnings', child, phase, directory], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const lines: string[] = [];
		let stderr = '';
		let buffer = '';
		let finished = false;
		let readyAt: number | undefined;
		const timeout = setTimeout(() => process_.kill('SIGKILL'), 150_000);
		const finish = (result: ChildResult) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			resolve(result);
		};
		process_.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		process_.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			const complete = buffer.split('\n');
			buffer = complete.pop() ?? '';
			for (const line of complete) {
				if (line.length > 0) lines.push(line);
				if (phase === 'start' && line.startsWith('ready ')) {
					readyAt = Date.now();
					process_.kill('SIGKILL');
				}
			}
		});
		process_.on('error', reject);
		process_.on('close', (code, signal) => finish({ code, signal, lines, stderr, readyAt }));
	});
}

live('restart', () => {
	it('recovers a durable real-model exchange in a fresh Node process', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-live-restart-'));
		try {
			const killed = await runChild('start', directory);
			const startOutput = [killed.lines.join('\n'), killed.stderr].filter(Boolean).join('\n');
			expect(killed.signal, startOutput).toBe('SIGKILL');
			const ready = killed.lines.find((line) => line.startsWith('ready '));
			expect(ready).toBeDefined();
			const checkpoint = JSON.parse(ready?.slice('ready '.length) ?? '{}') as {
				from: number;
				fastSeq: number;
				pending: boolean;
				slowLease: string;
				slowExpiresAt: number;
			};
			expect(checkpoint.from).toBeGreaterThan(0);
			expect(checkpoint.fastSeq).toBeGreaterThan(checkpoint.from);
			expect(checkpoint.pending).toBe(true);
			expect(checkpoint.slowLease).toBe('active');
			expect(checkpoint.slowExpiresAt).toBeGreaterThan(killed.readyAt ?? Number.POSITIVE_INFINITY);
			console.info(
				`restart ready: fastSeq=${checkpoint.fastSeq}, slowExpiresAt=${checkpoint.slowExpiresAt}`,
			);

			const recovered = await runChild('resume', directory);
			const resumeOutput = [recovered.lines.join('\n'), recovered.stderr]
				.filter(Boolean)
				.join('\n');
			expect(recovered.code, resumeOutput).toBe(0);
			const resultLine = recovered.lines.find((line) => line.startsWith('recovered '));
			expect(resultLine).toBeDefined();
			const result = JSON.parse(resultLine?.slice('recovered '.length) ?? '{}') as {
				from: number;
				questionCount: number;
				fastCount: number;
				slowCount: number;
				arrivals: number;
				fastSeq: number;
			};
			expect(result.from).toBe(checkpoint.from);
			expect(result.fastSeq).toBe(checkpoint.fastSeq);
			expect(result.questionCount).toBe(1);
			expect(result.fastCount).toBe(1);
			expect(result.slowCount).toBe(1);
			expect(result.arrivals).toBe(1);
			console.info(`restart recovered: from=${result.from}, fastSeq=${result.fastSeq}`);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 320_000);
});
