/**
 * The helpers that every git backend shares: the name rules of a
 * repository ID, and the repository registration with the pure helpers that
 * compare a source with a repository. `fromDirectory` and the source types
 * come from the root entry. This entry loads `node:fs` and `node:crypto`,
 * and no git library.
 */

export {
	assertAgent,
	assertCommitHash,
	BACKEND_AUTHOR,
	byPath,
	DEFAULT_BRANCH,
	namespaceOf,
	readOnly,
	revisionOf,
	SHARED,
	TEMPLATES,
	validName,
	validRefName,
	writableBy,
} from './git-names.ts';
export { type RegistrationSteps, registerRepositories } from './git-registration.ts';
export type { RepositoryRegistration } from './git-templates.ts';
export { changeTo, filesOf } from './git-templates.ts';
export { hashesOf, sameFiles } from './sources.ts';
