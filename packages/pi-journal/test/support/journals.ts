/** Journal openers that let a test change what one storage does. */
import type { JournalOpener, JournalStorage } from '@ambionframework/journal';

/** A journal opener over `base`. `wrap` replaces the storage methods it returns; the rest stay. */
export function wrapped(
	base: JournalOpener,
	wrap: (storage: JournalStorage, name: string) => Partial<JournalStorage>,
): JournalOpener {
	return {
		async open(name) {
			const storage = await base.open(name);
			return {
				read: storage.read.bind(storage),
				append: storage.append.bind(storage),
				...wrap(storage, name),
			};
		},
	};
}

/** Whether a stored value records one session entry, the write that an entry append makes. */
export const isEntryWrite = (value: unknown): boolean =>
	typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'entry';
