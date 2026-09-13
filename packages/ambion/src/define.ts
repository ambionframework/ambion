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

/**
 * Seat one agent at one point of the attention scale — the widest kind of
 * message that wakes it, and the whole of what a seating chooses. The general
 * form; `passive` and `attentive` are the two points worth a name of their
 * own, and `broadcast` is what a bare agent in `agents` gets.
 *
 * Attention belongs to the seating rather than to the agent, so the same
 * definition is the quiet corner in one room and the one who meets people in
 * another.
 */
export function seated(agent: AgentDefinition, attention: Attention): SeatedAgent {
	if (!isAgent(agent)) throw new Error('Agents must come from defineAgent.');
	return { [SEAT_BRAND]: true, agent, attention };
}

/**
 * Seat an agent at `named`: it hears nothing but a message addressed to it by
 * name. The expert in the corner, costing nothing until somebody asks.
 */
export function passive(agent: AgentDefinition): SeatedAgent {
	return seated(agent, 'named');
}

/**
 * Seat an agent at `presence`: besides everything said, it also wakes when
 * somebody arrives or leaves. Most seats should not — an arrival asks
 * nothing, so a seat that answers one is guessing — but a seat whose job is to
 * meet people needs it.
 */
export function attentive(agent: AgentDefinition): SeatedAgent {
	return seated(agent, 'presence');
}

/**
 * What binding a tool needs to know: what it is called, and what it takes.
 *
 * A shape is the contract, and a description is how one body presents
 * itself. The room binds `summarise` with a description that names the
 * person it writes for, so the description belongs to the body and never to
 * the shape. Two bodies answer one shape when they take the same name and
 * the same parameters.
 */
export interface ToolShape<TParameters extends TSchema = TSchema> {
	name: string;
	parameters: TParameters;
}

/**
 * Write a shape a role names and a body answers. A host that holds the shape
 * hands it to `defineTool`, and the room compares it by reference.
 */
export function defineToolShape<TParameters extends TSchema>(
	shape: ToolShape<TParameters>,
): ToolShape<TParameters> {
	assertToolName(shape.name);
	return { name: shape.name, parameters: shape.parameters };
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
 * A tool that answers a shape somebody else published. The tool keeps the
 * shape it answers, so a reader compares one reference to learn that this
 * body answers that contract.
 */
export interface ShapedToolOptions<TParameters extends TSchema> extends Omit<
	DefineToolOptions<TParameters>,
	'name' | 'parameters'
> {
	shape: ToolShape<TParameters>;
}

/**
 * A facade over Pi's tool shape, and no format of Ambion's own: parsed
 * parameters first, a context second, string returns allowed. A tool defined
 * with Pi's `defineTool` works unchanged wherever this one does, and reaches
 * no workspace: its signature has no room for the context.
 *
 * The options name a shape or state one. A tool that names one answers a
 * contract a role can require.
 */
export function defineTool<TParameters extends TSchema>(
	options: DefineToolOptions<TParameters> | ShapedToolOptions<TParameters>,
): AmbionTool<TParameters> {
	const shape = 'shape' in options ? options.shape : options;
	return {
		[TOOL_BRAND]: true,
		name: shape.name,
		description: options.description,
		parameters: shape.parameters,
		execute: options.execute,
		...('shape' in options ? { shape: options.shape } : {}),
	};
}

// -- the shapes the room binds ------------------------------------------------

/**
 * What a seat holds to speak on the record. Every seat that speaks holds it.
 */
export const SAY = defineToolShape({
	name: 'say',
	parameters: Type.Object({
		to: Type.Optional(Type.String({ description: 'A participant name from the roster.' })),
		text: Type.String(),
	}),
});

/**
 * What a seat holds to write the one message a person reads. A closed
 * exchange binds it, over the range it stands for.
 */
export const SUMMARISE = defineToolShape({
	name: 'summarise',
	parameters: Type.Object({ text: Type.String() }),
});

/**
 * What a seat holds to seat one agent from the reserve. An opened exchange
 * binds it, over the reserve it may seat from.
 */
export const SEAT = defineToolShape({
	name: 'seat',
	parameters: Type.Object({
		name: Type.String({ description: 'An agent name from the reserve.' }),
	}),
});

// -- who binds a tool of this name --------------------------------------------

/**
 * Who answers a tool of this name. A role names a tool, and the name says
 * which binder brings the body: the room binds its own three, a workspace
 * binds the four it gives every agent that names one, and an agent brings
 * every other.
 */
export type Binder = 'room' | 'workspace' | 'agent';

/** The names the room binds. A seat holds one of them where its view names it. */
const ROOM_TOOL_NAMES: ReadonlySet<string> = new Set([SAY.name, SUMMARISE.name, SEAT.name]);

/** Which binder answers a tool of this name. */
export function binderOf(name: string): Binder {
	if (ROOM_TOOL_NAMES.has(name)) return 'room';
	if (BUILTIN_TOOL_NAMES.has(name)) return 'workspace';
	return 'agent';
}

/** What a binder other than the agent does with the name it claims. */
const CLAIMS: Readonly<Record<Exclude<Binder, 'agent'>, string>> = {
	room: 'the room binds it into every activation that speaks',
	workspace: 'it is a built-in tool a workspace binds',
};

/**
 * An agent brings the tools no other binder claims.
 *
 * The room binds its three into every activation that holds one. An agent
 * that brings one of those names reaches a model with two tools under that
 * name, so the room's three stay free for every agent.
 *
 * A workspace binds its four for an agent that names one. An agent that
 * names no workspace binds none of the four, so it may take those names.
 */
function assertAgentTools(agent: string, tools: readonly unknown[], workspace: boolean): void {
	for (const tool of tools) {
		const name = (tool as { name?: unknown }).name;
		if (typeof name !== 'string') continue;
		const binder = binderOf(name);
		if (binder === 'agent') continue;
		if (binder === 'workspace' && !workspace) continue;
		throw new Error(
			`Agent '${agent}' brings a tool named '${name}': ${CLAIMS[binder]}. ` +
				'Give it another name.',
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
