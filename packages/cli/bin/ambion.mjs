#!/usr/bin/env node
// @ts-nocheck

/**
 * `ambion` bin entrypoint.
 *
 * This file runs on whatever Node the user has — including versions Ambion
 * does not support — so it must stick to universally available JavaScript. It
 * is not compiled and not bundled; it ships as-is via the `files` array. Its
 * only job is to check the runtime before handing off to `../dist/ambion.mjs`,
 * which is free to assume a modern Node.
 */

// The floor is duplicated here and in package.json on purpose: this file has to
// parse on old Node, so it cannot use JSON import attributes to read the one in
// package.json, and the value is a build-time constant either way.
const MIN_NODE_MAJOR = 26;
const MIN_NODE_MINOR = 4;
const ENGINES_LABEL = '>=26.4';

function supported() {
	const match = /^(\d+)\.(\d+)/.exec(process.versions.node);
	if (!match) return true; // unparseable: let the real CLI fail loudly instead
	const major = parseInt(match[1], 10);
	const minor = parseInt(match[2], 10);
	// One floor covers both native TypeScript type stripping and OpenTUI.
	if (major > MIN_NODE_MAJOR) return true;
	return major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR;
}

if (!supported()) {
	const runtime = process.versions.bun
		? `Bun v${process.versions.bun}`
		: `Node.js v${process.versions.node}`;
	console.error(
		`\n${runtime} is not supported by Ambion.\n` +
			`Ambion requires Node.js ${ENGINES_LABEL} for native TypeScript support.\n` +
			`Upgrade: https://nodejs.org/\n`,
	);
	process.exit(1);
}

function supportsOpenTui() {
	if (process.versions.bun) return true;
	const match = /^(\d+)\.(\d+)/.exec(process.versions.node);
	if (!match) return false;
	const major = parseInt(match[1], 10);
	const minor = parseInt(match[2], 10);
	return major > 26 || (major === 26 && minor >= 4);
}

async function launch() {
	// OpenTUI uses Node's experimental FFI. Relaunch only for `dev`, so help,
	// version, and project creation keep the regular Ambion runtime floor.
	if (
		process.argv[2] === 'dev' &&
		!process.versions.bun &&
		!process.execArgv.includes('--experimental-ffi')
	)
		return relaunchForOpenTui();
	await import('../dist/ambion.mjs');
}

async function relaunchForOpenTui() {
	if (!supportsOpenTui()) {
		console.error(
			'\nambion dev needs Node.js 26.4 or newer with --experimental-ffi (or Bun 1.3 or newer).\n',
		);
		return process.exit(1);
	}
	const { spawn } = await import('node:child_process');
	const child = spawn(
		process.execPath,
		[...process.execArgv, '--experimental-ffi', process.argv[1], ...process.argv.slice(2)],
		{ stdio: 'inherit', env: process.env },
	);
	const result = await waitForChild(child);
	if (result.signal === 'SIGINT') process.exitCode = 130;
	else if (result.signal === 'SIGTERM') process.exitCode = 143;
	else process.exitCode = result.code ?? 1;
}

function waitForChild(child) {
	const forward = (signal) => {
		if (child.exitCode === null && child.signalCode === null) {
			try {
				child.kill(signal);
			} catch {}
		}
	};
	process.on('SIGINT', forward);
	process.on('SIGTERM', forward);
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			process.removeListener('SIGINT', forward);
			process.removeListener('SIGTERM', forward);
			child.removeListener('error', onError);
			child.removeListener('exit', onExit);
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		const onExit = (code, signal) => {
			cleanup();
			resolve({ code, signal });
		};
		child.once('error', onError);
		child.once('exit', onExit);
	});
}

launch().catch((error) => {
	console.error(error);
	process.exit(1);
});
