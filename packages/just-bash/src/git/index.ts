/**
 * The git backend of the just-bash backends: read-only templates, forks,
 * and pushes, over a `just-git` server in the host's process.
 *
 * ```ts
 * import { directoryBackend } from '@ambionframework/just-bash';
 * import { justGitBackend, sqliteGitStorage } from '@ambionframework/just-bash/git';
 * import { openWorkspace } from '@ambionframework/workspace';
 * import { fromDirectory } from '@ambionframework/workspace/git';
 *
 * const lab = openWorkspace({
 * 	name: 'lab',
 * 	backend: {
 * 		bash: directoryBackend('./data/lab'),
 * 		git: justGitBackend({
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
 * This entry loads `node:sqlite`, and the root entry of the package does
 * not. The design contract is `docs/git.md`.
 */

export type { JustGitBackend, JustGitBackendOptions } from './backend.ts';
export { justGitBackend } from './backend.ts';
export type { GitStorage, OpenGitStorage, Registry, RegistryRow } from './storage.ts';
export { sqliteGitStorage } from './storage.ts';
