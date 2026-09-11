/**
 * A workspace backend the core's own suite runs on.
 *
 * The core names `WorkspaceBackend` as a port and holds no filesystem
 * (`docs/workspace.md` §2). Its tests hold none either: what the core owns is
 * the handle, the resolver and the four hands it binds, and none of that
 * reads a file. `@ambionframework/workspace` proves the tools against a real
 * filesystem; this proves the core against the port.
 *
 * Every `ExecutionEnv` member answers the same way: a `Result` that says the
 * environment does nothing. Pi's contract is that a filesystem member never
 * throws and never rejects, so the fake keeps it.
 */
import type {
	ExecutionEnv,
	ExecutionError,
	FileError,
	FileInfo,
	Result,
} from '@earendil-works/pi-agent-core';
import { err } from '@earendil-works/pi-agent-core';
import type { AgentDefinition, WorkspaceBackend } from '../../src/index.ts';

const WHY = 'This environment does nothing: the core tests the port.';

const fileError = (): FileError => ({ code: 'invalid', message: WHY }) as FileError;
const failed = <T>(): Promise<Result<T, FileError>> => Promise.resolve(err(fileError()));

/** One `ExecutionEnv` that answers every call with the same refusal. */
export function fakeEnv(home = '/home/nobody'): ExecutionEnv {
	return {
		cwd: home,
		absolutePath: () => failed<string>(),
		joinPath: () => failed<string>(),
		readTextFile: () => failed<string>(),
		readTextLines: () => failed<string[]>(),
		readBinaryFile: () => failed<Uint8Array>(),
		writeFile: () => failed<void>(),
		appendFile: () => failed<void>(),
		renameFile: () => failed<void>(),
		fileInfo: () => failed<FileInfo>(),
		listDir: () => failed<FileInfo[]>(),
		canonicalPath: () => failed<string>(),
		exists: () => failed<boolean>(),
		createDir: () => failed<void>(),
		remove: () => failed<void>(),
		createTempDir: () => failed<string>(),
		createTempFile: () => failed<string>(),
		exec: () =>
			Promise.resolve(
				err<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>({
					message: WHY,
				} as ExecutionError),
			),
		cleanup: () => Promise.resolve(),
	};
}

/** What a fake backend recorded, so a test reads how often the room connected. */
export interface FakeBackend extends WorkspaceBackend {
	/** Every agent the room connected, in order, once per `ctx.workspace()`. */
	readonly connected: string[];
	readonly destroys: number;
}

/**
 * A backend that builds a fresh environment per connect and counts both calls.
 * `onConnect` replaces what `connect` does, so a test makes it fail or hang.
 */
export function fakeBackend(
	onConnect?: (agent: AgentDefinition) => Promise<ExecutionEnv>,
): FakeBackend {
	const connected: string[] = [];
	let destroys = 0;
	return {
		connected,
		get destroys() {
			return destroys;
		},
		connect: async (agent) => {
			connected.push(agent.name);
			return onConnect ? onConnect(agent) : fakeEnv(`/home/${agent.name}`);
		},
		destroy: async () => {
			destroys += 1;
		},
	};
}
