/**
 * The text rules that `skills.ts` and `skill-macros.ts` share: the error of
 * a skill set, the names, and the YAML header of a file.
 */

import { parse } from 'yaml';

export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
export const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The frontmatter: from a first line of `---` to the next line that is `---` alone. */
export const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

/** Throw the error that names the source. */
export function refuse(message: string): never {
	throw new Error(`Skill set: ${message}`);
}

/** The text of `bytes` with `\n` line ends. `what` names the file in the error. */
export function decodeText(what: string, bytes: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n');
	} catch {
		return refuse(`${what} is not UTF-8 text.`);
	}
}

/** The YAML mapping in `yaml`. `what` names the header in the error. */
export function mappingOf(what: string, yaml: string): Record<string, unknown> {
	let data: unknown;
	try {
		data = parse(yaml);
	} catch (error) {
		refuse(`${what} is not YAML: ${(error as Error).message}`);
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data))
		refuse(`${what} is not a YAML mapping.`);
	return data as Record<string, unknown>;
}
