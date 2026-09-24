/**
 * A git backend for an Ambion workspace: read-only templates, forks, and
 * pushes, over a `just-git` server in the host's process.
 *
 * ```ts
 * import { openWorkspace } from '@ambionframework/workspace';
 * import { directoryBackend } from '@ambionframework/just-bash';
 * import { fromDirectory, gitBackend, sqliteGitStorage } from '@ambionframework/git';
 *
 * const lab = openWorkspace({
 * 	name: 'lab',
 * 	backend: {
 * 		bash: directoryBackend('./data/lab'),
 * 		git: gitBackend({
 * 			storage: sqliteGitStorage('./data/lab-git.db'),
 * 			secret: process.env.LAB_GIT_SECRET ?? '',
 * 			templates: {
 * 				'weekly-report': {
 * 					description: 'A weekly status report: numbers, risks, and next steps.',
 * 					source: fromDirectory('./templates/weekly-report'),
 * 				},
 * 			},
 * 		}),
 * 	},
 * });
 * ```
 *
 * The design contract is `docs/git.md`.
 */

export type { GitBackendOptions, JustGitBackend } from './backend.ts';
export { gitBackend } from './backend.ts';
export type { GitStorage, OpenGitStorage, Registry, RegistryRow } from './storage.ts';
export { sqliteGitStorage } from './storage.ts';
export type { TemplateFiles, TemplateRegistration, TemplateSource } from './templates.ts';
export { fromDirectory } from './templates.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/git';
