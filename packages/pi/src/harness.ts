/**
 * One pi-durable `Harness` over one session, set up the way every activation
 * runs it.
 *
 * - **Tools.** The model holds the tools the activation binds, and no other:
 *   no built-in tool, no skill, no prompt template. The `ambion` extension
 *   holds them.
 * - **System prompt.** A prompt section with no tag renders the prompt of
 *   the pass that runs now. The model reads the text as the executor
 *   built it.
 * - **Retries.** The retry policy of the harness is off, and so is the retry
 *   of the provider client. The room owns every retry of a failed request.
 * - **Overflow.** A context-overflow error makes the harness compact once and
 *   send the request again, when compaction is on. With compaction off, the
 *   error fails the pass.
 * - **Compaction.** The harness compacts the session with the policy the
 *   executor gives it.
 * - **Freshness.** A hook runs before each request. It reports the record
 *   that the request holds.
 * - **Faults.** The harness reports a fault it cannot recover from, such as
 *   a storage that fails a commit. The pass that waits on it fails.
 * - **Leftovers.** A session that a lost process left open is cut before any
 *   submit.
 */

import type { Seq } from '@ambionframework/ambion/hosting';
import { BACKGROUND_CONTEXT as CONTEXT } from '@earendil-works/chord/context';
import type { Api, Message, Model, Models, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type {
	AgentEventStream,
	CompactionPolicy,
	Conversation,
	Storage,
} from '@earendil-works/pi-durable';
import {
	createRegistry,
	defineExtension,
	GenerationTask,
	Harness,
	hook,
	section,
	watchEvents,
} from '@earendil-works/pi-durable';
import type { PiTool } from './tools.ts';
import { abortLeftovers, resumeBase, rewind } from './transcript.ts';

export interface HarnessInput {
	readonly storage: Storage;
	readonly models: Models;
	readonly model: Model<Api>;
	readonly tools: readonly PiTool[];
	/** The system prompt of the pass that runs now. */
	readonly systemPrompt: () => string;
	readonly compaction: Partial<CompactionPolicy>;
	/** How much the model reasons before it answers. */
	readonly thinking: ModelThinkingLevel;
	/** The clock of the entries. */
	readonly now?: () => number;
	/** Whether the session continues an earlier activation. It then drops what that activation left unanswered. */
	readonly resume: boolean;
	/** Called before each provider request, with the messages the request holds. */
	readonly beforeRequest: (messages: readonly Message[]) => void | Promise<void>;
}

export interface OpenHarness {
	readonly harness: Harness;
	readonly storage: Storage;
	readonly root: Conversation;
	/** The events of the conversation. The caller starts them. */
	readonly events: AgentEventStream;
	/** The position a resumed session read through. */
	readonly base: Seq | undefined;
	readonly trap: Trap;
}

const noop = () => {};

/**
 * The faults the harness reports. A storage that fails a commit poisons the
 * session: the harness reports the error and the work it runs never settles.
 * The trap turns the first report into the failure of whatever waits on the
 * harness.
 */
interface Trap {
	report(error: unknown): void;
	/** Wait for `work`, or fail with the first fault the harness reports. */
	race<T>(work: Promise<T>): Promise<T>;
}

function trap(): Trap {
	let fail: (error: Error) => void = noop;
	const failed = new Promise<never>((_, reject) => {
		fail = reject;
	});
	failed.catch(noop);
	return {
		report: (error) => fail(error instanceof Error ? error : new Error(String(error))),
		race: (work) => Promise.race([work, failed]),
	};
}

/**
 * Open a harness over the storage, and take the root conversation of the
 * session. When it cannot be set up, the harness closes, and the storage
 * with it.
 */
export async function openHarness(input: HarnessInput): Promise<OpenHarness> {
	const faults = trap();
	const extension = defineExtension({
		name: 'ambion',
		tools: [...input.tools],
		sections: [section('prompt', () => input.systemPrompt(), { tag: false })],
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (request) => {
					await input.beforeRequest(request.messages);
					return undefined;
				},
			}),
		],
	});
	const registry = createRegistry();
	registry.install(extension);
	const harness = await Harness.open(
		input.storage,
		{
			models: input.models,
			registry,
			settings: {
				retry: { enabled: false, maxRetries: 0 },
				stream: { maxRetries: 0 },
				compaction: input.compaction,
			},
			...(input.now === undefined ? {} : { now: input.now }),
			onReport: faults.report,
		},
		CONTEXT,
	);
	try {
		const agent = {
			model: { provider: input.model.provider, modelId: input.model.id },
			thinkingLevel: input.thinking,
		};
		const root = await harness.root(CONTEXT, { agent });
		await configure(root, agent);
		await abortLeftovers(harness, root);
		if (input.resume) await rewind(input.storage, root);
		const base = input.resume ? await resumeBase(root) : undefined;
		const events = await watchEvents(harness, root.id, CONTEXT);
		return { harness, storage: input.storage, root, events, base, trap: faults };
	} catch (error) {
		await harness.close(CONTEXT).catch(noop);
		throw error;
	}
}

/**
 * A continued session keeps the model and the thinking level it ran with. It
 * takes those of this activation.
 */
async function configure(
	root: Conversation,
	agent: { model: { provider: string; modelId: string }; thinkingLevel: ModelThinkingLevel },
): Promise<void> {
	const held = await root.agent(CONTEXT);
	const same =
		held.model?.provider === agent.model.provider &&
		held.model.modelId === agent.model.modelId &&
		held.thinkingLevel === agent.thinkingLevel;
	if (!same) await root.configure(agent, CONTEXT);
}

/** Stop the events of the harness, then close it. */
export async function shutdown(opened: OpenHarness): Promise<void> {
	await opened.events.stop().catch(noop);
	await opened.harness.close(CONTEXT);
}
