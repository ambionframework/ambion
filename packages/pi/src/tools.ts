/**
 * The room tools of one activation, and the agent's own tools, as pi-durable
 * tool registrations.
 *
 * The core binds the room tools to the activation: what each one commits
 * and what the model reads. A tool answers with an error result and never
 * throws, so the harness records the text the model reads. A result that
 * ends the activation sets `control.terminate`. The agent's own tools keep
 * their Pi fields: the harness prepares and checks the arguments, and passes
 * the signal of the pass and the updates.
 *
 * **Output limits.** pi-durable bounds a tool result to 50 KiB and 2000
 * lines unless the tool sets `outputLimits`. Every tool here sets the limits
 * to the largest safe integer. The tool owns the size of its result, as it
 * did before, and a result reaches the model whole.
 */
import type { AmbionTool, ToolContext, ToolUpdate } from '@ambionframework/ambion';
import { contentText } from '@ambionframework/ambion';
import type { ActivationView, AgentDefinition, BoundTool } from '@ambionframework/ambion/hosting';
import { toolContext } from '@ambionframework/ambion/hosting';
import type { ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';

/** A tool registration of the harness. */
export type PiTool = ToolRegistration;

/** The output limits of every tool: the tool bounds its own result. */
export const UNBOUNDED = Object.freeze({
	maxBytes: Number.MAX_SAFE_INTEGER,
	maxLines: Number.MAX_SAFE_INTEGER,
});

/** An error result with a text the model reads. */
function failure(message: string): ToolExecutionResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

/** The message of a thrown value. */
const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** A tool registration from a room tool. */
function fromRoomTool(tool: BoundTool): PiTool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		outputLimits: UNBOUNDED,
		execute: async (args, api): Promise<ToolExecutionResult> => {
			const result = await tool.run(args, api.callId);
			const content = [...result.content];
			if (result.terminate) return { content, control: { terminate: true } };
			return result.isError ? { content, isError: true } : { content };
		},
	};
}

/** The context one call of a normalized tool receives. */
export type ContextOf = (
	call: string,
	signal: AbortSignal | undefined,
	onUpdate?: ToolUpdate,
) => ToolContext;

/** The details of a result, when they are JSON. */
function jsonDetails(details: unknown): ToolExecutionResult['details'] {
	if (details === undefined) return undefined;
	try {
		return JSON.parse(JSON.stringify(details)) ?? undefined;
	} catch {
		return undefined;
	}
}

/** The execution result of what a normalized tool returned. */
function toExecution(result: Awaited<ReturnType<AmbionTool['invoke']>>): ToolExecutionResult {
	if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
	const details = jsonDetails(result.details);
	return {
		content: [...result.content],
		...(details === undefined ? {} : { details }),
		...(result.terminate === true ? { control: { terminate: true } } : {}),
	};
}

/**
 * A tool registration from a normalized tool. `contextOf` gives each call its
 * context. A tool that throws gives an error result, and an abort of the
 * call throws on, so the harness records the abort.
 */
export function fromAmbionTool(tool: AmbionTool, contextOf: ContextOf): PiTool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		outputLimits: UNBOUNDED,
		...(tool.prepareArguments === undefined
			? {}
			: { prepareArguments: (args: unknown) => tool.prepareArguments?.(args) }),
		...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
		execute: async (args, api, context): Promise<ToolExecutionResult> => {
			const signal = context.abortSignal;
			const onUpdate: ToolUpdate = (partial) => {
				try {
					api.output(contentText(partial.content));
				} catch {
					// A report that fails costs the tool nothing.
				}
			};
			try {
				return toExecution(await tool.invoke(args, contextOf(api.callId, signal, onUpdate)));
			} catch (error) {
				if (signal?.aborted) throw error;
				return failure(messageOf(error));
			}
		},
	};
}

/**
 * A tool registration from a normalized tool. The tool reads the view of the
 * pass that runs it, so the room and the open exchange it names are current.
 */
function toPiTool(tool: AmbionTool, agent: AgentDefinition, current: () => ActivationView): PiTool {
	return fromAmbionTool(tool, (call, signal, onUpdate) =>
		toolContext(agent, current(), call, signal, onUpdate),
	);
}

/**
 * What an activation holds from its purpose: the room tools the core bound,
 * and the tools of the definition. `current` names the view of the running
 * pass, and defaults to the view the tools are built from.
 *
 * `pass.tools` holds the room tools and the tools of the definition. Pi
 * hosts the room tools from it: the tools that the definition does not name.
 * It builds each tool of the definition from its `AmbionTool`, because a
 * `BoundTool` does not carry what the harness does with the tool:
 *
 * - The harness applies `prepareArguments` before it checks the arguments
 *   against the schema. A `BoundTool` applies it after the check.
 * - The harness runs a batch in turn when a tool sets `executionMode` to
 *   `sequential`.
 * - The harness gives the tool the update callback, and the abort signal of
 *   the pass.
 * - The harness keeps `details` and `terminate` of the result. A `BoundTool`
 *   gives the content alone.
 *
 * The context of each call comes from `toolContext`, as it does in the core.
 */
export function toolsFor(
	view: ActivationView,
	def: AgentDefinition,
	tools: readonly BoundTool[],
	current: () => ActivationView = () => view,
): PiTool[] {
	const own = new Set(def.executor.tools.map((tool) => tool.name));
	const room = tools.filter((tool) => !own.has(tool.name)).map(fromRoomTool);
	if (view.spec.purpose.kind === 'summarize') return room;
	return [...room, ...def.executor.tools.map((tool) => toPiTool(tool, def, current))];
}
