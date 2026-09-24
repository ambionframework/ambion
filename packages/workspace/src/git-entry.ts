/**
 * The helpers that every git backend shares: the name rules of a
 * repository ID, and the template sources with the pure helpers that
 * compare them with a repository. This entry loads `node:fs` and
 * `node:crypto`, and no git library.
 */

export { assertAgent, namespaceOf, readOnly, SOURCES, TEMPLATES, validName } from './git-names.ts';
export type { TemplateFiles, TemplateRegistration, TemplateSource } from './git-templates.ts';
export { changeTo, filesOf, fromDirectory, hashesOf, sameFiles } from './git-templates.ts';
