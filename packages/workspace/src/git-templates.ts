/**
 * Templates: the registration a host gives each one, and the pure helpers
 * that compare its source with a repository.
 *
 * A git backend registers each template before its first operation. It
 * compares the files of the source with the tree at the tip of the
 * template by their blob hashes (`./sources.ts`), so it writes nothing to
 * compare. This module reads no repository and loads no git library. Each
 * git backend reads the hashes at a tip with its own library.
 */

import { readSource, type SourceFiles, type SourceInput } from './sources.ts';

/** One template: its source, and an optional description that `repos` shows. */
export interface TemplateRegistration {
	readonly source: SourceInput;
	readonly description?: string;
}

/** The files of a registration, as bytes. */
export function filesOf(registration: TemplateRegistration): Promise<SourceFiles> {
	return readSource(registration.source);
}

/** The change that turns the tip into `files`: every file, and `null` for a file that went. */
export function changeTo(
	files: SourceFiles,
	tip: ReadonlyMap<string, string>,
): Record<string, Uint8Array | null> {
	const change: Record<string, Uint8Array | null> = { ...files };
	for (const path of tip.keys()) if (!(path in files)) change[path] = null;
	return change;
}
