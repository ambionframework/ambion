/**
 * What a session holds that the next activation must read or give up.
 *
 * - **Leftovers.** A process that dies mid-pass leaves work in the storage:
 *   a generation, a tool call, a placed input. `abortLeftovers` ends it
 *   before the first submit, so no request and no tool runs for it.
 * - **Rewind.** A pass that fails, is cut, or ends with a steer that no
 *   request held leaves entries after the last answer. `rewind` omits them
 *   from the model context. Their ranges of the record come again in the
 *   next delta, and the model reads each once.
 * - **Base.** The position a resumed session read through is the largest
 *   `through` of its range entries that stay in the context.
 */
import type { Seq } from '@ambionframework/ambion/hosting';
import { BACKGROUND_CONTEXT as CONTEXT } from '@earendil-works/chord/context';
import type {
	Conversation,
	EntryId,
	EntryRecord,
	Harness,
	Storage,
} from '@earendil-works/pi-durable';
import { OMIT, omitDraft, omittedIn, RECORD, rangeOf } from './freshness.ts';

/** The entries a failed or cut pass leaves, and that `rewind` omits. */
const REWOUND: ReadonlySet<string> = new Set(['pi.user', 'pi.assistant', 'pi.tool-result', RECORD]);

/** How many entries one scan page holds. */
const PAGE = 256;

/** Every entry of the conversation, oldest first, including the omitted ones. */
export async function entriesOf(root: Conversation): Promise<EntryRecord[]> {
	const entries: EntryRecord[] = [];
	let cursor: Awaited<ReturnType<Conversation['entries']>>['next'];
	do {
		const page = await root.entries({}, PAGE, cursor, CONTEXT);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return entries.sort((left, right) => left.id - right.id);
}

/**
 * End the work a lost process left in the storage. The harness opens with
 * that work still in it, and starts none. Each placed or queued input
 * settles, and the conversation aborts its generation and its tool calls
 * before any of them sends a request or runs a tool.
 */
export async function abortLeftovers(harness: Harness, root: Conversation): Promise<void> {
	const found = await harness.inspect(CONTEXT);
	if (found.tasks.length === 0 && found.submissions.length === 0) return;
	for (const submission of found.submissions) {
		await harness.abortSubmission(submission.id, CONTEXT, root.id);
	}
	// A crashed compaction is a background task: the plain abort leaves it.
	await root.abort(CONTEXT, { background: true });
}

/** The later of two entries, either of which may be missing. */
const newer = (left: EntryId | undefined, right: EntryId | undefined): EntryId | undefined =>
	left === undefined || (right !== undefined && right > left) ? right : left;

/** The newest entry that answered an input, or nothing before the first answer. */
async function lastAnswer(storage: Storage, root: Conversation): Promise<EntryId | undefined> {
	let answer: EntryId | undefined;
	let cursor: Awaited<ReturnType<Storage['scanSubmissions']>>['next'];
	do {
		const page = await storage.scanSubmissions(
			{ conversationId: root.id, status: 'done' },
			PAGE,
			cursor,
			CONTEXT,
		);
		for (const submission of page.items) {
			const found = submission.type === 'input' ? submission.answer : undefined;
			answer = newer(answer, found);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return answer;
}

/** The ids of the tool calls the message of `entry` makes. */
function callsOf(entry: EntryRecord | undefined): ReadonlySet<string> {
	const calls = new Set<string>();
	for (const message of entry?.model ?? []) {
		if (message.role !== 'assistant') continue;
		for (const part of message.content) if (part.type === 'toolCall') calls.add(part.id);
	}
	return calls;
}

/** Whether `entry` is the result of a tool call that `calls` holds. */
function resultOf(entry: EntryRecord, calls: ReadonlySet<string>): boolean {
	return (
		entry.kind === 'pi.tool-result' &&
		(entry.model ?? []).some(
			(message) => message.role === 'toolResult' && calls.has(message.toolCallId),
		)
	);
}

/**
 * Omit what the session holds after its last answer. A pass that ended with
 * an answer leaves its entries in the context. A pass that did not leaves
 * its input, its failed message, its tool results, and its steered lines:
 * the model must not read them as part of the exchange, and the delta that
 * follows carries their text again. The tool results of the answer stay,
 * because an answer that calls a tool that ends the activation owns them.
 * An entry that an earlier rewind omitted stays omitted.
 */
export async function rewind(storage: Storage, root: Conversation): Promise<void> {
	const [entries, answer] = await Promise.all([entriesOf(root), lastAnswer(storage, root)]);
	const omitted = omittedIn(entries);
	const calls = callsOf(entries.find((entry) => entry.id === answer));
	const targets = entries
		.filter((entry) => answer === undefined || entry.id > answer)
		.filter((entry) => REWOUND.has(entry.kind) && !omitted.has(entry.id) && !resultOf(entry, calls))
		.map((entry) => entry.id);
	if (targets.length === 0) return;
	const submission = await root.submit({ type: 'write', entry: omitDraft(targets) }, CONTEXT);
	const settled = await submission.wait(CONTEXT);
	if (settled.status === 'unanswered')
		throw new Error(`The session cannot rewind: ${settled.reason}.`);
}

/**
 * The position a resumed session read through: the largest `through` of the
 * range entries that stay in the context. Nothing, when the session holds
 * none, and the activation then reads the whole view once.
 */
export async function resumeBase(root: Conversation): Promise<Seq | undefined> {
	const entries = await entriesOf(root);
	const omitted = omittedIn(entries);
	let base: Seq | undefined;
	for (const entry of entries) {
		const range = entry.kind === OMIT || omitted.has(entry.id) ? undefined : rangeOf(entry);
		if (range !== undefined && (base === undefined || range.through > base)) base = range.through;
	}
	return base;
}
