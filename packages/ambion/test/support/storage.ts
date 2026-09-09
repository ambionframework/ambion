/**
 * The storages and the workspace backends every scenario runs on.
 *
 * `memory` is Pi's in-memory repository; `jsonl` is Pi's JSONL repository
 * over a temporary directory, through Pi's own Node filesystem. A room on
 * JSONL writes through to disk, so a second runtime over the same directory
 * reads what the first wrote.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session as PiSession } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
	directoryBackend,
	InMemorySessionRepo,
	JsonlSessionRepo,
	memoryBackend,
	type SessionOpener,
	sessionsOver,
	type WorkspaceBackend,
} from '../../src/index.ts';

export interface OpenedStorage {
	readonly sessions: SessionOpener;
	/** The directory a JSONL storage writes under; absent for memory. */
	readonly dir?: string;
	dispose(): Promise<void>;
}

export interface Storage {
	readonly name: 'memory' | 'jsonl';
	open(): Promise<OpenedStorage>;
}

export const memory: Storage = {
	name: 'memory',
	async open() {
		return { sessions: sessionsOver(new InMemorySessionRepo()), dispose: async () => {} };
	},
};

/**
 * A JSONL opener over one directory. Pi's JSONL repository takes an id of
 * letters, digits, `.`, `_` and `-`, and a seat's audit session is named
 * `<room>:<seat>`; the colon is written as `--` on disk, and only there.
 */
export function jsonlSessions(dir: string): SessionOpener {
	const fs = new NodeExecutionEnv({ cwd: dir });
	const repo = new JsonlSessionRepo({ fs, sessionsRoot: join(dir, 'sessions') });
	const base = sessionsOver(repo, { cwd: dir });
	const onDisk = (id: string) => id.replaceAll(':', '--');
	return {
		open: (id, parentId) =>
			base.open(onDisk(id), parentId === undefined ? undefined : onDisk(parentId)),
	};
}

export const jsonl: Storage = {
	name: 'jsonl',
	async open() {
		const dir = await mkdtemp(join(tmpdir(), 'ambion-jsonl-'));
		return {
			sessions: jsonlSessions(dir),
			dir,
			dispose: () => rm(dir, { recursive: true, force: true }),
		};
	},
};

export const storages: readonly Storage[] = [memory, jsonl];

// -- workspace backends ------------------------------------------------------

export interface Backend {
	readonly name: 'memory' | 'directory';
	open(): Promise<{ backend: WorkspaceBackend; dispose(): Promise<void> }>;
}

export const backends: readonly Backend[] = [
	{
		name: 'memory',
		async open() {
			return { backend: memoryBackend(), dispose: async () => {} };
		},
	},
	{
		name: 'directory',
		async open() {
			const dir = await mkdtemp(join(tmpdir(), 'ambion-drive-'));
			return {
				backend: directoryBackend(dir),
				dispose: () => rm(dir, { recursive: true, force: true }),
			};
		},
	},
];

// -- a storage that fails ----------------------------------------------------

export interface FaultyOpener {
	readonly sessions: SessionOpener;
	/** Every write fails while `on` is true. Reads and opens keep working. */
	fail(on: boolean): void;
}

/** An opener whose sessions refuse to write while the test says so. */
export function faultyOpener(sessions: SessionOpener): FaultyOpener {
	let failing = false;
	const refuse = () => {
		if (failing) throw new Error('the disk is full');
	};
	const brittle = (piSession: PiSession): PiSession =>
		new Proxy(piSession, {
			get(target, property, receiver) {
				if (property === 'appendCustomEntry' || property === 'appendMessage') {
					return async (...args: unknown[]) => {
						refuse();
						return (Reflect.get(target, property, receiver) as (...a: unknown[]) => unknown).apply(
							target,
							args,
						);
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	return {
		sessions: { open: async (id, parentId) => brittle(await sessions.open(id, parentId)) },
		fail: (on) => {
			failing = on;
		},
	};
}
