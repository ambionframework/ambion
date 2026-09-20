/** Resource-only public entry. It has no runtime dependency on Ambion. */

export type {
	MemoryBackendFile,
	MemoryBackendOptions,
	MemoryWorkspaceBackend,
	SeedWriter,
} from './just-bash.ts';
export { directoryBackend, memoryBackend } from './just-bash.ts';
export type { WorkspaceLog, WorkspaceLogOptions } from './log.ts';
export { DEFAULT_ROTATE_BYTES, openLog } from './log.ts';
export type { ResourceBackend, WorkspaceAgent, WorkspaceResource } from './resource.ts';
export { openResource } from './resource.ts';
