/**
 * The room tools bound to one activation, and the agent's own tools, as one
 * in-process MCP server for the Claude Agent SDK.
 *
 * Every ordinary activation can speak, seat an agent, or remove an agent.
 * A closing activation receives only `say`; the room turns that said intent
 * into the assigned summary and supplies its recipient and range.
 *
 * The SDK builds an MCP tool from a Zod shape. The three room schemas and
 * the schemas of the agent's tools are TypeBox values, which are JSON
 * Schema, so `shapeOf` reads each property through `z.fromJSONSchema`.
 */
import type { AmbionTool, Message, ToolResult } from '@ambionframework/ambion';
import type {
	ActivationView,
	AgentDefinition,
	CommitResult,
	Intent,
	RoomProtocol,
	Seq,
} from '@ambionframework/ambion/hosting';
import {
	classifyCommit,
	refusal,
	SAY,
	SEAT,
	summaryToolDescription,
	UNSEAT,
} from '@ambionframework/ambion/hosting';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { TSchema } from 'typebox';
import { z } from 'zod';
import { ROOM_SERVER } from './claude-trace.ts';

/** What an MCP tool hands back to the model. */
interface Result {
	[key: string]: unknown;
	content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
	isError?: boolean;
}

/** What every room tool reaches: the activation and the room. */
export interface Binding {
	readonly id: string;
	readonly room: RoomProtocol;
	readonly readThrough: Seq;
	/** Aborts when the activation is cut. */
	readonly signal: AbortSignal;
	/** An accepted ordinary say confirms the activation read the record through here. */
	acknowledgeThrough(seq: Seq): void;
	/** The result of this call places the record through `seq` in the model's input. */
	resultExpected(call: string, seq: Seq): void;
	/** The id the model gave this call. A call the stream did not name gets a fresh id. */
	callId(tool: string): string;
	abort(): void;
}

const text = (value: string, isError = false): Result => ({
	content: [{ type: 'text', text: value }],
	...(isError ? { isError } : {}),
});

/** The Zod shape of a TypeBox object schema: one field for each property. */
function shapeOf(schema: TSchema): Record<string, z.ZodType> {
	const { properties = {}, required = [] } = schema as {
		properties?: Record<string, unknown>;
		required?: string[];
	};
	const shape: Record<string, z.ZodType> = {};
	for (const [name, property] of Object.entries(properties)) {
		const field = z.fromJSONSchema(property as Parameters<typeof z.fromJSONSchema>[0]);
		shape[name] = required.includes(name) ? field : field.optional();
	}
	return shape;
}

/** What the model reads for a commit the room answered. */
function landed(binding: Binding, response: CommitResult): Result {
	const outcome = classifyCommit(response);
	if (outcome.kind === 'delivered') return text('delivered');
	if (outcome.kind === 'refused') return text(outcome.why, true);
	if (outcome.kind === 'unknown') {
		// The message may already be on the record, so the activation ends here. A
		// second say under a new key would land the same message twice.
		binding.abort();
		return text(
			'The room did not confirm your message, and it may already hold it. This turn is over.',
			true,
		);
	}
	binding.abort();
	const why = outcome.kind === 'ended' ? outcome.why : 'the room moved';
	return text(`Your turn ended: ${why}. This turn is over.`, true);
}

/** A closing activation: its owner, everyone it addresses, and how many it has answered. */
interface Closing {
	readonly person: string;
	readonly people: readonly string[];
	answered: number;
}

/** The intent a say stands for: its text and refs trimmed, and no empty field. */
function saidBy(args: { to?: string; text: string; refs?: string[] }): Intent {
	const to = args.to?.trim();
	const refs = (args.refs ?? []).map((ref) => ref.trim()).filter((ref) => ref.length > 0);
	return {
		kind: 'said',
		...(to ? { to } : {}),
		text: args.text.trim(),
		...(refs.length > 0 ? { refs } : {}),
	};
}

async function say(
	binding: Binding,
	args: { to?: string; text: string; refs?: string[] },
	closing?: Closing,
): Promise<Result> {
	const call = binding.callId(SAY.name);
	const response = await binding.room.commit({
		activation: binding.id,
		key: call,
		...(closing === undefined ? { readThrough: binding.readThrough } : {}),
		intent: saidBy(args),
	});
	if ('missed' in response) return missedSay(binding, call, response.missed, closing);
	if ('committed' in response) accepted(binding, response.committed, closing);
	return landed(binding, response);
}

