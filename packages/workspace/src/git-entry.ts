/**
 * The helpers that every git backend shares: the name rules of a
 * repository ID, and the template registration with the pure helpers that
 * compare a source with a repository. `fromDirectory` and the source types
 * come from the root entry. This entry loads `node:fs` and `node:crypto`,
 * and no git library.
 */

export { assertAgent, namespaceOf, readOnly, SOURCES, TEMPLATES, validName } from './git-names.ts';
export type { TemplateRegistration } from './git-templates.ts';
export { changeTo, filesOf } from './git-templates.ts';
export { hashesOf, sameFiles } from './sources.ts';
