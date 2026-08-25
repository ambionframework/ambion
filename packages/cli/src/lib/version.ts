import { createRequire } from 'node:module';

interface Manifest {
	readonly name?: string;
	readonly version?: string;
}

/**
 * The CLI's own version, read at runtime rather than inlined at build time so a
 * linked checkout reports what is actually on disk.
 *
 * The bundle lives at `dist/ambion.mjs` and the source at `src/lib/version.ts`,
 * so the manifest is one or three levels up depending on how this module was
 * loaded. Both are tried; tests exercise the source layout.
 */
export function cliVersion(): string {
	const require = createRequire(import.meta.url);
	for (const specifier of ['../package.json', '../../package.json', '../../../package.json']) {
		try {
			const manifest = require(specifier) as Manifest;
			if (manifest.name === '@ambionframework/cli') return manifest.version ?? '0.0.0';
		} catch {
			// Keep walking up; a missing manifest at one level is expected.
		}
	}
	return '0.0.0';
}
