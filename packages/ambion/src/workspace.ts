/**
 * The workspace: the identity and data boundary an agent connects to when it
 * is defined.
 *
 * A session has no storage of its own; its record holds what was said. A
 * workspace is the missing layer: a container of persistent entities, durable
 * by its own name, that a connected agent's tools reach into. A tool holds no
 * raw handle onto whatever backs it. It calls `ctx.workspace()` and receives a
 * `Workspace` value the runtime built for that agent, fresh on every call.
 *
 * Three things live here, and nothing else:
 *
 * - **The handle.** `defineWorkspace` names one; `destroyWorkspace` retires it
 *   for good. Nothing about a workspace runs, so there is nothing to start.
 * - **The resolver.** `toolContext` is what every `defineTool` `execute`
 *   receives as its second argument, and `ctx.workspace()` is the one caller
 *   of a backend's `connect`.
 * - **The built-in tools.** Pi's own `read`, `write`, `edit` and `bash`,
 *   bound to a connected agent's activation with the one argument Pi's tool is
 *   missing: the environment the workspace built for that agent. Beside them,
 *   `remind` and `cancel_reminder`, which reach the reminders the workspace
 *   holds for that agent (`reminder.ts`).
 *
 * The design contract is docs/workspace.md.
 */
import type {
	AgentHarnessTool,
	AgentTool,
	ExecutionToolContext,
} from '@earendil-works/pi-agent-core';
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from '@earendil-works/pi-agent-core';
import { memoryBackend } from './just-bash.ts';
import {
	type Clock,
	cancelReminderTool,
	type Reach,
	remindersFor,
	remindTool,
} from './reminder.ts';
import {
	type AgentDefinition,
	isWorkspace,
	type ReminderStore,
	type ToolContext,
	WORKSPACE_BRAND,
	type Workspace,
	type WorkspaceBackend,
	type WorkspaceHandle,
} from './types.ts';

/** The names a workspace binds to every connected agent. `defineAgent` keeps them free. */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
	'read',
	'write',
	'edit',
	'bash',
	'remind',
	'cancel_reminder',
]);

/** One handle per name: two handles over one backend would each destroy it. */
const taken = new Set<string>();

/** What the public handle does not show: its backend, and whether it is gone. */
interface WorkspaceState extends WorkspaceHandle {
	readonly backend: WorkspaceBackend;
	destroyed: boolean;
}

export interface DefineWorkspaceOptions {
	/** The workspace's durable identity. The same name reaches the same workspace. */
	name: string;
	/**
	 * What backs the workspace. Without it, the handle holds an in-memory
	 * just-bash filesystem of its own. `directoryBackend` writes through to a
	 * real directory.
	 */
	backend?: WorkspaceBackend;
}

/**
 * Names a workspace. Synchronous, and usable at once: everything a workspace
 * does for an agent happens later, inside the backend's `connect`, when a
 * tool first asks for it.
 */
export function defineWorkspace(options: DefineWorkspaceOptions): WorkspaceHandle {
	assertWorkspaceName(options.name);
	if (taken.has(options.name)) {
		throw new Error(
			`Workspace '${options.name}' is already defined: destroy it before defining it again.`,
		);
	}
	const state: WorkspaceState = {
		[WORKSPACE_BRAND]: true,
		name: options.name,
		backend: options.backend ?? memoryBackend(),
		destroyed: false,
	};
	taken.add(options.name);
	return state;
}

/**
 * Retires a workspace for good. The handle is marked destroyed first, so a
 * tool call that lands while the backend deletes resolves undefined and a
 * second call on the same handle does nothing. The backend then performs the
 * hard deletion, and the name comes free. A backend that fails to delete
 * leaves the workspace live, and the caller sees the failure.
 */
export async function destroyWorkspace(workspace: WorkspaceHandle): Promise<void> {
	const state = stateOf(workspace);
	if (state.destroyed) return;
	state.destroyed = true;
	try {
		await state.backend.destroy();
	} catch (error) {
		state.destroyed = false;
		throw error;
	}
	taken.delete(state.name);
}

function stateOf(workspace: WorkspaceHandle): WorkspaceState {
	if (!isWorkspace(workspace)) throw new Error('Workspaces must come from defineWorkspace.');
	return workspace as WorkspaceState;
}

