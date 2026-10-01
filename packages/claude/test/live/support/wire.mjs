#!/usr/bin/env node
/**
 * A wrapper around the real Claude Code binary, for the live tier. The SDK
 * spawns it through `pathToClaudeCodeExecutable`. It records what the real
 * process starts with, then runs the real binary with the same arguments, the
 * same environment, and the same working directory.
 *
 * The test names the log file in `AMBION_WIRE_LOG`, through the `env` option
 * of `claudeExecution`. The wrapper removes that variable before it starts the
 * binary, so the log shows the environment that the binary gets.
 *
 * The log holds one JSON line for each start: the sorted names of the
 * variables, the working directory, and the values of `HOME` and
 * `CLAUDE_CONFIG_DIR`. Both values are paths. The log never holds another
 * value.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const log = process.env.AMBION_WIRE_LOG;
delete process.env.AMBION_WIRE_LOG;

/** The package names of the native binary, in the order to try them. */
function candidates() {
	const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
	if (process.platform !== 'linux') return [base];
	const glibc = Boolean(process.report?.getReport().header.glibcVersionRuntime);
	return glibc ? [base, `${base}-musl`] : [`${base}-musl`, base];
}

/** The path of the real binary that the SDK ships for this platform. */
function realBinary() {
	const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk/package.json');
	const require = createRequire(sdk);
	for (const name of candidates()) {
		try {
			const path = join(
				dirname(require.resolve(`${name}/package.json`)),
				process.platform === 'win32' ? 'claude.exe' : 'claude',
			);
			if (existsSync(path)) return path;
		} catch {
			// The package is not installed. Try the next one.
		}
	}
	throw new Error('The wrapper found no native Claude Code binary.');
}

if (log !== undefined) {
	appendFileSync(
		log,
		`${JSON.stringify({
			names: Object.keys(process.env).sort(),
			cwd: process.cwd(),
			HOME: process.env.HOME,
			CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
		})}\n`,
	);
}

const child = spawn(realBinary(), process.argv.slice(2), { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
	if (signal !== null) process.kill(process.pid, signal);
	else process.exit(code ?? 1);
});
