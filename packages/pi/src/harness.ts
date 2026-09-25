/**
 * One Pi `AgentHarness` over one session, set up the way every activation
 * runs it.
 *
 * - **Tools.** The model holds the tools the activation binds, and no other:
 *   no built-in tool, no skill, no prompt template.
 * - **Retries.** The retry policy of the harness is off, and so is the retry
 *   of the provider client. The room owns every retry of a failed request.
 * - **Overflow.** A context-overflow error, or a length stop below the output
 *   limit, makes the harness compact once and send the request again. This
 *   happens also when compaction is off. No setting turns it off.
 * - **Compaction.** The harness compacts the session with the settings the
 *   executor gives it.
 * - **Provider input.** The executor turns the session into the messages of
 *   each request, and reads what the request holds of the record.
 */
import type {
	AgentHarness,
	AgentLane,
	AgentMessage,
	CompactionSettings,
	HarnessEvent,
	HarnessEventType,
	Session,
	ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, AgentHarness as Harness } from '@earendil-works/pi-agent-core';
import type { Api, Message, Model, Models } from '@earendil-works/pi-ai';
import type { PiTool } from './tools.ts';

/** The one lane every activation runs on. */
const LANE = 'main';

/** The events an activation reads. */
const OBSERVED: readonly HarnessEventType[] = [
	'message_start',
	'message_update',
	'message_end',
	'tool_start',
	'tool_end',
	'usage',
];

export interface HarnessInput {
	readonly session: Session;
	readonly models: Models;
	readonly model: Model<Api>;
	readonly tools: readonly PiTool[];
	/** The system prompt of the pass that runs now. */
	readonly systemPrompt: () => string;
	readonly compaction: CompactionSettings;
	/** How much the model reasons before it answers. */
	readonly thinking: ThinkingLevel;
	/** The provider messages of one request. */
	readonly toProviderMessages: (messages: AgentMessage[]) => Message[];
	readonly onEvent: (event: HarnessEvent) => void;
}

export interface OpenHarness {
	readonly harness: AgentHarness<undefined>;
	readonly lane: AgentLane;
}

/**
 * Attach a harness to the session and take its lane. A run that a lost
 * process left open is cut before the lane takes a new one. The harness
 * settles the cut run with recovery events, and the activation reads none
 * of them. When the lane
 * cannot be set up, the harness closes, and the session with it.
 */
export async function openHarness(input: HarnessInput): Promise<OpenHarness> {
	const { harness, open } = await Harness.create<undefined>(
		{
			session: input.session,
			models: input.models,
			model: input.model,
			thinkingLevel: input.thinking,
			tools: [...input.tools],
			activeToolNames: input.tools.map((tool) => tool.name),
			systemPrompt: () => input.systemPrompt(),
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
			streamOptions: { maxRetries: 0 },
			compaction: input.compaction,
			toProviderMessages: (messages) => input.toProviderMessages(messages),
		},
		BACKGROUND_CONTEXT,
	);
	try {
		const lane = await harness.lane(LANE, BACKGROUND_CONTEXT);
		if (open.some((operation) => operation.lane === LANE)) await lane.abort(BACKGROUND_CONTEXT);
		// The events of the cut run belong to no activation: the activation listens from here.
		for (const type of OBSERVED) harness.events.on(type, (event) => input.onEvent(event));
		await configure(lane, input);
		return { harness, lane };
	} catch (error) {
		// The harness closes the session with it.
		await Promise.allSettled([harness.close(BACKGROUND_CONTEXT)]);
		throw error;
	}
}

/**
 * A lane keeps its model and its tools in the session. A continued session
 * takes the model and the tools of this activation: a closing activation
 * holds fewer tools than the response before it.
 */
async function configure(lane: AgentLane, input: HarnessInput): Promise<void> {
	const names = input.tools.map((tool) => tool.name);
	const held = await lane.getActiveTools(BACKGROUND_CONTEXT);
	if (held.join('\u0000') !== names.join('\u0000')) {
		await lane.setActiveTools(names, BACKGROUND_CONTEXT);
	}
	const model = await lane.getModel(BACKGROUND_CONTEXT);
	if (model?.provider !== input.model.provider || model.id !== input.model.id) {
		await lane.setModel(
			{ provider: input.model.provider, modelId: input.model.id },
			BACKGROUND_CONTEXT,
		);
	}
}
