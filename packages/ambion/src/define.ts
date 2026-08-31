import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Static, TSchema } from 'typebox';
import {
	AGENT_BRAND,
	type AgentDefinition,
	type AmbionTool,
	HUMAN_BRAND,
	type HumanDefinition,
	isAgent,
	SEAT_BRAND,
	type SeatedAgent,
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
	/**
	 * The aide this person brings: an agent that holds their brief and their
	 * preferences, and writes the one message they read when an exchange
	 * closes. Optional — a person with no aide is never summarised.
	 */
	aide?: AgentDefinition;
}

export function defineHuman(options: DefineHumanOptions): HumanDefinition {
	assertName(options.name);
	if (options.aide) assertAide(options.aide, options.name);
	return {
		[HUMAN_BRAND]: true,
		name: options.name,
		identity: options.identity,
		...(options.aide === undefined ? {} : { aide: options.aide }),
	};
}

/**
 * An aide shapes what a room already does, and never makes anything happen. It
 * carries no tools of its own, so the rule is a fact about the definition
 * rather than a promise about behaviour: the one hand the runtime gives it
 * writes to the record and reaches nothing else.
 */
function assertAide(aide: AgentDefinition, person: string): void {
	if (!isAgent(aide)) {
		throw new Error(`The aide for '${person}' must come from defineAgent.`);
	}
	if (aide.name === person) {
		throw new Error(`An aide takes a name of its own: '${person}' is the person it holds.`);
	}
	if (aide.tools.length > 0) {
		throw new Error(
			`Aide '${aide.name}' holds tools: an aide shapes what a room does and never acts in it.`,
		);
	}
}

/**
 * Seat an agent at the narrow end of attention: it hears nothing but a message
 * addressed to it by name. The expert in the corner, costing nothing until
 * somebody asks.
 */
export function passive(agent: AgentDefinition): SeatedAgent {
	return { [SEAT_BRAND]: true, agent, attention: 'named' };
}

/**
 * Seat an agent at the wide end: besides everything said, it also wakes when
 * somebody arrives, leaves or goes quiet. Most seats should not — an arrival
 * asks nothing, so a seat that answers one is guessing — but a seat whose job
 * is to meet people needs it.
 */
export function attentive(agent: AgentDefinition): SeatedAgent {
	return { [SEAT_BRAND]: true, agent, attention: 'presence' };
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