/** The reminders a workspace holds, for the room that arms them. Nothing, once destroyed. */
export function reminderStoreOf(workspace: WorkspaceHandle): ReminderStore | undefined {
	const state = stateOf(workspace);
	return state.destroyed ? undefined : state.backend.reminders;
}

function assertWorkspaceName(name: string): void {
	if (!/^[a-z][a-z0-9-]*$/.test(name)) {
		throw new Error(
			`Invalid workspace name '${name}': names are lowercase, alphanumeric plus dashes.`,
		);
	}
}

// -- reaching a workspace from a tool ---------------------------------------

/**
 * What a tool's `execute` receives beside its parameters. `workspace()`
 * resolves fresh on every call and caches nothing, so a destroy mid-activation
 * is visible to the very next call, and two agents' calls running in parallel
 * each build their own environment from their own agent's field. The clock is
 * the run's: a reminder set through the value is armed in that run.
 */
export function toolContext(
	agent: AgentDefinition,
	clock: Clock,
	signal?: AbortSignal,
): ToolContext {
	return {
		signal,
		workspace: () => connect(agent, clock, signal),
	};
}

/**
 * The one caller of a backend's `connect`. Three steps, in order: no field,
 * resolve undefined; a destroyed handle, resolve undefined; otherwise build
 * the agent's environment. A `connect` failure is the tool call's failure.
 */
async function connect(
	agent: AgentDefinition,
	clock: Clock,
	signal?: AbortSignal,
): Promise<Workspace | undefined> {
	if (agent.workspace === undefined) return undefined;
	const state = stateOf(agent.workspace);
	if (state.destroyed) return undefined;
	const env = await state.backend.connect(agent, signal);
	return {
		name: state.name,
		env,
		reminders: remindersFor(agent.name, state.backend.reminders, clock),
	};
}

// -- the built-in tools ------------------------------------------------------

/** Pi's tool shape with the harness context it takes as its fifth argument. */
type BuiltinTool = AgentHarnessTool<ExecutionToolContext>;

/**
 * The hands a workspace gives an agent: Pi's own `read`, `write`, `edit` and
 * `bash`, unmodified, bound to this agent, and `remind` and `cancel_reminder`
 * over the reminders the workspace holds for it. An agent with no workspace
 * gets none; an agent with one gets all six, on every activation.
 */
export function builtinTools(agent: AgentDefinition, clock: Clock): AgentTool[] {
	if (agent.workspace === undefined) return [];
	const builtins: BuiltinTool[] = [
		createReadTool(),
		createWriteTool(),
		createEditTool(),
		createBashTool(),
	];
	const reach: Reach = async (signal) => (await live(agent, clock, signal)).reminders;
	return [
		...builtins.map((tool) => bind(tool, agent, clock)),
		remindTool(reach),
		cancelReminderTool(reach),
	];
}

/** A built-in reaches a workspace that is there, or fails the call: a destroyed handle is the one way it is not. */
async function live(
	agent: AgentDefinition,
	clock: Clock,
	signal?: AbortSignal,
): Promise<Workspace> {
	const workspace = await connect(agent, clock, signal);
	if (workspace === undefined) {
		throw new Error(`Workspace '${agent.workspace?.name}' is destroyed: nothing to reach.`);
	}
	return workspace;
}

/**
 * Supply the one argument Pi's tool is missing, fresh on every call. The
 * spread carries `prepareArguments` along. `executionMode: 'sequential'`
 * answers a problem a fresh environment per call creates: Pi serialises
 * mutations to one file through a queue keyed on the environment object, so
 * two edits to one file in one parallel batch would each get an empty queue
 * and one edit would be lost. Running the batch one call at a time restores
 * the order the queue gave.
 */
function bind(tool: BuiltinTool, agent: AgentDefinition, clock: Clock): AgentTool {
	const bound: AgentTool['execute'] = async (toolCallId, params, signal, onUpdate) => {
		const workspace = await live(agent, clock, signal);
		return tool.execute(toolCallId, params, signal, onUpdate, { env: workspace.env });
	};
	return { ...tool, executionMode: 'sequential', execute: bound } as AgentTool;
}
