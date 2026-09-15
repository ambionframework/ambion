/**
 * The values you write before a room exists.
 *
 * An agent, a person, a tool, and where a seat sits on the attention scale.
 * None of them starts anything or holds any state: a definition is a value,
 * and the same one is the quiet corner in one room and the one who meets
 * people in another. What each refuses is as much of the contract as what it
 * takes — a name the room can address, a workspace tool name kept free.
 */
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { type Static, type TSchema, Type } from 'typebox';
import {
	AGENT_BRAND,
	type AgentDefinition,
	type AmbionTool,
	type Attention,
	BUILTIN_TOOL_NAMES,
	HUMAN_BRAND,
	type HumanDefinition,
	isAgent,
	isWorkspace,
	SEAT_BRAND,
	type SeatedAgent,
	TOOL_BRAND,
	type ToolContext,
	type WorkspaceHandle,
} from './types.ts';

export interface DefineAgentOptions {
	/** Identifies the agent inside a session and on the record. */
	name: string;
	/** The agent's public face — injected into every participant's context as part of the roster. */
	identity: string;
	/** The private half: the agent's own voice, and the home of all judgment. */
	instructions: string;
	/** A Pi model identifier, `provider/model-id`. */
	model: string;
	/** The agent's own tools, defined with `defineTool` (or Pi's own — both work unchanged). */
	tools?: readonly unknown[];
	/**
	 * The workspace the agent reaches through its tools, from `defineWorkspace`.
	 * Naming one binds `read`, `write`, `edit` and `bash` to every activation,
	 * and gives every tool a `ctx.workspace()` that resolves to it.
	 */
	workspace?: WorkspaceHandle;
}

export function defineAgent(options: DefineAgentOptions): AgentDefinition {
	assertName(options.name);
	const tools = options.tools ?? [];
	if (options.workspace !== undefined) assertWorkspace(options.name, options.workspace);
	assertAgentTools(options.name, tools, options.workspace !== undefined);
	return {
		[AGENT_BRAND]: true,
		name: options.name,
		identity: options.identity,
		instructions: options.instructions,
		model: options.model,
		tools,
		...(options.workspace === undefined ? {} : { workspace: options.workspace }),
	};
}

/**
 * A workspace reaches an agent as a handle `defineWorkspace` wrote. A plain
 * object under the field answers no port, and it fails at the first tool
 * call. The check is where the host names the workspace.
 */
function assertWorkspace(agent: string, workspace: WorkspaceHandle): void {
	if (!isWorkspace(workspace)) {
		throw new Error(`The workspace for '${agent}' must come from defineWorkspace.`);
	}
}

export interface DefineHumanOptions {
	name: string;
	/** How the room knows them — agents read it and address them accordingly. */
	identity: string;
	/**
	 * How they read: what a message to them leads with, what to cut, and how
	 * much of one they take. The room's assistant reads it when it writes the
	 * one message they read at the close of their exchange. What they own is
	 * `identity`, which every seat reads; this reaches the assistant alone.
	 */
	preferences?: string;
}

export function defineHuman(options: DefineHumanOptions): HumanDefinition {
	assertName(options.name);
	const preferences = options.preferences?.trim() || undefined;
	return {
		[HUMAN_BRAND]: true,
		name: options.name,
		identity: options.identity,
		...(preferences === undefined ? {} : { preferences }),
	};
}

/** The attention a seating chooses. */
export interface SeatingOptions {
	/** The widest kind of message that wakes the seat. `broadcast` by default. */
	attention?: Attention;
}

/**
 * Seat one agent at one point of the attention scale. The
 * general form; `passive` and `attentive` are the two points of attention
 * worth a name of their own, and `broadcast` is what a bare agent in
 * `agents` gets.
 *
 * choice belongs to the seating rather than to the agent, so the same
 * definition is the quiet corner in one room and the one who meets people
 * in another.
 */
export function seated(agent: AgentDefinition, options: SeatingOptions = {}): SeatedAgent {
	if (!isAgent(agent)) throw new Error('Agents must come from defineAgent.');
	return {
		[SEAT_BRAND]: true,
		agent,
		attention: options.attention ?? 'broadcast',
	};
}

/**
 * Seat an agent at `named`: it hears nothing but a message addressed to it by
 * name. The expert in the corner, costing nothing until somebody asks.
 */
export function passive(agent: AgentDefinition): SeatedAgent {
	return seated(agent, { attention: 'named' });
}

/**
 * Seat an agent at `presence`: besides everything said, it also wakes when
 * somebody arrives or leaves. Most seats should not — an arrival asks
 * nothing, so a seat that answers one is guessing — but a seat whose job is to
 * meet people needs it.
 */
export function attentive(agent: AgentDefinition): SeatedAgent {
	return seated(agent, { attention: 'presence' });
}

export interface DefineToolOptions<TParameters extends TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	/**
	 * Return a string (or Pi's full content shape when needed). Throw on failure.
	 * `ctx.workspace()` resolves the calling agent's workspace, and `ctx.signal`
	 * is the abort signal Pi gives the tool call.
	 */
	execute: (
		params: Static<TParameters>,
		ctx: ToolContext,
	) => Promise<string | AgentToolResult<unknown>> | string | AgentToolResult<unknown>;
}

/**
 * A facade over Pi's tool shape, and no format of Ambion's own: parsed
 * parameters first, a context second, string returns allowed. A tool defined
 * with Pi's `defineTool` works unchanged wherever this one does, and reaches
 * no workspace: its signature has no room for the context.
 */
export function defineTool<TParameters extends TSchema>(
	options: DefineToolOptions<TParameters>,
): AmbionTool<TParameters> {
	assertToolName(options.name);
	return {
		[TOOL_BRAND]: true,
		name: options.name,
		description: options.description,
		parameters: options.parameters,
		execute: options.execute,
	};
}

/** The room tool that an ordinary message activation holds. */
export const SAY = {
	name: 'say' as const,
	parameters: Type.Object({
		to: Type.Optional(Type.String({ description: 'A participant name from the roster.' })),
		text: Type.String(),
	}),
};

function assertAgentTools(agent: string, tools: readonly unknown[], workspace: boolean): void {
	for (const tool of tools) {
		const name = (tool as { name?: unknown }).name;
		if (typeof name !== 'string') continue;
		const roomTool = name === SAY.name || name === 'seat' || name === 'summarise';
		const workspaceTool = BUILTIN_TOOL_NAMES.has(name);
		if (!roomTool && (!workspaceTool || !workspace)) continue;
		const reason = roomTool
			? 'the room supplies it for an activation'
			: 'a workspace supplies it for an agent that names one';
		throw new Error(
			`Agent '${agent}' brings a tool named '${name}': ${reason}. Give it another name.`,
		);
	}
}

function assertToolName(name: string): void {
	if (!/^[a-z][a-z0-9-]*$/.test(name)) {
		throw new Error(`Invalid tool name '${name}': names are lowercase, alphanumeric plus dashes.`);
	}
}

function assertName(name: string): void {
	if (!/^[a-z][a-z0-9-]*$/.test(name)) {
		throw new Error(
			`Invalid participant name '${name}': names are lowercase, alphanumeric plus dashes.`,
		);
	}
}
