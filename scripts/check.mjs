#!/usr/bin/env node
/**
 * The gate: `pnpm check [step...]`.
 *
 * Each step runs one root script and keeps its output. A step that passes
 * prints one line. A step that fails prints the lines to act on, the fix, and
 * the path of the full log. Every step runs, so one run reports every
 * failure. The fast steps run together; the build, the types, and the tests
 * run after them, in turn.
 *
 *   pnpm check             # every step
 *   pnpm check lint types  # the named steps
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clip, failedTasks, findings, plain, selectSteps } from './check-lib.mjs';
import { ROOT } from './packages.mjs';

const LOGS = join('.cache', 'check');
/** The most lines that a failed step prints. The log holds the rest. */
const LIMIT = 60;
const FAST = new Set(['format', 'lint', 'knip', 'rules', 'reports']);

/** Run one root script. Resolve with its exit code, its output, and its time. */
function run(script) {
	const started = Date.now();
	const env = { ...process.env, TURBO_TELEMETRY_DISABLED: '1' };
	const child = spawn('pnpm', ['--silent', 'run', script], { cwd: ROOT, env });
	const chunks = [];
	child.stdout.on('data', (chunk) => chunks.push(chunk));
	child.stderr.on('data', (chunk) => chunks.push(chunk));
	return new Promise((resolve) => {
		child.on('error', (error) => {
			resolve({ code: 1, output: `cannot start pnpm: ${error.message}`, seconds: 0 });
		});
		child.on('close', (code) => {
			const output = plain(Buffer.concat(chunks).toString('utf8'));
			resolve({ code: code ?? 1, output, seconds: (Date.now() - started) / 1000 });
		});
	});
}

/** The directory of each workspace package, by package name. */
function packageDirs() {
	const dirs = {};
	for (const group of ['packages', 'examples']) {
		if (!existsSync(join(ROOT, group))) continue;
		for (const name of readdirSync(join(ROOT, group))) {
			const manifest = join(ROOT, group, name, 'package.json');
			if (existsSync(manifest))
				dirs[JSON.parse(readFileSync(manifest, 'utf8')).name] = `${group}/${name}`;
		}
	}
	return dirs;
}

/** Print the result of one step, and keep its full output in the log. Return whether it passed. */
function report(step, result, dirs) {
	const log = join(LOGS, `${step.name}.log`);
	writeFileSync(join(ROOT, log), result.output);
	const time = `${result.seconds.toFixed(1)}s`;
	if (result.code === 0) {
		console.log(`ok ${step.name} ${time}`);
		return true;
	}
	const tasks = failedTasks(result.output);
	console.log(`FAIL ${step.name} ${time}${tasks.length > 0 ? ` · ${tasks.join(' ')}` : ''}`);
	for (const line of clip(findings(result.output, dirs), LIMIT)) console.log(`  ${line}`);
	if (step.fix) console.log(`  fix: ${step.fix}`);
	console.log(`  log: ${log}`);
	return false;
}

async function main() {
	const steps = selectSteps(process.argv.slice(2));
	const dirs = packageDirs();
	mkdirSync(join(ROOT, LOGS), { recursive: true });
	const started = Date.now();
	const fast = new Map(steps.filter((s) => FAST.has(s.name)).map((s) => [s.name, run(s.script)]));
	const failed = [];
	for (const step of steps) {
		if (step.needs && failed.includes(step.needs)) {
			console.log(`skip ${step.name} · ${step.needs} failed`);
			continue;
		}
		const result = await (fast.get(step.name) ?? run(step.script));
		if (!report(step, result, dirs)) failed.push(step.name);
	}
	const time = `${Math.round((Date.now() - started) / 1000)}s`;
	if (failed.length === 0) {
		console.log(`check ok · ${time}`);
		return;
	}
	console.log(`check failed · ${time} · rerun: pnpm check ${failed.join(' ')}`);
	process.exitCode = 1;
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 2;
});
