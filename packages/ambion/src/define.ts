import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Static, TSchema } from 'typebox';
import {
	AGENT_BRAND,
	type AgentDefinition,
	type AmbionTool,
	HUMAN_BRAND,
	type HumanDefinition,
	type PassiveSeat,
	SEAT_BRAND,
	TOOL_BRAND,
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
	/** Extra hands, defined with `defineTool` (or Pi's own — both work unchanged). */
	tools?: readonly unknown[];
}

export function defineAgent(options: DefineAgentOptions): AgentDefinition {
	assertName(options.name);
	return {
		[AGENT_BRAND]: true,
		name: options.name,
		identity: options.identity,
		instructions: options.instructions,
		model: options.model,
		tools: options.tools ?? [],
	};
}

export interface DefineHumanOptions {
	name: string;
	/** How the room knows them — agents read it and address them accordingly. */
	identity: string;
}

export function defineHuman(options: DefineHumanOptions): HumanDefinition {
	assertName(options.name);
	return {
		[HUMAN_BRAND]: true,
		name: options.name,
		identity: options.identity,
	};
}

/** Seat an agent passively: at rest, woken only when named. */
export function passive(agent: AgentDefinition): PassiveSeat {
	return { [SEAT_BRAND]: true, agent };
}

export interface DefineToolOptions<TParameters extends TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	/** Return a string (or Pi's full content shape when needed). Throw on failure. */
	execute: (
		params: Static<TParameters>,
		signal?: AbortSignal,
	) => Promise<string | AgentToolResult<unknown>> | string | AgentToolResult<unknown>;
}

/**
 * A facade over Pi's tool shape, not a format of Ambion's own: parsed
 * parameters first, string returns allowed. A tool defined with Pi's
 * `defineTool` works unchanged wherever this one does.
 */
export function defineTool<TParameters extends TSchema>(
	options: DefineToolOptions<TParameters>,
): AmbionTool<TParameters> {
	return {
		[TOOL_BRAND]: true,
		name: options.name,
		description: options.description,
		parameters: options.parameters,
		execute: options.execute,
	};
}

function assertName(name: string): void {
	if (!/^[a-z][a-z0-9-]*$/.test(name)) {
		throw new Error(
			`Invalid participant name '${name}': names are lowercase, alphanumeric plus dashes.`,
		);
	}
}
