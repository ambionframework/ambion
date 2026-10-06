/** The canvas store in the memory of one process. */
import {
	archivedRoom,
	type CanvasClose,
	type CanvasRoom,
	type CanvasStore,
	type CanvasWidget,
	missingRoom,
} from './store.ts';

/** A canvas store that a restart loses. A test and a one-shot host use it. */
export function memoryCanvas(): CanvasStore {
	const rows = new Map<string, CanvasRoom>();
	const revisions = new Map<string, CanvasWidget>();
	const row = (name: string): CanvasRoom => {
		const found = rows.get(name);
		if (found === undefined) throw missingRoom(name);
		return found;
	};
	return {
		list: async () => [...rows.values()].map((room) => structuredClone(room)),
		insert: async (room) => {
			if (rows.has(room.name)) return 'exists';
			rows.set(room.name, structuredClone(room));
			return 'inserted';
		},
		setState: async (name, state) => {
			const found = row(name);
			if (found.state === 'archived') throw archivedRoom(name);
			rows.set(name, { ...found, state });
		},
		archive: async (name, close) => {
			const found = row(name);
			if (found.state === 'archived') {
				if (found.close === undefined) throw archivedRoom(name);
				return structuredClone(found.close);
			}
			const recorded: CanvasClose = structuredClone(close);
			rows.set(name, { ...found, state: 'archived', close: recorded });
			return structuredClone(recorded);
		},
		revisions: async () => [...revisions.values()].map((widget) => structuredClone(widget)),
		appendRevision: async (widget) => {
			if (revisions.has(widget.revision)) return 'exists';
			revisions.set(widget.revision, structuredClone(widget));
			return 'inserted';
		},
	};
}
