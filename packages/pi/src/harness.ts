/**
 * One Pi `AgentHarness` over one session, set up the way every activation
 * runs it.
 *
 * - **Tools.** The model holds the tools the activation binds, and no other:
 *   no built-in tool, no skill, no prompt template.
 * - **Retries.** The harness tries each provider request once, and so does
 *   the provider client. The room owns every retry.
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
 * process left open is cut before the lane takes a new one.
 */
export async function openHarness(input: HarnessInput): Promise<OpenHarness> {
	const { harness, open } = await Harness.create<undefined>(
		{
			session: input.session,
			models: input.models,
			model: input.model,
			thinkingLevel: 'off',
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
	for (const type of OBSERVED) harness.events.on(type, (event) => input.onEvent(event));
	const lane = await harness.lane(LANE, BACKGROUND_CONTEXT);
	if (open.some((operation) => operation.lane === LANE)) await lane.abort(BACKGROUND_CONTEXT);
	await configure(lane, input);
	return { harness, lane };
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