/** A say the room took. An ordinary say confirms the read position. A closing say counts as an answer. */
function accepted(binding: Binding, message: Message, closing: Closing | undefined): void {
	if (closing !== undefined) {
		closing.answered += 1;
	} else if (message.kind === 'said') {
		binding.acknowledgeThrough(message.seq);
	}
}

function missedSay(
	binding: Binding,
	call: string,
	missed: readonly Message[],
	closing: Closing | undefined,
): Result {
	if (closing === undefined) {
		binding.resultExpected(call, missed.at(-1)?.seq ?? binding.readThrough);
	}
	return text(
		refusal(
			'Not delivered — the room moved while you were speaking. New on the record:',
			[...missed],
			'Speak again only if your reply still adds something the room has not heard; otherwise end your turn.',
		),
		true,
	);
}

/** The tool that speaks for an ordinary activation or publishes its close. */
function sayTool(binding: Binding, closing?: Closing): SdkMcpToolDefinition {
	const description =
		closing === undefined
			? SAY.description
			: summaryToolDescription(closing.person, closing.people);
	return tool(SAY.name, description, shapeOf(SAY.parameters), (args) =>
		say(binding, args as { to?: string; text: string; refs?: string[] }, closing),
	);
}

/** The tool that seats or removes one agent. */
function membershipTool(binding: Binding, kind: 'seated' | 'unseated'): SdkMcpToolDefinition {
	const spec = kind === 'seated' ? SEAT : UNSEAT;
	return tool(spec.name, spec.description, shapeOf(spec.parameters), async (args) => {
		const name = (args as { name: string }).name.trim();
		const response = await binding.room.commit({
			activation: binding.id,
			key: binding.callId(spec.name),
			intent: { kind, name },
		});
		return landed(binding, response);
	});
}

/** What a domain tool returned, as the model reads it. */
function resultOf(value: string | ToolResult): Result {
	if (typeof value === 'string') return text(value);
	return { content: value.content.map((part) => ({ ...part })) };
}

/**
 * An MCP tool from a normalized tool. The tool reads the view of the pass
 * that runs it, so the room and the open exchange it names are current.
 * A tool that throws gives the model its message as an error result.
 */
function domainTool(
	one: AmbionTool,
	agent: AgentDefinition,
	binding: Binding,
	current: () => ActivationView,
): SdkMcpToolDefinition {
	return tool(one.name, one.description, shapeOf(one.parameters), async (args) => {
		const view = current();
		const exchange = view.context.exchange;
		try {
			const params = one.prepareArguments === undefined ? args : one.prepareArguments(args);
			const value = await one.invoke(
				params,
				Object.freeze({
					agent: { name: agent.name, identity: agent.identity },
					signal: binding.signal,
					callId: binding.callId(one.name),
					room: view.context.name,
					activation: view.spec.id,
					...(exchange === undefined
						? {}
						: { exchange: Object.freeze({ owner: exchange.owner, from: exchange.from }) }),
				}),
			);
			return resultOf(value);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), true);
		}
	});
}

/** The tools an activation holds, by its purpose. */
function toolsFor(
	view: ActivationView,
	agent: AgentDefinition,
	binding: Binding,
	current: () => ActivationView,
): SdkMcpToolDefinition[] {
	const { purpose } = view.spec;
	if (purpose.kind === 'summarize') {
		return [sayTool(binding, { person: purpose.person, people: purpose.people, answered: 0 })];
	}
	return [
		sayTool(binding),
		membershipTool(binding, 'seated'),
		membershipTool(binding, 'unseated'),
		...agent.executor.tools.map((one) => domainTool(one, agent, binding, current)),
	];
}

/** The in-process server for one activation, and the names of its tools as the SDK knows them. */
export function roomServer(
	view: ActivationView,
	agent: AgentDefinition,
	binding: Binding,
	current: () => ActivationView = () => view,
) {
	const tools = toolsFor(view, agent, binding, current);
	return {
		server: createSdkMcpServer({ name: ROOM_SERVER, tools }),
		names: tools.map((one) => `mcp__${ROOM_SERVER}__${one.name}`),
	};
}
