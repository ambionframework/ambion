/**
 * The values you write before a room exists.
 *
 * An agent, a person, a tool, and where a seat sits on the attention scale.
 * None of them starts anything or holds any state: a definition is a value,
 * and the same one is the quiet corner in one room and the one who meets
 * people in another. What each refuses is as much of the contract as what it
 * takes — a name the room can address, and a composition of ordinary tools.
 */
import type { AgentToolResult, ToolExecutionMode } from '@earendil-works/pi-agent-core';
import { type Static, type TSchema, Type } from 'typebox';
import {
	type AgentDefinition,
	type AmbionTool,
	type HumanDefinition,
	TOOL_BRAND,
	type ToolBundle,
	type ToolContext,
} from './types.ts';

export interface DefineAgentOptions {
	/** Identifies the agent inside a room and on the record. */
	name: string;
	/** The agent's public face — injected into every participant's context as part of the roster. */
	identity: string;
	/** The private half: the agent's own voice, and the home of all judgment. */
	instructions: string;
	/** A Pi model identifier, `provider/model-id`. */
	model: string;
	/** The agent's own tools or composable bundles of tools and guidance. */
	tools?: readonly unknown[];
}

export function defineAgent(options: DefineAgentOptions): AgentDefinition {
	assertName(options.name);
	const input = options.tools ?? [];
	const guidance =
		input
			.filter(isToolBundle)
			.map((bundle) => bundle.guidance?.trim())
			.filter((text): text is string => Boolean(text))
			.join('\n\n') || undefined;
	const tools = Object.freeze(
		input
			.flatMap((tool) => (isToolBundle(tool) ? tool.tools : [tool]))
			.map((tool) => capture(tool)),
	);
	assertAgentTools(options.name, tools);
	return Object.freeze({
		name: options.name,
		identity: options.identity,
		instructions: options.instructions,
		model: options.model,
		tools,
		...(guidance === undefined ? {} : { guidance }),
	});
}

/** Capture a structural definition at a room boundary without retaining mutable authoring data. */
export function captureAgent(agent: AgentDefinition): AgentDefinition {
	assertName(agent.name);
	const tools = Object.freeze(agent.tools.map((tool) => capture(tool)));
	assertAgentTools(agent.name, tools);
	return Object.freeze({
		name: agent.name,
		identity: agent.identity,
		instructions: agent.instructions,
		model: agent.model,
		tools,
		...(agent.guidance === undefined ? {} : { guidance: agent.guidance }),
	});
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
	return Object.freeze({
		name: options.name,
		identity: options.identity,
		...(preferences === undefined ? {} : { preferences }),
	});
}

export function captureHuman(human: HumanDefinition): HumanDefinition {
	assertName(human.name);
	return Object.freeze({
		name: human.name,
		identity: human.identity,
		...(human.preferences === undefined ? {} : { preferences: human.preferences }),
	});
}

export interface DefineToolOptions<TParameters extends TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	label?: string;
	prepareArguments?: (args: unknown) => Static<TParameters>;
	executionMode?: ToolExecutionMode;
	/**
	 * Return a string (or Pi's full content shape when needed). Throw on failure.
	 * `ctx.agent` identifies the calling agent and `ctx.signal` is the abort
	 * signal Pi gives the tool call.
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
 * no context: its signature has no room for one.
 */
export function defineTool<TParameters extends TSchema>(
	options: DefineToolOptions<TParameters>,
): AmbionTool<TParameters> {
	return Object.freeze({
		[TOOL_BRAND]: true as const,
		name: options.name,
		description: options.description,
		parameters: capture(options.parameters),
		...(options.label === undefined ? {} : { label: options.label }),
		...(options.prepareArguments === undefined
			? {}
			: { prepareArguments: options.prepareArguments }),
		...(options.executionMode === undefined ? {} : { executionMode: options.executionMode }),
		execute: options.execute,
	});
}

/** Copies authoring data while keeping executable and resource values by identity. */
function capture<T>(value: T, seen = new WeakMap<object, unknown>()): T {
	if (typeof value !== 'object' || value === null) return value;
	const prior = seen.get(value);
	if (prior !== undefined) return prior as T;
	const prototype = Object.getPrototypeOf(value);
	if (!copyable(value, prototype)) return value;
	const copy: object = Array.isArray(value) ? [] : Object.create(prototype);
	seen.set(value, copy);
	copyProperties(value, copy, seen);
	return Object.freeze(copy) as T;
}

const copyable = (value: object, prototype: object | null): boolean =>
	Array.isArray(value) || prototype === Object.prototype || prototype === null;

function copyProperties(from: object, to: object, seen: WeakMap<object, unknown>): void {
	for (const key of Reflect.ownKeys(from)) {
		const descriptor = Object.getOwnPropertyDescriptor(from, key);
		if (descriptor === undefined) continue;
		const captured = 'value' in descriptor ? descriptor.value : descriptor.get?.call(from);
		Object.defineProperty(to, key, {
			value: capture(captured, seen),
			writable: false,
			enumerable: descriptor.enumerable,
			configurable: false,
		});
	}
}

/** The room tool that an ordinary message activation holds. */
export const SAY = {
	name: 'say' as const,
	parameters: Type.Object({
		to: Type.Optional(Type.String({ description: 'A participant name from the roster.' })),
		text: Type.String(),
	}),
};

function isToolBundle(value: unknown): value is ToolBundle {
	return typeof value === 'object' && value !== null && Array.isArray((value as ToolBundle).tools);
}

function assertAgentTools(agent: string, tools: readonly unknown[]): void {
	const names = new Set<string>();
	for (const tool of tools) {
		const name = (tool as { name?: unknown }).name;
		if (typeof name !== 'string') continue;
		if (names.has(name)) {
			throw new Error(`Agent '${agent}' brings duplicate tools named '${name}'.`);
		}
		names.add(name);
		const roomTool = name === SAY.name || name === 'seat' || name === 'summarise';
		if (roomTool)
			throw new Error(
				`Agent '${agent}' brings a tool named '${name}': the room supplies it for an activation. Give it another name.`,
			);
	}
}

function assertName(name: string): void {
	if (!/^[a-z][a-z0-9-]*$/.test(name)) {
		throw new Error(
			`Invalid participant name '${name}': names are lowercase, alphanumeric plus dashes.`,
		);
	}
}
