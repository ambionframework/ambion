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
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 19;
const ENGINES_LABEL = '>=22.19 or >=23.6';

function supported() {
	const match = /^(\d+)\.(\d+)/.exec(process.versions.node);
	if (!match) return true; // unparseable: let the real CLI fail loudly instead
	const major = parseInt(match[1], 10);
	const minor = parseInt(match[2], 10);
	// Ambion loads TypeScript workspace files through Node's own type stripping,
	// which is on by default in 22.18+ and 23.6+ but not in 23.0–23.5.
	if (major === 23 && minor < 6) return false;
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

// Dynamic import keeps this file parseable on Node versions that would choke on
// the bundle's syntax — the exit above always wins there.
import('../dist/ambion.mjs').catch((error) => {
	console.error(error);
	process.exit(1);
});
