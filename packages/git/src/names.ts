/**
 * Repository IDs and the reserved namespaces.
 *
 * An ID is `<namespace>/<name>`. `templates` holds the read-only templates,
 * `template-sources` holds the source of each template, and every other
 * namespace is the name of an agent. No agent takes a reserved name.
 */

import type { WorkspaceAgent } from '@ambionframework/workspace/resource';

/** The namespace of the read-only templates. */
export const TEMPLATES = 'templates';

/** The namespace of the source of each template. No agent reaches it. */
export const SOURCES = 'template-sources';

const RESERVED = new Set([TEMPLATES, SOURCES]);

/** The rule for the name of a repository: 1 to 64 characters. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Whether `name` is a valid repository name. */
export function validName(name: string): boolean {
	return NAME.test(name);
}

/** The namespace of an ID, or `undefined` for an ID that is not `<namespace>/<name>`. */
export function namespaceOf(id: string): string | undefined {
	const slash = id.indexOf('/');
	if (slash <= 0 || slash !== id.lastIndexOf('/')) return undefined;
	return validName(id.slice(slash + 1)) ? id.slice(0, slash) : undefined;
}

/** Refuse an agent that takes a reserved name. */
export function assertAgent(agent: WorkspaceAgent): void {
	if (RESERVED.has(agent.name)) {
		throw new Error(`The name '${agent.name}' is reserved by the git backend.`);
	}
}

/** Whether no agent can push to the repository `id`. */
export function readOnly(id: string): boolean {
	const namespace = namespaceOf(id);
	return namespace === TEMPLATES || namespace === SOURCES;
}
