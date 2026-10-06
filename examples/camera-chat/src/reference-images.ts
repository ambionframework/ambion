import { type Message, parseSnapshotUri } from '@ambionframework/ambion';
import type { Workspace } from '@ambionframework/workspace';

function image(bytes: Uint8Array): boolean {
	return (
		Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
		(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
	);
}

/** Resolve immutable message refs, never substituting a newer preview frame. */
export function referenceImages(workspace: Pick<Workspace, 'readSnapshot'>) {
	const cache = new Map<string, Promise<readonly Uint8Array[]>>();
	const messages = new Map<number, readonly Uint8Array[]>();
	async function read(ref: string): Promise<readonly Uint8Array[]> {
		if (!parseSnapshotUri(ref)) return [];
		const bytes = await workspace.readSnapshot(ref);
		return image(bytes) ? [bytes] : [];
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
