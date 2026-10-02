import { type Message, parseSnapshotUri } from '@ambionframework/ambion';
import type { Workspace } from '@ambionframework/workspace';

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function image(bytes: Uint8Array): boolean {
	return (
		Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
		(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
	);
}

function fileRef(file: unknown): string | undefined {
	if (!record(file) || typeof file.ref !== 'string') return undefined;
	return parseSnapshotUri(file.ref) ? file.ref : undefined;
}

function manifestRefs(bytes: Uint8Array): string[] {
	const manifest: unknown = JSON.parse(Buffer.from(bytes).toString());
	if (!record(manifest) || manifest.api !== 1 || typeof manifest.sensor !== 'string') return [];
	if (!Array.isArray(manifest.files)) return [];
	return manifest.files.map(fileRef).filter((ref): ref is string => ref !== undefined);
}

/** Resolve immutable message refs, never substituting a newer preview frame. */
export function referenceImages(workspace: Pick<Workspace, 'readSnapshot'>) {
	const cache = new Map<string, Promise<readonly Uint8Array[]>>();
	const messages = new Map<number, readonly Uint8Array[]>();
	async function read(ref: string): Promise<readonly Uint8Array[]> {
		if (!parseSnapshotUri(ref)) return [];
		const bytes = await workspace.readSnapshot(ref);
		if (image(bytes)) return [bytes];
		if (!ref.endsWith('/manifest.json')) return [];
		return readFrames(bytes);
	}
	async function readFrames(bytes: Uint8Array): Promise<readonly Uint8Array[]> {
		const frames: Uint8Array[] = [];
		for (const file of manifestRefs(bytes)) {
			const content = await workspace.readSnapshot(file);
			if (image(content)) frames.push(content);
		}
		return frames;
	}
	function resolve(ref: string) {
		let pending = cache.get(ref);
		if (!pending) {
			pending = read(ref);
			cache.set(ref, pending);
		}
		return pending;
	}
	return {
		get(message: Message) {
			return messages.get(message.seq) ?? [];
		},
		async load(items: readonly Message[]) {
			for (const message of items) {
				if (messages.has(message.seq) || !('refs' in message)) continue;
				const frames = await Promise.all((message.refs ?? []).map(resolve));
				messages.set(message.seq, [...new Set(frames.flat())]);
			}
		},
	};
}
