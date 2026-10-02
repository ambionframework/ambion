/** Session storage that a test seeds with entries, or breaks on cue. */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import {
	type Conversation,
	createRegistry,
	type EntryDraft,
	type EntryRecord,
	Harness,
	ROOT_CONVERSATION_ID,
	type Storage,
} from '@earendil-works/pi-durable';
import type { PiSessions, SessionScope } from '../../src/sessions.ts';

/**
 * Create the session `id` and write `entries` to its root conversation, as a
 * past activation would have. The harness closes after the write, and
 * `sessions.open` reopens the session.
 */
export async function seed(
	sessions: PiSessions,
	scope: SessionScope,
	id: string,
	entries: readonly EntryDraft[],
): Promise<void> {
	const { storage } = await sessions.create(scope, id);
	const harness = await Harness.open(
		storage,
		{ models: createModels(), registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	const root = await harness.root(BACKGROUND_CONTEXT);
	for (const entry of entries) {
		await (
			await root.submit({ type: 'write', entry }, BACKGROUND_CONTEXT)
		).wait(BACKGROUND_CONTEXT);
	}
	await harness.close(BACKGROUND_CONTEXT);
}

/** The storage, with each method in `methods` failing while `broken` answers true. `'*'` names every method. */
export function failing(
	storage: Storage,
	methods: readonly string[],
	broken: () => boolean,
): Storage {
	return new Proxy(storage, {
		get(target, property, receiver) {
			const value: unknown = Reflect.get(target, property, receiver);
			if (typeof value !== 'function') return value;
			if (typeof property === 'string' && (methods.includes('*') || methods.includes(property))) {
				return (...args: unknown[]) =>
					broken()
						? Promise.reject(new Error('The disk failed.'))
						: Reflect.apply(value, target, args);
			}
			return value.bind(target);
		},
	});
}

/** Every entry of the root conversation, oldest first, including the omitted ones. */
export async function entriesIn(storage: Storage): Promise<EntryRecord[]> {
	const page = await storage.scanEntries(
		{ conversationId: ROOT_CONVERSATION_ID },
		10_000,
		undefined,
		BACKGROUND_CONTEXT,
	);
	return [...page.items].sort((left, right) => left.id - right.id);
}

/** Open the session `id` under a harness, give its root conversation to `use`, and close the harness. */
export async function withRoot<T>(
	sessions: PiSessions,
	scope: SessionScope,
	id: string,
	use: (root: Conversation) => Promise<T>,
): Promise<T> {
	const storage = await sessions.open(scope, id);
	if (storage === undefined) throw new Error('The session is gone.');
	const harness = await Harness.open(
		storage,
		{ models: createModels(), registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	try {
		return await use(await harness.root(BACKGROUND_CONTEXT));
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}
