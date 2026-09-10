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

/**
 * Called around every append a session takes: once before it lands and
 * once after. `n` counts the appends to this session id, and `customType`
 * names the entry type of a custom entry. A hook that throws fails the
 * append: before it lands, the entry is nowhere; after, the entry is on
 * the storage and the writer never learns it.
 */
export type AppendHook = (
	id: string,
	n: number,
	phase: 'before' | 'after',
	customType: string | undefined,
) => void;

/** An opener whose every append reports itself to the hook, and fails when the hook throws. */
export function tappedOpener(sessions: SessionOpener, hook: AppendHook): SessionOpener {
	const counts = new Map<string, number>();
	const tapped = (id: string, piSession: PiSession): PiSession =>
		new Proxy(piSession, {
			get(target, property, receiver) {
				if (property === 'appendCustomEntry' || property === 'appendMessage') {
					return async (...args: unknown[]) => {
						const n = (counts.get(id) ?? 0) + 1;
						counts.set(id, n);
						const customType = property === 'appendCustomEntry' ? String(args[0]) : undefined;
						hook(id, n, 'before', customType);
						const append = Reflect.get(target, property, receiver) as (
							...a: unknown[]
						) => Promise<unknown>;
						const result = await append.apply(target, args);
						hook(id, n, 'after', customType);
						return result;
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	return { open: async (id, parentId) => tapped(id, await sessions.open(id, parentId)) };
}

/** When a write fails: before it lands, or after it landed and before the writer hears. */
export type FailMode = false | 'before' | 'after';

export interface FaultyOpener {
	readonly sessions: SessionOpener;
	/**
	 * Every write fails while `on` is set: `true` and `'before'` lose it, `'after'` lands it and
	 * loses the confirmation. `only` narrows the failure to one entry type. Reads and opens keep working.
	 */
	fail(on: boolean | FailMode, only?: string): void;
}

/** An opener whose sessions refuse to write while the test says so. */
export function faultyOpener(sessions: SessionOpener): FaultyOpener {
	let failing: FailMode = false;
	let onlyType: string | undefined;
	return {
		sessions: tappedOpener(sessions, (_id, _n, phase, customType) => {
			if (failing === phase && (onlyType === undefined || onlyType === customType)) {
				throw new Error('the disk is full');
			}
		}),
		fail: (on, only) => {
			failing = on === true ? 'before' : on;
			onlyType = only;
		},
	};
}

// -- a storage that holds a write ---------------------------------------------

/** An opener whose sessions hold one write until the test lets it land. */
export function gatedOpener(
	sessions: SessionOpener,
	held: (customType: string, data: unknown) => Promise<void> | undefined,
): SessionOpener {
	const gated = (piSession: PiSession): PiSession =>
		new Proxy(piSession, {
			get(target, property, receiver) {
				if (property === 'appendCustomEntry') {
					return async (customType: string, data: unknown) => {
						await held(customType, data);
						return (Reflect.get(target, property, receiver) as (...a: unknown[]) => unknown).apply(
							target,
							[customType, data],
						);
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	return { open: async (id, parentId) => gated(await sessions.open(id, parentId)) };
}
