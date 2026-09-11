/** Filesystem-backed workspace adapters for Node.js hosts. */
export type {
	MemoryBackendFile,
	MemoryBackendOptions,
	MemoryWorkspaceBackend,
	SeedWriter,
} from './tools/just-bash.ts';
export { directoryBackend, memoryBackend } from './tools/just-bash.ts';
