/**
 * A workstation for Ambion: a `BashBackend` over SSH to one remote server,
 * with one Unix account for each agent, and a `GitBackend` in the home of
 * one more account on the same server.
 *
 * ```ts
 * import { openWorkspace } from '@ambionframework/workspace';
 * import { workstationBackend } from '@ambionframework/workstation';
 *
 * const lab = openWorkspace({
 * 	name: 'lab',
 * 	backend: { bash: workstationBackend({ host, hostKey, layout, credentialFor }) },
 * });
 * ```
 *
 * The design contracts are `docs/workstation.md` and
 * `docs/workstation-git.md`.
 */

export type { WorkstationOptions } from './backend.ts';
export { DEFAULT_IDLE_TIMEOUT_SECONDS, workstationBackend } from './backend.ts';
export type {
	WorkstationGitAccess,
	WorkstationGitIdentity,
	WorkstationGitOptions,
} from './git-backend.ts';
export { workstationGitBackend } from './git-backend.ts';
export type { WorkstationCredential } from './session.ts';
export { fingerprint } from './session.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/workstation';
